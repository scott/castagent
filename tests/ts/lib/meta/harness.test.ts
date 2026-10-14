import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  META_TEST_ECHO_ENV,
  metaTestChildEnv,
  metaTestInitializeParams,
  resolveMetaTestPython,
} from '../../../../typescript/cast-cli/src/lib/meta/harness'

describe('meta test harness', () => {
  const commandSource = fs.readFileSync(
    path.resolve(__dirname, '../../../../typescript/cast-cli/src/commands/meta/test.ts'),
    'utf8',
  )

  it('does not hardcode a developer checkout path', () => {
    expect(commandSource).to.not.include('/Users/scott/Workspace')
    expect(commandSource).to.include('resolveMetaTestPython')
    expect(commandSource).to.include('metaTestChildEnv')
    expect(commandSource).to.include('metaTestInitializeParams')
  })

  it('prefers the checkout virtualenv over system python3', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-meta-checkout-'))
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-meta-home-'))
    const pythonDir = path.join(root, 'python')
    const packageDir = path.join(pythonDir, 'cast')
    fs.mkdirSync(packageDir, {recursive: true})
    fs.writeFileSync(path.join(packageDir, 'undo.py'), 'def can_undo(name):\n    return True\n')
    const venvPython = path.join(pythonDir, '.venv', 'bin', 'python3')
    fs.mkdirSync(path.dirname(venvPython), {recursive: true})
    fs.writeFileSync(venvPython, '')
    fs.mkdirSync(path.join(home, '.cast', 'python', 'cast'), {recursive: true})
    fs.writeFileSync(path.join(home, '.cast', 'python', 'cast', 'undo.py'), 'raise ImportError("stale")\n')

    const commandDir = path.join(root, 'typescript', 'cast-cli', 'dist', 'commands', 'meta')
    fs.mkdirSync(commandDir, {recursive: true})

    const runtime = resolveMetaTestPython(commandDir, home)
    expect(runtime.pythonPath).to.equal(pythonDir)
    expect(runtime.command).to.equal(venvPython)

    const env = metaTestChildEnv({OPENROUTER_API_KEY: 'sk-test', PYTHONPATH: '/tmp/other'}, runtime)
    expect(env[META_TEST_ECHO_ENV]).to.equal('1')
    expect(env.PYTHONPATH!.startsWith(pythonDir)).to.equal(true)
    expect(env.PYTHONPATH).to.include('/tmp/other')
    expect(env.OPENROUTER_API_KEY).to.equal('sk-test')
  })

  it('falls back to python3 when the virtualenv is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-meta-novenv-'))
    const pythonDir = path.join(root, 'python')
    fs.mkdirSync(path.join(pythonDir, 'cast'), {recursive: true})
    fs.writeFileSync(path.join(pythonDir, 'cast', 'undo.py'), 'pass\n')
    const commandDir = path.join(root, 'typescript', 'cast-cli', 'src', 'commands', 'meta')
    fs.mkdirSync(commandDir, {recursive: true})

    const runtime = resolveMetaTestPython(commandDir)
    expect(runtime.pythonPath).to.equal(pythonDir)
    expect(runtime.command).to.equal(process.platform === 'win32' ? 'python' : 'python3')
  })

  it('initializes the builder as a harness, not a new agent named meta-test', () => {
    expect(metaTestInitializeParams()).to.deep.equal({
      agent_name: 'meta-test',
      harness: true,
    })
  })
})
