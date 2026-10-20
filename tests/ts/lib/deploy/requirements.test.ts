import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  beginRequirementWarnings,
  canonicalRequirementName,
  compareVersions,
  FALLBACK_REQUIREMENTS,
  filterRequirementLines,
  findRequirementsProjectRoot,
  GITPYTHON_REQUIREMENT,
  maskUrlUserinfo,
  parsePyprojectDependencies,
  parseRuntimeRequirements,
  readFrozenRequirements,
  renderRequirementsFile,
  RequirementError,
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

describe('runtime requirement lines', () => {
  function named(text: string, name: string): string[] {
    return text.trim().split('\n').filter(line => canonicalRequirementName(line) === canonicalRequirementName(name))
  }

  function renderAgent(requirements: string[], options?: {frozen?: string; pyprojectSource?: string}): {text: string; warnings: string[]} {
    const warnings: string[] = []
    const agentYaml = `runtime:\n  requirements:\n${requirements.map(item => `    - ${JSON.stringify(item)}`).join('\n')}\n`
    const text = renderRequirementsFile({
      frozen: options?.frozen ?? '',
      pyprojectSource: options?.pyprojectSource ?? '[project]\ndependencies = []\n',
      agentYaml,
      warn: message => warnings.push(message),
    })
    return {text, warnings}
  }

  it('raises a lower bound and keeps extras', () => {
    const {text, warnings} = renderAgent(['uvicorn[standard]>=0.30'])
    expect(named(text, 'uvicorn')).to.deep.equal(['uvicorn[standard]>=0.54.0'])
    expect(text).to.not.include('uvicorn>=0.54.0\n')
    expect(warnings).to.deep.equal([])
  })

  it('keeps a compatible upper bound while raising the lower bound', () => {
    const {text, warnings} = renderAgent(['uvicorn>=0.30,<1.0'])
    expect(named(text, 'uvicorn')).to.deep.equal(['uvicorn>=0.54.0,<1.0'])
    expect(warnings).to.deep.equal([])
  })

  it('fails when an upper bound cannot meet the floor', () => {
    const line = 'uvicorn>=0.30,<0.50'
    expect(() => renderAgent([line])).to.throw(RequirementError, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    try {
      renderAgent([line])
      expect.fail('deploy should fail')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include('uvicorn')
      expect(message).to.include(line)
      expect(message).to.include('uvicorn>=0.54.0')
      expect(message).to.include('Raise the pin or upper bound')
      expect(message).to.not.match(/conflict/i)
    }
    const marked = 'uvicorn>=0.30,<0.50; python_version>="3.9"'
    expect(() => renderAgent([marked])).to.throw(RequirementError, /uvicorn>=0\.30,<0\.50/)
  })

  it('fails when an exact pin cannot meet the floor', () => {
    const line = 'requests==2.31.0'
    try {
      renderAgent([line])
      expect.fail('deploy should fail')
    } catch (error) {
      expect(error).to.be.instanceOf(RequirementError)
      const message = error instanceof Error ? error.message : ''
      expect(message).to.include('requests')
      expect(message).to.include(line)
      expect(message).to.include('requests>=2.33.1')
      expect(message).to.include('runtime.requirements')
    }
  })

  it('keeps an exact pin that meets the floor', () => {
    const {text, warnings} = renderAgent(['requests==2.33.1'])
    expect(named(text, 'requests')).to.deep.equal(['requests==2.33.1'])
    expect(warnings).to.deep.equal([])
  })

  it('keeps a direct URL or VCS reference', () => {
    const line = 'langgraph @ git+https://github.com/example/langgraph.git@main'
    const {text, warnings} = renderAgent([line])
    expect(named(text, 'langgraph')).to.deep.equal([line])
    expect(text).to.not.include('langgraph>=1.2.16')
    expect(warnings).to.have.length(1)
    expect(warnings[0]).to.include(line)
  })

  it('strips hash options and keeps the floor when the line has no version', () => {
    const met = renderAgent(['requests==2.33.1 --hash=sha256:abc123', 'PyYAML==6.0.3 --hash=sha256:def456'])
    expect(named(met.text, 'requests')).to.deep.equal(['requests==2.33.1'])
    expect(named(met.text, 'PyYAML')).to.deep.equal(['PyYAML==6.0.3'])
    expect(met.text).to.not.include('--hash')
    expect(met.warnings).to.deep.equal([
      'Warning: --hash options are not supported in deploy requirements and were removed.',
    ])

    const bare = renderAgent(['requests --hash=sha256:abc123'])
    expect(named(bare.text, 'requests')).to.deep.equal(['requests>=2.33.1'])
    expect(bare.text).to.not.include('--hash')
    expect(bare.warnings).to.deep.equal([
      'Warning: --hash options are not supported in deploy requirements and were removed.',
    ])

    const spaced = renderAgent(['uvicorn[standard] --hash sha256:abc123'])
    expect(named(spaced.text, 'uvicorn')).to.deep.equal(['uvicorn[standard]>=0.54.0'])
    expect(spaced.text).to.not.include('--hash')
    expect(spaced.warnings).to.have.length(1)

    expect(() => renderAgent(['requests==2.31.0 --hash=sha256:abc123'])).to.throw(RequirementError, /requests==2\.31\.0/)
  })

  it('keeps a marker line and the unconditional floor', () => {
    const line = 'langgraph>=1.3; python_version<"3.9"'
    const {text, warnings} = renderAgent([line])
    expect(named(text, 'langgraph')).to.deep.equal(['langgraph>=1.2.16', line])
    expect(warnings).to.deep.equal([])
  })

  it('does not read an unquoted marker version as the package floor', () => {
    expect(requirementLowerBound('langgraph; python_version>=3.9')).to.equal(null)
    expect(requirementLowerBound('langgraph>=1.2; python_version>=3.9')).to.equal('1.2')
    expect(requirementLowerBound('langgraph>=1.2; python_version>="3.9"')).to.equal('1.2')

    const line = 'langgraph; python_version>=3.9'
    const {text, warnings} = renderAgent([line])
    expect(named(text, 'langgraph')).to.deep.equal(['langgraph>=1.2.16', line])
    expect(text).to.not.include('langgraph>=3.9')
    expect(warnings).to.deep.equal([])
  })

  it('matches package names with PEP 503 normalization', () => {
    expect(canonicalRequirementName('PyYAML>=6')).to.equal('pyyaml')
    expect(canonicalRequirementName('pyyaml==1')).to.equal('pyyaml')
    expect(canonicalRequirementName('PYYAML')).to.equal('pyyaml')
    expect(canonicalRequirementName('foo--bar>=1')).to.equal('foo-bar')
    expect(canonicalRequirementName('foo.bar==1')).to.equal('foo-bar')
    expect(canonicalRequirementName('foo_bar')).to.equal('foo-bar')
    expect(canonicalRequirementName('foo_._bar')).to.equal('foo-bar')
    expect(canonicalRequirementName('typing_extensions>=4')).to.equal('typing-extensions')
    expect(canonicalRequirementName('Requests_Toolbelt')).to.equal('requests-toolbelt')

    const lowered = renderAgent(['pyyaml>=6.0.1', 'typing_extensions>=4'])
    expect(named(lowered.text, 'PyYAML')).to.deep.equal(['PyYAML>=6.0.3'])
    expect(named(lowered.text, 'typing-extensions')).to.deep.equal(['typing-extensions>=4.16.0'])
    expect(lowered.warnings).to.deep.equal([])

    const merged = renderAgent(['foo--bar>=1'], {
      pyprojectSource: '[project]\ndependencies = ["foo.bar>=2"]\n',
    })
    expect(named(merged.text, 'foo.bar')).to.deep.equal(['foo.bar>=2'])
  })

  it('sorts the implicit post-release 1.2.16-1 above 1.2.16', () => {
    expect(compareVersions('1.2.16-1', '1.2.16')).to.be.greaterThan(0)
    expect(compareVersions('1.2.16.post1', '1.2.16-1')).to.equal(0)
    expect(compareVersions('1.2.16-1', '1.2.16-2')).to.be.lessThan(0)
    expect(requirementLowerBound('langgraph==1.2.16-1')).to.equal('1.2.16-1')
    expect(requirementLowerBound('langgraph>=1.2.16-1')).to.equal('1.2.16-1')

    const kept = renderAgent(['langgraph==1.2.16-1'])
    expect(named(kept.text, 'langgraph')).to.deep.equal(['langgraph==1.2.16-1'])
    expect(kept.warnings).to.deep.equal([])

    const raised = renderRequirementsFile({
      frozen: 'langgraph==1.2.16\n',
      pyprojectSource: '[project]\ndependencies = ["langgraph>=1.2.16-1"]\n',
    })
    expect(named(raised, 'langgraph')).to.deep.equal(['langgraph>=1.2.16-1'])
  })

  it('compares epoch versions so 1!0.5 is above a non-epoch floor', () => {
    expect(compareVersions('1!0.5', '2.0')).to.be.greaterThan(0)
    expect(compareVersions('1!0.5', '1.2')).to.be.greaterThan(0)
    expect(compareVersions('1!0.5', '1!1.0')).to.be.lessThan(0)
    expect(compareVersions('1!0.5', '0.5')).to.be.greaterThan(0)
    expect(compareVersions('0!1.0', '1.0')).to.equal(0)
    expect(requirementLowerBound('x==1!0.5')).to.equal('1!0.5')
    expect(requirementLowerBound('x>=1!0.1')).to.equal('1!0.1')

    const kept = renderAgent(['x==1!0.5'], {
      pyprojectSource: '[project]\ndependencies = ["x>=2.0"]\n',
    })
    expect(named(kept.text, 'x')).to.deep.equal(['x==1!0.5'])
    expect(kept.warnings).to.deep.equal([])

    const frozenKept = renderRequirementsFile({
      frozen: 'x==1!0.5\n',
      pyprojectSource: '[project]\ndependencies = ["x>=2.0"]\n',
    })
    expect(named(frozenKept, 'x')).to.deep.equal(['x==1!0.5'])

    const frozenRaised = renderRequirementsFile({
      frozen: 'x==0.5\n',
      pyprojectSource: '[project]\ndependencies = ["x>=1!0.1"]\n',
    })
    expect(named(frozenRaised, 'x')).to.deep.equal(['x>=1!0.1'])

    expect(() => renderAgent(['x==0.5'], {
      pyprojectSource: '[project]\ndependencies = ["x>=1!0.1"]\n',
    })).to.throw(RequirementError, /required floor is x>=1!0\.1/)

    expect(() => renderAgent(['x==1!0.5'], {
      pyprojectSource: '[project]\ndependencies = ["x>=1!1.0"]\n',
    })).to.throw(RequirementError, /x==1!0\.5/)
  })

  it('sorts numeric local segments above alphanumeric ones', () => {
    expect(compareVersions('1.0+1', '1.0+a')).to.be.greaterThan(0)
    expect(compareVersions('1.0+a', '1.0+1')).to.be.lessThan(0)
    expect(compareVersions('1.0+abc', '1.0+ABC')).to.equal(0)
    expect(compareVersions('1.0+a', '1.0+b')).to.be.lessThan(0)
    expect(compareVersions('1.0+1', '1.0')).to.be.greaterThan(0)
    expect(compareVersions('1.0+1.0', '1.0+1')).to.be.greaterThan(0)
    expect(compareVersions('1.0+1.a', '1.0+1.2')).to.be.lessThan(0)
  })

  it('masks URL userinfo in warnings and errors', () => {
    const line = 'langgraph @ git+https://user:TOKEN@github.com/example/langgraph.git@main'
    const {text, warnings} = renderAgent([line])
    expect(named(text, 'langgraph')).to.deep.equal([line])
    expect(warnings).to.have.length(1)
    expect(warnings[0]).to.include('git+https://***@github.com/example/langgraph.git@main')
    expect(warnings[0]).to.not.include('TOKEN')
    expect(warnings[0]).to.not.include('user:')
    expect(maskUrlUserinfo('https://user:TOKEN@host/path')).to.equal('https://***@host/path')

    const malformed = 'requests>=1.0 https://user:TOKEN@host/secret'
    try {
      renderAgent([malformed])
      expect.fail('malformed line should fail')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      expect(message).to.include('https://***@host/secret')
      expect(message).to.include(malformed.split(' ')[0])
      expect(message).to.not.include('TOKEN')
      expect(message).to.not.match(/conflict/i)
    }
  })

  it('rejects a malformed requirement instead of calling it a conflict', () => {
    expect(() => renderAgent(['requests>='])).to.throw(RequirementError, /requests>=/)
    expect(() => renderAgent(['requests>=1.0\\'])).to.throw(RequirementError, /requests>=1\.0\\/)
    try {
      renderAgent(['requests>='])
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      expect(message).to.include('malformed')
      expect(message).to.include('requests>=')
      expect(message).to.not.match(/conflict/i)
    }
  })

  it('prints each warning once per deploy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-warn-'))
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-agent-'))
    const messages: string[] = []
    const original = console.warn
    console.warn = ((message?: unknown) => {
      messages.push(String(message))
    }) as typeof console.warn
    try {
      fs.mkdirSync(path.join(root, 'python'))
      fs.writeFileSync(path.join(root, 'python', 'pyproject.toml'), '[project]\ndependencies = []\n')
      fs.writeFileSync(
        path.join(agent, 'agent.yaml'),
        'runtime:\n  requirements:\n    - "pkg @ git+https://example.com/once-per-deploy.git"\n',
      )
      beginRequirementWarnings()
      writeRequirementsTxt(root, agent)
      writeRequirementsTxt(root, agent)
      const first = messages.filter(message => message.includes('once-per-deploy'))
      expect(first).to.have.length(1)
      expect(first[0]).to.include('direct reference')
      beginRequirementWarnings()
      writeRequirementsTxt(root, agent)
      expect(messages.filter(message => message.includes('once-per-deploy'))).to.have.length(2)
    } finally {
      console.warn = original
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(agent, {recursive: true, force: true})
    }
  })

  it('does not write requirements.txt when the pin cannot meet the floor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-fail-'))
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-fail-agent-'))
    try {
      fs.mkdirSync(path.join(root, 'python'))
      fs.writeFileSync(path.join(root, 'python', 'pyproject.toml'), '[project]\ndependencies = []\n')
      fs.writeFileSync(path.join(agent, 'agent.yaml'), 'runtime:\n  requirements:\n    - "requests==2.31.0"\n')
      expect(() => writeRequirementsTxt(root, agent)).to.throw(RequirementError, /requests==2\.31\.0/)
      expect(fs.existsSync(path.join(agent, 'requirements.txt'))).to.equal(false)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
      fs.rmSync(agent, {recursive: true, force: true})
    }
  })

  it('ignores a directory that only has python/pyproject.toml', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-root-'))
    const previous = process.cwd()
    try {
      fs.mkdirSync(path.join(fake, 'python'))
      fs.writeFileSync(path.join(fake, 'python', 'pyproject.toml'), '[project]\ndependencies = ["not-cast>=1"]\n')
      process.chdir(fake)
      const root = fs.realpathSync(findRequirementsProjectRoot())
      expect(root).to.not.equal(fs.realpathSync(fake))
      expect(fs.existsSync(path.join(root, 'python', 'cast'))).to.equal(true)
      expect(fs.existsSync(path.join(root, 'python', 'pyproject.toml'))).to.equal(true)
    } finally {
      process.chdir(previous)
      fs.rmSync(fake, {recursive: true, force: true})
    }
  })

  it('accepts a directory with python/cast and python/pyproject.toml', () => {
    const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-req-root-'))
    const previous = process.cwd()
    try {
      fs.mkdirSync(path.join(fake, 'python', 'cast'), {recursive: true})
      fs.writeFileSync(path.join(fake, 'python', 'pyproject.toml'), '[project]\ndependencies = ["GitPython>=3.2.1"]\n')
      process.chdir(fake)
      expect(fs.realpathSync(findRequirementsProjectRoot())).to.equal(fs.realpathSync(fake))
    } finally {
      process.chdir(previous)
      fs.rmSync(fake, {recursive: true, force: true})
    }
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
