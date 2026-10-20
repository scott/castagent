import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  canonicalRequirementName,
  compareVersions,
  FALLBACK_REQUIREMENTS,
  filterRequirementLines,
  findRequirementsProjectRoot,
  GITPYTHON_REQUIREMENT,
  parsePyprojectDependencies,
  parseRuntimeRequirements,
  readFrozenRequirements,
  renderRequirementsFile,
  requirementLowerBound,
  stagePythonRequirements,
  upsertRequirement,
  writeRequirementsTxt,
} from '../../../../typescript/cast-cli/src/lib/deploy/requirements'

const REPO_PYPROJECT = path.resolve(__dirname, '../../../../python/pyproject.toml')

describe('Docker image requirements', () => {
  it('reads GitPython from the repo pyproject.toml project dependencies', () => {
    const source = fs.readFileSync(REPO_PYPROJECT, 'utf8')
    const deps = parsePyprojectDependencies(source)
    expect(deps).to.include('GitPython>=3.2.1')
    expect(deps.join('\n')).to.not.match(/pytest/)
  })

  it('ignores optional dependency tables', () => {
    const source = `
[project]
name = "cast"
dependencies = [
  "GitPython>=3.1.0",
  'requests>=2',
]

[project.optional-dependencies]
test = [
  "pytest>=7.0",
]
`
    expect(parsePyprojectDependencies(source)).to.deep.equal(['GitPython>=3.1.0', 'requests>=2'])
  })

  it('reads runtime.requirements from agent.yaml', () => {
    const yaml = `
name: bb2-chat
runtime:
  python_version: "3.11"
  requirements:
    - GitPython
    - httpx>=0.28.1
`
    expect(parseRuntimeRequirements(yaml)).to.deep.equal(['GitPython', 'httpx>=0.28.1'])
  })

  it('returns no runtime requirements when the field is missing or invalid', () => {
    expect(parseRuntimeRequirements('name: demo\n')).to.deep.equal([])
    expect(parseRuntimeRequirements('runtime: [')).to.deep.equal([])
    expect(parseRuntimeRequirements('')).to.deep.equal([])
  })

  it('adds GitPython from pyproject when the fallback list omits it', () => {
    const rendered = renderRequirementsFile({
      frozen: '',
      pyprojectSource: '[project]\ndependencies = ["GitPython>=3.1.0"]\n',
      agentYaml: 'runtime:\n  requirements: []\n',
    })
    const names = rendered.trim().split('\n').map(canonicalRequirementName)
    expect(names.filter(name => name === 'gitpython')).to.deep.equal(['gitpython'])
    expect(rendered).to.include('GitPython>=3.1.0')
    expect(rendered).to.include('langchain>=1.2.15')
  })

  it('adds GitPython when pip freeze omitted it', () => {
    const rendered = renderRequirementsFile({
      frozen: 'requests==2.32.0\nPyYAML==6.0.1\n',
      pyprojectSource: fs.readFileSync(REPO_PYPROJECT, 'utf8'),
    })
    expect(rendered).to.include('requests==2.32.0')
    expect(rendered).to.include('GitPython>=3.2.1')
    expect(rendered).to.include('PyYAML>=6.0.3')
    expect(rendered).to.not.include('PyYAML==6.0.1')
    expect(rendered).to.not.include('langchain>=1.2.15')
  })

  it('adds runtime.requirements and does not duplicate GitPython', () => {
    const rendered = renderRequirementsFile({
      frozen: 'requests==2.32.0\n',
      pyprojectSource: '[project]\ndependencies = ["GitPython>=3.1.0"]\n',
      agentYaml: 'runtime:\n  requirements:\n    - GitPython\n    - coolname>=1\n',
    })
    const gitLines = rendered.trim().split('\n').filter(line => canonicalRequirementName(line) === 'gitpython')
    expect(gitLines).to.deep.equal(['GitPython>=3.1.0'])
    expect(rendered).to.include('coolname>=1')
  })

  it('keeps a versioned runtime requirement over a bare name', () => {
    const lines = ['GitPython']
    upsertRequirement(lines, 'GitPython>=3.1.0')
    expect(lines).to.deep.equal(['GitPython>=3.1.0'])
    upsertRequirement(lines, 'GitPython')
    expect(lines).to.deep.equal(['GitPython>=3.1.0'])
  })

  it('drops the cast package and castagent references', () => {
    const lines = filterRequirementLines(`
requests==2.32.0
cast==2.5.1
-e git+https://github.com/scott/castagent.git@main#egg=cast
GitPython==3.1.45
`)
    expect(lines).to.deep.equal(['requests==2.32.0', 'GitPython==3.1.45'])
  })

  it('still installs GitPython when pyproject and the freeze both omit it', () => {
    const rendered = renderRequirementsFile({frozen: 'requests==2.32.0\n'})
    expect(rendered).to.include(GITPYTHON_REQUIREMENT)
  })

  it('writes requirements.txt with pyproject and runtime requirements', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-root-'))
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-agent-'))
    try {
      fs.mkdirSync(path.join(root, 'python'))
      fs.writeFileSync(path.join(root, 'python', 'pyproject.toml'), `
[project]
dependencies = [
  "GitPython>=3.1.0",
]
`)
      fs.writeFileSync(path.join(agent, 'agent.yaml'), `
runtime:
  requirements:
    - coolname>=1
    - GitPython
`)
      writeRequirementsTxt(root, agent)
      const written = fs.readFileSync(path.join(agent, 'requirements.txt'), 'utf8')
      expect(written).to.include('GitPython>=3.1.0')
      expect(written).to.include('coolname>=1')
      expect(written.trim().split('\n').filter(line => canonicalRequirementName(line) === 'gitpython')).to.have.length(1)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(agent, {recursive: true, force: true})
    }
  })

  it('freezes with the venv python and does not run the pip script', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-root-'))
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-agent-'))
    const marker = path.join(root, 'pip-was-called')
    try {
      const bin = path.join(root, 'python', '.venv', 'bin')
      fs.mkdirSync(bin, {recursive: true})
      fs.writeFileSync(path.join(bin, 'python'), `#!/bin/sh
if [ "$1" = "-m" ] && [ "$2" = "pip" ] && [ "$3" = "freeze" ]; then
  printf '%s\\n' 'requests==9.9.9'
  exit 0
fi
exit 1
`)
      fs.chmodSync(path.join(bin, 'python'), 0o755)
      fs.writeFileSync(path.join(bin, 'pip'), `#!/bin/sh
touch '${marker}'
exit 1
`)
      fs.chmodSync(path.join(bin, 'pip'), 0o755)
      fs.writeFileSync(path.join(root, 'python', 'pyproject.toml'), '[project]\ndependencies = ["GitPython>=3.1.0"]\n')
      writeRequirementsTxt(root, agent)
      const written = fs.readFileSync(path.join(agent, 'requirements.txt'), 'utf8')
      expect(written).to.include('requests==9.9.9')
      expect(fs.existsSync(marker)).to.equal(false)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(agent, {recursive: true, force: true})
    }
  })

  it('compares numeric versions so 1.10 is newer than 1.9', () => {
    expect(compareVersions('1.10.0', '1.9.0')).to.be.greaterThan(0)
    expect(compareVersions('1.2', '1.2.0')).to.equal(0)
    expect(compareVersions('6.0.1', '6.0.3')).to.be.lessThan(0)
    expect(requirementLowerBound('PyYAML==6.0.1')).to.equal('6.0.1')
    expect(requirementLowerBound('langgraph>=1.2.16')).to.equal('1.2.16')
    expect(requirementLowerBound('requests')).to.equal(null)
  })

  it('sorts a pre-release or dev pin below the final release', () => {
    expect(compareVersions('1.2.16rc1', '1.2.16')).to.be.lessThan(0)
    expect(compareVersions('1.2.16.dev3', '1.2.16')).to.be.lessThan(0)
    expect(compareVersions('1.2.16', '1.2.16rc1')).to.be.greaterThan(0)
    expect(compareVersions('1.2.16', '1.2.16.dev3')).to.be.greaterThan(0)
    expect(compareVersions('1.2.16rc1', '1.2.16rc1')).to.equal(0)
    expect(compareVersions('1.2.16.dev3', '1.2.16rc1')).to.be.lessThan(0)
    expect(compareVersions('1.2.16rc1', '1.2.16rc2')).to.be.lessThan(0)
    expect(compareVersions('1.2.17.dev1', '1.2.16')).to.be.greaterThan(0)
    expect(requirementLowerBound('langgraph==1.2.16rc1')).to.equal('1.2.16rc1')
    expect(requirementLowerBound('PyYAML==6.0.3.dev1')).to.equal('6.0.3.dev1')

    const rendered = renderRequirementsFile({
      frozen: 'langgraph==1.2.16rc1\nPyYAML==6.0.3.dev1\n',
      pyprojectSource: '[project]\ndependencies = ["langgraph>=1.2.16", "PyYAML>=6.0.3"]\n',
    })
    expect(rendered).to.include('langgraph>=1.2.16')
    expect(rendered).to.not.include('langgraph==1.2.16rc1')
    expect(rendered).to.include('PyYAML>=6.0.3')
    expect(rendered).to.not.include('PyYAML==6.0.3.dev1')
  })

  it('meets every pyproject minimum in the fallback list itself', () => {
    const source = fs.readFileSync(REPO_PYPROJECT, 'utf8')
    const declared = parsePyprojectDependencies(source)
    const fallbackLines = FALLBACK_REQUIREMENTS.split('\n').map(line => line.trim()).filter(Boolean)
    for (const dep of declared) {
      const name = canonicalRequirementName(dep)
      const line = name === 'gitpython'
        ? GITPYTHON_REQUIREMENT
        : fallbackLines.find(item => canonicalRequirementName(item) === name)
      expect(line, `${name} missing from the fallback list`).to.be.a('string')
      expect(line, name).to.equal(dep)
      expect(floorAtLeast(line as string, dep), `${line} is below ${dep}`).to.equal(true)
    }
    expect(FALLBACK_REQUIREMENTS).to.include('langchain-core>=1.6.12')
    expect(FALLBACK_REQUIREMENTS).to.include('langchain-openai>=1.7.2')
    expect(FALLBACK_REQUIREMENTS).to.include('langgraph>=1.2.16')
    expect(FALLBACK_REQUIREMENTS).to.include('PyYAML>=6.0.3')
    expect(FALLBACK_REQUIREMENTS).to.include('starlette>=1.9.0')
    expect(FALLBACK_REQUIREMENTS).to.include('uvicorn>=0.54.0')
    expect(FALLBACK_REQUIREMENTS).to.include('typing-extensions>=4.16.0')
    expect(FALLBACK_REQUIREMENTS).to.not.include('langchain-core>=1.3.2')
    expect(FALLBACK_REQUIREMENTS).to.not.include('langchain-openai>=1.2.1')
    expect(FALLBACK_REQUIREMENTS).to.not.include('langgraph>=1.1.10')
    expect(FALLBACK_REQUIREMENTS).to.not.include('PyYAML>=6.0.1')
    expect(FALLBACK_REQUIREMENTS).to.not.include('starlette>=1.0.0')
    expect(FALLBACK_REQUIREMENTS).to.not.include('uvicorn>=0.46.0')
  })

  it('keeps the higher minimum when fallback, pyproject, and runtime.requirements overlap', () => {
    const rendered = renderRequirementsFile({
      frozen: '',
      pyprojectSource: `
[project]
dependencies = [
  "langgraph>=1.2.16",
  "PyYAML>=6.0.3",
  "coolname>=1",
]
`,
      agentYaml: `
runtime:
  requirements:
    - langgraph>=1.0.0
    - coolname>=2
    - requests
`,
    })
    expect(rendered).to.include('langgraph>=1.2.16')
    expect(rendered).to.not.include('langgraph>=1.1.10')
    expect(rendered).to.not.include('langgraph>=1.0.0')
    expect(rendered).to.include('PyYAML>=6.0.3')
    expect(rendered).to.not.include('PyYAML>=6.0.1')
    expect(rendered).to.include('coolname>=2')
    expect(rendered).to.not.include('coolname>=1')
    expect(rendered).to.include('requests>=2.33.1')
  })

  it('raises a frozen pin below the declared minimum and keeps a pin that meets it', () => {
    const rendered = renderRequirementsFile({
      frozen: 'PyYAML==6.0.1\nlanggraph==1.2.16\nrequests==9.9.9\n',
      pyprojectSource: '[project]\ndependencies = ["PyYAML>=6.0.3", "langgraph>=1.2.16"]\n',
    })
    expect(rendered).to.include('PyYAML>=6.0.3')
    expect(rendered).to.not.include('PyYAML==6.0.1')
    expect(rendered).to.include('langgraph==1.2.16')
    expect(rendered).to.include('requests==9.9.9')
    expect(rendered).to.not.include('langchain>=1.2.15')
  })

  it('meets every pyproject minimum when the venv cannot be frozen', () => {
    const source = fs.readFileSync(REPO_PYPROJECT, 'utf8')
    const declared = parsePyprojectDependencies(source)
    const names = declared.map(canonicalRequirementName)
    for (const name of [
      'langgraph',
      'langchain-core',
      'langchain-openai',
      'pyyaml',
      'starlette',
      'uvicorn',
      'typing-extensions',
      'gitpython',
    ]) {
      expect(names).to.include(name)
    }
    const root = findRequirementsProjectRoot()
    for (const frozen of ['', readFrozenRequirements(root)]) {
      const rendered = renderRequirementsFile({frozen, pyprojectSource: source})
      const lines = rendered.trim().split('\n')
      for (const dep of declared) {
        const line = lines.find(item => canonicalRequirementName(item) === canonicalRequirementName(dep))
        expect(line, dep).to.be.a('string')
        expect(floorAtLeast(line as string, dep), `${line} for ${dep}`).to.equal(true)
      }
    }
    const fallbackOnly = renderRequirementsFile({frozen: '', pyprojectSource: source})
    expect(fallbackOnly).to.include('langgraph>=1.2.16')
    expect(fallbackOnly).to.include('langchain-core>=1.6.12')
    expect(fallbackOnly).to.include('langchain-openai>=1.7.2')
    expect(fallbackOnly).to.include('PyYAML>=6.0.3')
    expect(fallbackOnly).to.include('starlette>=1.9.0')
    expect(fallbackOnly).to.include('uvicorn>=0.54.0')
    expect(fallbackOnly).to.include('typing-extensions>=4.16.0')
    expect(fallbackOnly).to.not.include('langgraph>=1.1.10')
    expect(fallbackOnly).to.not.include('langchain-core>=1.3.2')
    expect(fallbackOnly).to.not.include('PyYAML>=6.0.1')
  })

  it('writes the shared requirements file from the checkout declaration', () => {
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-stage-'))
    try {
      fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: demo\n')
      const root = findRequirementsProjectRoot()
      const written = stagePythonRequirements(agent)
      const expected = renderRequirementsFile({
        frozen: readFrozenRequirements(root),
        pyprojectSource: fs.readFileSync(path.join(root, 'python', 'pyproject.toml'), 'utf8'),
        agentYaml: 'name: demo\n',
      })
      expect(written).to.equal(expected)
      expect(fs.readFileSync(path.join(agent, 'requirements.txt'), 'utf8')).to.equal(expected)
    } finally {
      fs.rmSync(agent, {recursive: true, force: true})
    }
  })

  it('does not keep a second dependency list in provider code', () => {
    const root = path.resolve(__dirname, '../../../../typescript/cast-cli/src')
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.name.endsWith('.ts')) files.push(full)
      }
    }
    walk(path.join(root, 'lib', 'deploy'))
    walk(path.join(root, 'commands'))
    const pattern = /^(?:langchain|langchain-core|langchain-openai|langgraph|PyYAML|pyyaml|starlette|uvicorn|typing-extensions|GitPython)>=/m
    const offenders: string[] = []
    for (const file of files) {
      if (file.endsWith(`${path.sep}requirements.ts`)) continue
      if (pattern.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(root, file))
    }
    expect(offenders).to.deep.equal([])

    const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8')
    const railway = read('lib/deploy/railway.ts')
    const upgrades = read('lib/deploy/upgrades.ts')
    const deploy = read('commands/deploy.ts')
    expect(railway).to.include('stagePythonRequirements')
    expect(deploy).to.include('stagePythonRequirements(agentPath)')
    expect(read('lib/deploy/docker.ts')).to.include('writeRequirementsTxt')
    expect(read('lib/deploy/sprites.ts')).to.include('writeRequirementsTxt')
    expect(read('lib/deploy/fly.ts')).to.include('stageCastRuntime')
    expect(read('lib/deploy/digitalocean.ts')).to.include('prepareCastImageContext')
    expect(read('lib/deploy/microvm.ts')).to.include('prepareCastImageContext')
    expect(functionBody(upgrades, 'upgradeRailwayDeployment')).to.include('stagePythonRequirements')
    expect(functionBody(upgrades, 'upgradeDigitalOceanDeployment')).to.include('stageCastRuntime')
    expect(functionBody(upgrades, 'upgradeFlyDeployment')).to.include('stageCastRuntime')
    expect(functionBody(upgrades, 'upgradeDockerDeployment')).to.include('createRequirementsTxt')
  })
})

