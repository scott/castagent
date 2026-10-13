import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'
import {resolveCastPythonPath as resolveCliPythonPath} from '../../../typescript/cast-cli/src/lib/cast-python'

function loadTuiResolver(): typeof resolveCliPythonPath {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/cast-python.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true},
  }).outputText
  const module = {exports: {} as {resolveCastPythonPath: typeof resolveCliPythonPath}}
  const sandbox = {exports: module.exports, module, require, console}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports.resolveCastPythonPath
}

function writeSessionsPy(dir: string, body: string): void {
  const pkg = path.join(dir, 'cast')
  fs.mkdirSync(pkg, {recursive: true})
  fs.writeFileSync(path.join(pkg, 'sessions.py'), body)
}

describe('cast python path for sessions', () => {
  const repo = path.resolve(__dirname, '../../..')
  const resolveTuiPythonPath = loadTuiResolver()

  it('prefers the checkout package over a stale ~/.cast/python', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-python-checkout-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-python-home-'))
    writeSessionsPy(path.join(root, 'python'), 'class SessionMeta:\n    topic = None\n')
    writeSessionsPy(path.join(home, '.cast', 'python'), 'class SessionMeta:\n    pass\n')
    const moduleDir = path.join(root, 'typescript', 'cast-tui', 'dist', 'lib')
    fs.mkdirSync(moduleDir, {recursive: true})

    for (const resolve of [resolveCliPythonPath, resolveTuiPythonPath]) {
      expect(resolve(moduleDir, home)).to.equal(path.join(root, 'python'))
    }
  })

  it('uses the shallower checkout layout when that is where sessions.py lives', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-python-shallow-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-python-home-'))
    writeSessionsPy(path.join(root, 'python'), 'topic = None\n')
    const moduleDir = path.join(root, 'cast-cli', 'dist', 'lib')
    fs.mkdirSync(moduleDir, {recursive: true})

    expect(resolveCliPythonPath(moduleDir, home)).to.equal(path.join(root, 'python'))
  })

  it('falls back to ~/.cast/python when the checkout has no package', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-python-missing-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-python-home-'))
    writeSessionsPy(path.join(home, '.cast', 'python'), 'class SessionMeta:\n    pass\n')
    const moduleDir = path.join(root, 'typescript', 'cast-cli', 'dist', 'lib')
    fs.mkdirSync(moduleDir, {recursive: true})

    expect(resolveCliPythonPath(moduleDir, home)).to.equal(path.join(home, '.cast', 'python'))
    expect(resolveTuiPythonPath(moduleDir, home)).to.equal(path.join(home, '.cast', 'python'))
  })

  it('resolves this repo from both dist layouts and can append a topic-column row', () => {
    const cliSrc = path.join(repo, 'typescript', 'cast-cli', 'src', 'lib')
    const tuiDist = path.join(repo, 'typescript', 'cast-tui', 'dist', 'lib')
    const cliDist = path.join(repo, 'typescript', 'cast-cli', 'dist', 'lib')
    const expected = path.join(repo, 'python')

    expect(resolveCliPythonPath(cliSrc)).to.equal(expected)
    expect(resolveCliPythonPath(cliDist)).to.equal(expected)
    expect(resolveTuiPythonPath(tuiDist)).to.equal(expected)

    const sessions = fs.readFileSync(path.join(expected, 'cast', 'sessions.py'), 'utf8')
    expect(sessions).to.include('topic: Optional[str] = None')
    expect(sessions).to.match(/if key not in known/)

    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-python-append-'))
    const script = [
      'import json',
      'from cast.sessions import SessionStore',
      'store = SessionStore()',
      'sess = store.create(agent_name="demo", ui_mode="production")',
      'store.append_message(sess.id, "user", "hi there")',
      'loaded = store.get(sess.id)',
      'print(json.dumps({"n": len(loaded.messages), "text": loaded.messages[0].text}))',
    ].join('\n')
    const out = execFileSync('python3', ['-c', script], {
      env: {...process.env, HOME: home, PYTHONPATH: expected},
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    expect(JSON.parse(out)).to.deep.equal({n: 1, text: 'hi there'})
  })
})
