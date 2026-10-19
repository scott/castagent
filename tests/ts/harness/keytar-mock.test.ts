import {expect} from 'chai'
import * as path from 'path'
import sinon from 'sinon'
import {KeychainManager} from '../../../typescript/cast-cli/src/lib/keychain'

const TEST_KEYTAR = Symbol.for('cast.testKeytar')

describe('keytar test double', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('satisfies require("keytar") without loading the native binding', () => {
    const keytar = require('keytar')
    expect(keytar[TEST_KEYTAR]).to.equal(true)
    expect(keytar.getPassword).to.be.a('function')
    expect(keytar.setPassword).to.be.a('function')
    expect(keytar.deletePassword).to.be.a('function')
    expect(keytar.findCredentials).to.be.a('function')

    const loadedNative = Object.keys(require.cache).some(filename =>
      filename.includes(`${path.sep}keytar${path.sep}`) &&
      (filename.endsWith('.node') || filename.endsWith(`${path.sep}keytar.js`)),
    )
    expect(loadedNative).to.equal(false)
  })

  it('remembers a password for tests that do not stub keytar', async () => {
    const keytar = require('keytar')
    await keytar.setPassword('cast', 'token:round', 'secret')
    expect(await keytar.getPassword('cast', 'token:round')).to.equal('secret')
    expect(await keytar.deletePassword('cast', 'token:round')).to.equal(true)
    expect(await keytar.getPassword('cast', 'token:round')).to.equal(null)
  })

  it('is the object KeychainManager calls, so existing stubs still apply', async () => {
    const keytar = require('keytar')
    const getPassword = sandbox.stub(keytar, 'getPassword').resolves('from-mock')

    const manager = new KeychainManager()
    const token = await manager.getToken('my-agent', {silent: true})

    expect(token).to.equal('from-mock')
    expect(getPassword.calledOnceWith('cast', 'token:my-agent')).to.equal(true)
  })
})