/** Independent of requirementLowerBound, so a broken parser cannot hide a low floor. */
function specFloor(spec: string): {nums: number[]; belowFinal: boolean} | null {
  const match = spec.match(/(?:==|>=|~=)\s*v?(\d+(?:\.\d+)*)([^,;<\s]*)/)
  if (!match) return null
  const suffix = match[2]
  const belowFinal = /(?:^|[-_.])(?:a|alpha|b|beta|rc|c|pre|preview|dev)\d*/i.test(suffix)
  return {
    nums: match[1].split('.').map(part => Number(part)),
    belowFinal,
  }
}

function floorAtLeast(actual: string, declared: string): boolean {
  const got = specFloor(actual)
  const want = specFloor(declared)
  if (!want) return true
  if (!got) return false
  const length = Math.max(got.nums.length, want.nums.length)
  for (let i = 0; i < length; i++) {
    const left = got.nums[i] ?? 0
    const right = want.nums[i] ?? 0
    if (left !== right) return left > right
  }
  if (got.belowFinal && !want.belowFinal) return false
  return true
}

function functionBody(source: string, name: string): string {
  const start = source.indexOf(`export async function ${name}`)
  if (start < 0) return ''
  const next = source.indexOf('\nexport ', start + 1)
  return source.slice(start, next === -1 ? source.length : next)
}
