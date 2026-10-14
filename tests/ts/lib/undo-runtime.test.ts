import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {resolveCastPythonRuntime} from '../../../typescript/cast-cli/src/lib/cast-python'

describe('cast undo python runtime', () => {
  const repoPython = path.resolve(__dirname, '../../../python')

  it('prefers a checkout that contains undo.py and its virtualenv', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-checkout-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-home-'))
    const pythonDir = path.join(root, 'python')
    writePackage(pythonDir, 'def can_undo(name):\n    return True\n')
    const venvPython = path.join(pythonDir, '.venv', 'bin', 'python3')
    fs.mkdirSync(path.dirname(venvPython), {recursive: true})
    fs.writeFileSync(venvPython, '#!/usr/bin/env python3\n')
    writePackage(path.join(home, '.cast', 'python'), 'raise ImportError("stale cast.undo")\n')
    const moduleDir = path.join(root, 'typescript', 'cast-cli', 'dist', 'lib')
    fs.mkdirSync(moduleDir, {recursive: true})

    const runtime = resolveCastPythonRuntime(moduleDir, home)
    expect(runtime.pythonPath).to.equal(pythonDir)
    expect(runtime.command).to.equal(venvPython)
  })

  it('uses python inside the virtualenv when python3 is absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-py-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-home-'))
    const pythonDir = path.join(root, 'python')
    writePackage(pythonDir, 'pass\n')
    const venvPython = path.join(pythonDir, '.venv', 'bin', 'python')
    fs.mkdirSync(path.dirname(venvPython), {recursive: true})
    fs.writeFileSync(venvPython, '')
    const moduleDir = path.join(root, 'typescript', 'cast-cli', 'src', 'lib')

    expect(resolveCastPythonRuntime(moduleDir, home).command).to.equal(venvPython)
  })

  it('uses the shallower checkout layout', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-shallow-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-home-'))
    const pythonDir = path.join(root, 'python')
    writePackage(pythonDir, 'pass\n')
    const moduleDir = path.join(root, 'cast-cli', 'dist', 'lib')
    fs.mkdirSync(moduleDir, {recursive: true})

    expect(resolveCastPythonRuntime(moduleDir, home).pythonPath).to.equal(pythonDir)
  })

  it('keeps a checkout package that has no undo.py ahead of the migrate copy', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-missing-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-home-'))
    const pythonDir = path.join(root, 'python')
    fs.mkdirSync(path.join(pythonDir, 'cast'), {recursive: true})
    fs.writeFileSync(path.join(pythonDir, 'cast', 'versioning.py'), 'pass\n')
    const stale = path.join(home, '.cast', 'python', 'cast')
    fs.mkdirSync(stale, {recursive: true})
    fs.writeFileSync(path.join(stale, 'migrate.py'), 'pass\n')
    fs.writeFileSync(path.join(stale, 'versioning.py'), 'pass\n')
    const moduleDir = path.join(root, 'typescript', 'cast-cli', 'dist', 'lib')
    fs.mkdirSync(moduleDir, {recursive: true})

    const runtime = resolveCastPythonRuntime(moduleDir, home)
    expect(runtime.pythonPath).to.equal(pythonDir)
    expect(runtime.command).to.equal('python3')
  })

  it('falls back to ~/.cast/python when the checkout has no package', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-fallback-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-home-'))
    const installed = path.join(home, '.cast', 'python')
    writePackage(installed, 'pass\n')
    const venvPython = path.join(installed, '.venv', 'bin', 'python3')
    fs.mkdirSync(path.dirname(venvPython), {recursive: true})
    fs.writeFileSync(venvPython, '')
    const moduleDir = path.join(root, 'typescript', 'cast-cli', 'dist', 'lib')
    fs.mkdirSync(moduleDir, {recursive: true})

    const runtime = resolveCastPythonRuntime(moduleDir, home)
    expect(runtime.pythonPath).to.equal(installed)
    expect(runtime.command).to.equal(venvPython)
  })

  it('resolves this repo to the checkout package', () => {
    const moduleDir = path.join(repoPython, '..', 'typescript', 'cast-cli', 'src', 'lib')
    const runtime = resolveCastPythonRuntime(moduleDir)
    expect(runtime.pythonPath).to.equal(repoPython)
    expect(fs.existsSync(path.join(runtime.pythonPath, 'cast', 'undo.py'))).to.equal(true)
  })

  it('undoes and redoes through the checkout when ~/.cast/python would shadow cast.undo', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-undo-seam-'))
    const previousHome = process.env.HOME
    process.env.HOME = home
    const agentName = 'undo-seam-agent'
    const agentDir = path.join(home, '.cast', 'agents', agentName)
    const stale = path.join(home, '.cast', 'python', 'cast')
    fs.mkdirSync(stale, {recursive: true})
    fs.writeFileSync(path.join(stale, '__init__.py'), [
      'from pathlib import Path',
      'Path.home().joinpath(".cast", "stale-undo-imported").write_text("yes\\n")',
      '',
    ].join('\n'))
    fs.writeFileSync(path.join(stale, 'versioning.py'), 'raise ImportError("stale versioning")\n')
    fs.writeFileSync(path.join(stale, 'undo.py'), 'raise ImportError("stale cast.undo was imported")\n')

    try {
      seedAgent(home, agentName)
      const undoLib = require('../../../typescript/cast-cli/src/lib/undo')
      expect(await undoLib.canUndo(agentName)).to.equal(true)
      expect(await undoLib.canRedo(agentName)).to.equal(false)

      const undone = await undoLib.undo(agentName, 1)
      expect(undone).to.have.length(1)
      expect(undone[0].message).to.equal('v2')
      expect(fs.readFileSync(path.join(agentDir, 'instructions.md'), 'utf8')).to.equal('v1\n')
      expect(await undoLib.canRedo(agentName)).to.equal(true)

      const redone = await undoLib.redo(agentName, 1)
      expect(redone).to.have.length(1)
      expect(redone[0].message).to.equal('v2')
      expect(fs.readFileSync(path.join(agentDir, 'instructions.md'), 'utf8')).to.equal('v2\n')
      expect(fs.existsSync(path.join(home, '.cast', 'stale-undo-imported'))).to.equal(false)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      fs.rmSync(home, {recursive: true, force: true})
    }
  })
})

function writePackage(pythonDir: string, undoBody: string): void {
  const pkg = path.join(pythonDir, 'cast')
  fs.mkdirSync(pkg, {recursive: true})
  fs.writeFileSync(path.join(pkg, 'undo.py'), undoBody)
}

function seedAgent(home: string, agentName: string): void {
  const script = `
import json
from pathlib import Path
from cast.versioning import create_version
name = ${JSON.stringify(agentName)}
agent = Path.home() / ".cast" / "agents" / name
agent.mkdir(parents=True)
(agent / "agent.yaml").write_text("name: " + name + "\\n")
(agent / "instructions.md").write_text("v1\\n")
create_version(name, "create", "v1")
(agent / "instructions.md").write_text("v2\\n")
create_version(name, "cli", "v2")
print(json.dumps({"ok": True}))
`
  const out = execFileSync('python3', ['-c', script], {
    cwd: home,
    env: {...process.env, HOME: home, PYTHONPATH: repoPythonFromHere()},
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  expect(JSON.parse(out)).to.deep.equal({ok: true})
}

function repoPythonFromHere(): string {
  return path.resolve(__dirname, '../../../python')
}
