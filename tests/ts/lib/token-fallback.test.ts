import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import {KeychainManager} from '../../../typescript/cast-cli/src/lib/keychain'

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

    expect(removed).to.equal(true)
    expect(fs.existsSync(path.join(tokens, 'deployments', 'f6559e.token'))).to.equal(false)
  })

  it('renames the agent token file when the keychain cannot', async () => {
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'findCredentials').rejects(new Error('Keychain error'))
    sandbox.stub(console, 'error')
    await keychain.setToken('old-agent', 'agent-token')

    await keychain.renameAgentEntries('old-agent', 'new-agent')

    expect(fs.existsSync(path.join(tokens, 'old-agent.token'))).to.equal(false)
    expect(fs.readFileSync(path.join(tokens, 'new-agent.token'), 'utf8')).to.equal('agent-token')
  })
})
