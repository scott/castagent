import {expect} from 'chai'
import {spawnSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as sinon from 'sinon'
import {keychain} from '../../../typescript/cast-cli/src/lib/keychain'

const repoRoot = path.resolve(__dirname, '../../..')
const tsNodeRegister = require.resolve('ts-node/register')
const preload = path.join(__dirname, 'keytar-unloadable.cjs')

function spawnCast(script: string, args: string[], input: string, home: string) {
  return spawnSync(process.execPath, ['-r', preload, '-r', tsNodeRegister, script, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      TS_NODE_TRANSPILE_ONLY: '1',
      TS_NODE_PROJECT: path.join(repoRoot, 'tsconfig.test.json'),
    },
    encoding: 'utf8',
    input,
  })
}

describe('keytar unloadable', () => {
  let home: string
  const previousHome = process.env.HOME

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-keytar-'))
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    fs.rmSync(home, {recursive: true, force: true})
  })

  it('cast new does not crash when keytar cannot be loaded', () => {
    const worker = path.join(__dirname, '../commands/new-stdin-worker.ts')
    const result = spawnCast(worker, [], 'Summarises incoming email.\n', home)
    const output = `${result.stdout}\n${result.stderr}`
    expect(output).to.not.include('libsecret')
    expect(output).to.not.include('ERR_DLOPEN_FAILED')
    expect(output).to.not.match(/command new not found/i)
    expect(output).to.not.include("Cannot find module 'keytar'")
  })

  it('cast provider enable --token - stores the key in the 0600 file', () => {
    const worker = path.join(__dirname, '../commands/provider-enable-worker.ts')
    const result = spawnCast(worker, ['digitalocean', '--token', '-'], 'do-file-secret\n', home)
    expect(result.status, `${result.stdout}\n${result.stderr}`).to.equal(0)
    const tokenFile = path.join(home, '.cast', 'tokens', 'inference', 'digitalocean.token')
    expect(fs.readFileSync(tokenFile, 'utf8').trim()).to.equal('do-file-secret')
    expect(fs.statSync(tokenFile).mode & 0o777).to.equal(0o600)
    const config = path.join(home, '.cast', 'config.yaml')
    if (fs.existsSync(config)) {
      expect(fs.readFileSync(config, 'utf8')).to.not.include('do-file-secret')
    }
    expect(`${result.stdout}\n${result.stderr}`).to.not.include('do-file-secret')
  })
})

describe('getInferenceToken file fallback', () => {
  let home: string
  const previousHome = process.env.HOME
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-token-file-'))
    process.env.HOME = home
  })

  afterEach(() => {
    sandbox.restore()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    fs.rmSync(home, {recursive: true, force: true})
  })

  it('reads the token file when keytar returns an unexpected error', async () => {
    const keytar = require('keytar')
    sandbox.stub(keytar, 'getPassword').rejects(new Error('keychain locked'))
    const file = path.join(home, '.cast', 'tokens', 'inference', 'digitalocean.token')
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, 'from-file\n', {mode: 0o600})
    expect(await keychain.getInferenceToken('digitalocean')).to.equal('from-file')
  })
})
