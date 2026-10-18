import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import {KeychainManager} from '../../../typescript/cast-cli/src/lib/keychain'
import {shutdownTokenRemovalMessage} from '../../../typescript/cast-cli/src/commands/shutdown'

const secretServiceError = new Error(
  'The name org.freedesktop.secrets was not provided by any .service files',
)

describe('token file fallback', () => {
  let sandbox: sinon.SinonSandbox
  let root: string
  let tokens: string
  let keychain: KeychainManager

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-token-files-'))
    tokens = path.join(root, 'tokens')
    keychain = new KeychainManager(tokens)
  })

  afterEach(() => {
    sandbox.restore()
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('does not write a token file when the keychain fails for another reason', async () => {
    sandbox.stub(require('keytar'), 'setPassword').rejects(new Error('Keychain error'))
    const errorSpy = sandbox.stub(console, 'error')

    await keychain.setDeploymentToken('f6559e', 'secret')
    await keychain.setToken('bb2-chat', 'secret')

    expect(fs.existsSync(path.join(tokens, 'deployments', 'f6559e.token'))).to.equal(false)
    expect(fs.existsSync(path.join(tokens, 'bb2-chat.token'))).to.equal(false)
    expect(errorSpy.called).to.equal(true)
  })

  it('does not write outside the token directory for an unsafe name', async () => {
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(console, 'error')

    await keychain.setToken('../agents', 'secret')
    await keychain.setDeploymentToken('../abcd', 'secret')

    expect(fs.existsSync(path.join(root, 'agents'))).to.equal(false)
    expect(fs.existsSync(path.join(tokens, 'deployments'))).to.equal(false)
    const escaped = fs.readdirSync(root).filter(name => name !== 'tokens')
    expect(escaped).to.deep.equal([])
  })

  it('drops a stale file after the keychain accepts the token', async () => {
    const filePath = path.join(tokens, 'deployments', 'f6559e.token')
    fs.mkdirSync(path.dirname(filePath), {recursive: true})
    fs.writeFileSync(filePath, 'stale')
    sandbox.stub(require('keytar'), 'setPassword').resolves()

    await keychain.setDeploymentToken('f6559e', 'fresh')

    expect(fs.existsSync(filePath)).to.equal(false)
  })

  it('prefers the keychain token over a leftover file', async () => {
    const filePath = path.join(tokens, 'bb2-chat.token')
    fs.mkdirSync(tokens, {recursive: true})
    fs.writeFileSync(filePath, 'file-token')
    sandbox.stub(require('keytar'), 'getPassword').resolves('keychain-token')

    const token = await keychain.getToken('bb2-chat')

    expect(token).to.equal('keychain-token')
  })

  it('removes the deployment file when the keychain is unavailable', async () => {
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)
    sandbox.stub(console, 'error')
    await keychain.setDeploymentToken('f6559e', 'deploy-token')

    const removed = await keychain.deleteDeploymentToken('f6559e')

    expect(removed).to.deep.equal({removed: true, stores: ['file']})
    expect(fs.existsSync(path.join(tokens, 'deployments', 'f6559e.token'))).to.equal(false)
  })

  it('reports the keychain when that is where the agent token was removed', async () => {
    sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

    const removed = await keychain.deleteToken('bb2-chat')

    expect(removed).to.deep.equal({removed: true, stores: ['keychain']})
  })

  it('reports the token file and the keychain when both held the token', async () => {
    const filePath = path.join(tokens, 'bb2-chat.token')
    fs.mkdirSync(tokens, {recursive: true})
    fs.writeFileSync(filePath, 'stale')
    sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

    const removed = await keychain.deleteToken('bb2-chat')

    expect(removed).to.deep.equal({removed: true, stores: ['file', 'keychain']})
    expect(fs.existsSync(filePath)).to.equal(false)
  })

  it('renames the agent token file when the keychain cannot', async () => {
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'findCredentials').rejects(new Error('Keychain error'))
    sandbox.stub(console, 'error')
    await keychain.setToken('old-agent', 'agent-token')

    await keychain.renameAgentEntries('old-agent', 'new-agent')

    expect(fs.existsSync(path.join(tokens, 'old-agent.token'))).to.equal(false)
    const renamed = path.join(tokens, 'new-agent.token')
    expect(fs.readFileSync(renamed, 'utf8')).to.equal('agent-token')
    expect(fs.statSync(renamed).mode & 0o777).to.equal(0o600)
  })

  it('creates the token file mode 0600 under umask 022, before any chmod', async () => {
    const previous = process.umask(0o022)
    const births: number[] = []
    const chmodmed: string[] = []
    const dirBirths: number[] = []
    // import * as fs copies getters. Stub the Node module keychain calls.
    const nodeFs = require('fs') as typeof fs
    const realOpen = nodeFs.openSync
    const realMkdir = nodeFs.mkdirSync
    const realChmod = nodeFs.chmodSync
    sandbox.stub(nodeFs, 'openSync').callsFake((...args: unknown[]) => {
      const fd = (realOpen as (...openArgs: unknown[]) => number).apply(nodeFs, args)
      const file = typeof args[0] === 'string' ? args[0] : ''
      if (file.endsWith('.token') || file.includes('.token.')) {
        births.push(nodeFs.fstatSync(fd).mode & 0o777)
      }
      return fd
    })
    sandbox.stub(nodeFs, 'mkdirSync').callsFake((...args: unknown[]): string | undefined => {
      const created = (realMkdir as (...mkdirArgs: unknown[]) => string | undefined).apply(nodeFs, args)
      const dir = typeof args[0] === 'string' ? args[0] : ''
      if (dir && nodeFs.existsSync(dir) && nodeFs.statSync(dir).isDirectory()) {
        dirBirths.push(nodeFs.statSync(dir).mode & 0o777)
      }
      return created
    })
    sandbox.stub(nodeFs, 'chmodSync').callsFake((file: fs.PathLike, mode: fs.Mode) => {
      chmodmed.push(String(file))
      return realChmod(file, mode)
    })
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    try {
      await keychain.setToken('bb2-chat', 'stand-in-token')
      await keychain.setDeploymentToken('f6559e', 'stand-in-deploy-token')

      const agentFile = path.join(tokens, 'bb2-chat.token')
      const deployFile = path.join(tokens, 'deployments', 'f6559e.token')
      expect(births.length).to.be.greaterThan(0)
      expect(births.every(mode => mode === 0o600)).to.equal(true)
      expect(dirBirths.length).to.be.greaterThan(0)
      expect(dirBirths.every(mode => mode === 0o700)).to.equal(true)
      expect(fs.statSync(agentFile).mode & 0o777).to.equal(0o600)
      expect(fs.statSync(deployFile).mode & 0o777).to.equal(0o600)
      expect(fs.readFileSync(agentFile, 'utf8')).to.equal('stand-in-token')
      expect(fs.readFileSync(deployFile, 'utf8')).to.equal('stand-in-deploy-token')
      expect(fs.statSync(tokens).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(path.join(tokens, 'deployments')).mode & 0o777).to.equal(0o700)
      expect(chmodmed.some(file => file.endsWith('.token'))).to.equal(false)
      expect(fs.readdirSync(tokens).filter(name => name.includes('.tmp'))).to.deep.equal([])
      const during = process.umask(0o022)
      expect(during).to.equal(0o022)
    } finally {
      process.umask(previous)
    }
  })

  it('tightens a renamed token file that was mode 0644', async () => {
    fs.mkdirSync(tokens, {recursive: true})
    const from = path.join(tokens, 'old-agent.token')
    fs.writeFileSync(from, 'agent-token')
    fs.chmodSync(from, 0o644)
    sandbox.stub(require('keytar'), 'findCredentials').rejects(new Error('Keychain error'))
    sandbox.stub(console, 'error')

    await keychain.renameAgentEntries('old-agent', 'new-agent')

    const renamed = path.join(tokens, 'new-agent.token')
    expect(fs.readFileSync(renamed, 'utf8')).to.equal('agent-token')
    expect(fs.statSync(renamed).mode & 0o777).to.equal(0o600)
  })

  it('tightens a token directory that already exists as mode 0755', async () => {
    const previous = process.umask(0o022)
    fs.mkdirSync(tokens, {recursive: true})
    fs.chmodSync(tokens, 0o755)
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    try {
      await keychain.setToken('bb2-chat', 'stand-in-token')
      expect(fs.statSync(tokens).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(path.join(tokens, 'bb2-chat.token')).mode & 0o777).to.equal(0o600)
    } finally {
      process.umask(previous)
    }
  })

  it('names the token file when shutdown deletes a file and the keychain is missing', async () => {
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)
    await keychain.setToken('bb2-chat', 'file-token')
    const filePath = path.join(tokens, 'bb2-chat.token')
    expect(fs.existsSync(filePath)).to.equal(true)

    const result = await keychain.deleteToken('bb2-chat')

    expect(fs.existsSync(filePath)).to.equal(false)
    expect(result).to.deep.equal({removed: true, stores: ['file']})
    const message = shutdownTokenRemovalMessage('agent', result.stores, 'bb7590')
    expect(message).to.equal('Removed auth token from token file.')
    expect(message).to.not.include('keychain')
  })

  it('replaces an existing token file without leaving a temp file', async () => {
    const previous = process.umask(0o022)
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    try {
      await keychain.setToken('bb2-chat', 'first-token')
      await keychain.setToken('bb2-chat', 'second-token')
      const filePath = path.join(tokens, 'bb2-chat.token')
      expect(fs.readFileSync(filePath, 'utf8')).to.equal('second-token')
      expect(fs.statSync(filePath).mode & 0o777).to.equal(0o600)
      expect(fs.readdirSync(tokens).filter(name => name.includes('.tmp'))).to.deep.equal([])
    } finally {
      process.umask(previous)
    }
  })

  it('tightens ~/.cast when the token directory lives there', async () => {
    const home = path.join(os.homedir(), '.cast')
    const homeExisted = fs.existsSync(home)
    const homeMode = homeExisted ? fs.statSync(home).mode & 0o777 : null
    const tokensDir = path.join(home, `tokens-perm-${process.pid}`)
    const isolated = new KeychainManager(tokensDir)
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    const previous = process.umask(0o022)
    try {
      if (homeExisted) fs.chmodSync(home, 0o755)
      await isolated.setToken('perm-probe', 'stand-in-token')
      expect(fs.statSync(home).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(tokensDir).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(path.join(tokensDir, 'perm-probe.token')).mode & 0o777).to.equal(0o600)
    } finally {
      process.umask(previous)
      fs.rmSync(tokensDir, {recursive: true, force: true})
      if (!homeExisted) {
        fs.rmSync(home, {recursive: true, force: true})
      } else if (homeMode !== null) {
        fs.chmodSync(home, homeMode)
      }
    }
  })
})
