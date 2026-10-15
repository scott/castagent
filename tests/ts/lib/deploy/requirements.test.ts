import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  canonicalRequirementName,
  filterRequirementLines,
  GITPYTHON_REQUIREMENT,
  parsePyprojectDependencies,
  parseRuntimeRequirements,
  renderRequirementsFile,
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
})
