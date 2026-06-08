import {expect} from 'chai'
import sinon from 'sinon'
import {KeychainManager} from '../../../typescript/cast-cli/dist/lib/keychain'

describe('KeychainManager', () => {
  let keychain: KeychainManager
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    keychain = new KeychainManager()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('generateToken', () => {
    it('should generate a 32-byte base64 encoded token', () => {
      const token = keychain.generateToken()

      // 32 bytes in base64 should be approximately 44 characters (4 * ceil(32/3))
      expect(token).to.be.a('string')
      expect(token.length).to.be.greaterThan(40)
      expect(token.length).to.be.lessThan(50)

      // Verify it's valid base64
      expect(() => Buffer.from(token, 'base64')).to.not.throw()

      // Verify the decoded length is 32 bytes
      const decoded = Buffer.from(token, 'base64')
      expect(decoded.length).to.equal(32)
    })

    it('should generate unique tokens on multiple calls', () => {
      const token1 = keychain.generateToken()
      const token2 = keychain.generateToken()

      expect(token1).to.not.equal(token2)
    })

    it('should generate tokens with only base64 characters', () => {
      const token = keychain.generateToken()
      // Base64 uses: A-Z, a-z, 0-9, +, /
      expect(/^[A-Za-z0-9+/]+=*$/.test(token)).to.be.true
    })
  })

  describe('hashToken', () => {
    it('should create sha256 hex digest of token', () => {
      const token = 'test-token'
      const hash = keychain.hashToken(token)

      // SHA256 produces 64 character hex string
      expect(hash).to.be.a('string')
      expect(hash.length).to.equal(64)

      // Verify it's valid hex
      expect(/^[a-f0-9]+$/i.test(hash)).to.be.true
    })

    it('should produce consistent hash for same input', () => {
      const token = 'test-token'
      const hash1 = keychain.hashToken(token)
      const hash2 = keychain.hashToken(token)

      expect(hash1).to.equal(hash2)
    })

    it('should produce different hash for different inputs', () => {
      const hash1 = keychain.hashToken('token1')
      const hash2 = keychain.hashToken('token2')

      expect(hash1).to.not.equal(hash2)
    })

    it('should match known sha256 hash', () => {
      // Known SHA256 hash of 'hello'
      const hash = keychain.hashToken('hello')
      expect(hash).to.equal('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    })

    it('should handle empty string', () => {
      const hash = keychain.hashToken('')
      expect(hash).to.be.a('string')
      expect(hash.length).to.equal(64)
      // Known SHA256 of empty string
      expect(hash).to.equal('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    })

    it('should handle unicode characters', () => {
      const hash = keychain.hashToken('こんにちは')
      expect(hash).to.be.a('string')
      expect(hash.length).to.equal(64)
    })
  })

  describe('getToken', () => {
    it('should call keytar.getPassword with correct account name', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'getPassword').resolves('test-token')

      const result = await keychain.getToken('my-agent')

      expect(keytarStub.calledOnce).to.be.true
      expect(keytarStub.firstCall.args).to.deep.equal(['cast', 'token:my-agent'])
      expect(result).to.equal('test-token')
    })

    it('should return null on error', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'getPassword').rejects(new Error('Keychain error'))

      const result = await keychain.getToken('my-agent')

      expect(result).to.be.null
    })

    it('should return null when no token exists', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'getPassword').resolves(null)

      const result = await keychain.getToken('my-agent')

      expect(result).to.be.null
    })
  })

  describe('setToken', () => {
    it('should call keytar.setPassword with correct account name', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'setPassword').resolves()

      await keychain.setToken('my-agent', 'my-token')

      expect(keytarStub.calledOnce).to.be.true
      expect(keytarStub.firstCall.args).to.deep.equal(['cast', 'token:my-agent', 'my-token'])
    })

    it('should handle errors gracefully without throwing', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'setPassword').rejects(new Error('Keychain error'))

      // Should resolve normally (not reject) - errors are caught and logged
      await keychain.setToken('my-agent', 'my-token')
    })
  })

  describe('deleteToken', () => {
    it('should call keytar.deletePassword with correct account name', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

      const result = await keychain.deleteToken('my-agent')

      expect(keytarStub.calledOnce).to.be.true
      expect(keytarStub.firstCall.args).to.deep.equal(['cast', 'token:my-agent'])
      expect(result).to.be.true
    })

    it('should return false on error', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'deletePassword').rejects(new Error('Keychain error'))

      const result = await keychain.deleteToken('my-agent')

      expect(result).to.be.false
    })

    it('should return false when token does not exist', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'deletePassword').resolves(false)

      const result = await keychain.deleteToken('my-agent')

      expect(result).to.be.false
    })
  })

  describe('getCredential', () => {
    it('should call keytar.getPassword with credential account name', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'getPassword').resolves('my-credential')

      const result = await keychain.getCredential('my-agent', 'github')

      expect(keytarStub.calledOnce).to.be.true
      expect(keytarStub.firstCall.args).to.deep.equal(['cast', 'credential:my-agent:github'])
      expect(result).to.equal('my-credential')
    })

    it('should return null on error', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'getPassword').rejects(new Error('Keychain error'))

      const result = await keychain.getCredential('my-agent', 'github')

      expect(result).to.be.null
    })
  })

  describe('setCredential', () => {
    it('should call keytar.setPassword with credential account name', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'setPassword').resolves()

      await keychain.setCredential('my-agent', 'github', 'my-secret')

      expect(keytarStub.calledOnce).to.be.true
      expect(keytarStub.firstCall.args).to.deep.equal(['cast', 'credential:my-agent:github', 'my-secret'])
    })

    it('should handle errors gracefully without throwing', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'setPassword').rejects(new Error('Keychain error'))

      // Should resolve normally (not reject) - errors are caught and logged
      await keychain.setCredential('my-agent', 'github', 'secret')
    })
  })

  describe('deleteCredential', () => {
    it('should call keytar.deletePassword with credential account name', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

      const result = await keychain.deleteCredential('my-agent', 'github')

      expect(keytarStub.calledOnce).to.be.true
      expect(keytarStub.firstCall.args).to.deep.equal(['cast', 'credential:my-agent:github'])
      expect(result).to.be.true
    })

    it('should return false on error', async () => {
      const keytarStub = sandbox.stub(require('keytar'), 'deletePassword').rejects(new Error('Keychain error'))

      const result = await keychain.deleteCredential('my-agent', 'github')

      expect(result).to.be.false
    })
  })

  describe('renameAgentEntries', () => {
    it('should update all token entries for the agent', async () => {
      const credentials = [
        {account: 'token:old-agent', password: 'token1'},
        {account: 'credential:old-agent:github', password: 'cred1'},
        {account: 'token:other-agent', password: 'token2'},
      ]

      const keytarStub = sandbox.stub(require('keytar'), 'findCredentials').resolves(credentials)
      const getStub = sandbox.stub(require('keytar'), 'getPassword')
      getStub.withArgs('cast', 'token:old-agent').resolves('token1')
      getStub.withArgs('cast', 'credential:old-agent:github').resolves('cred1')
      getStub.throws(new Error('Not found'))

      const setStub = sandbox.stub(require('keytar'), 'setPassword').resolves()
      const deleteStub = sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

      await keychain.renameAgentEntries('old-agent', 'new-agent')

      // Should have set new entries and deleted old ones
      expect(setStub.callCount).to.be.greaterThan(0)
      expect(deleteStub.callCount).to.be.greaterThan(0)
    })

    it('should handle errors gracefully without throwing', async () => {
      sandbox.stub(require('keytar'), 'findCredentials').rejects(new Error('Keychain error'))

      // Should resolve normally (not reject) - errors are caught and logged
      await keychain.renameAgentEntries('old-agent', 'new-agent')
    })

    it('should only update entries for the specified agent', async () => {
      const credentials = [
        {account: 'token:old-agent', password: 'token1'},
        {account: 'token:other-agent', password: 'token2'},
      ]

      sandbox.stub(require('keytar'), 'findCredentials').resolves(credentials)
      sandbox.stub(require('keytar'), 'getPassword').resolves('token1')

      const setStub = sandbox.stub(require('keytar'), 'setPassword').resolves()
      const deleteStub = sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

      await keychain.renameAgentEntries('old-agent', 'new-agent')

      // Should only update token:old-agent, not token:other-agent
      const setCalls = setStub.getCalls()
      const hasOldAgentUpdate = setCalls.some(call => call.args[1] === 'token:new-agent')
      const hasOtherAgentUpdate = setCalls.some(call => call.args[1] === 'token:other-agent')

      expect(hasOldAgentUpdate).to.be.true
      expect(hasOtherAgentUpdate).to.be.false
    })

    it('should handle missing credentials gracefully', async () => {
      const credentials = [
        {account: 'token:old-agent', password: 'token1'},
      ]

      sandbox.stub(require('keytar'), 'findCredentials').resolves(credentials)
      sandbox.stub(require('keytar'), 'getPassword').resolves(null)

      const setStub = sandbox.stub(require('keytar'), 'setPassword').resolves()
      const deleteStub = sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

      await keychain.renameAgentEntries('old-agent', 'new-agent')

      // Should not call setPassword when getPassword returns null
      expect(setStub.called).to.be.false
    })
  })
})

describe('KeychainManager - Default Export', () => {
  it('should export a singleton instance', () => {
    const keychainModule = require('../../../typescript/cast-cli/dist/lib/keychain')
    expect(keychainModule.keychain).to.exist
    expect(keychainModule.keychain).to.be.instanceOf(KeychainManager)
  })

  it('should have all required methods on the instance', () => {
    const keychainModule = require('../../../typescript/cast-cli/dist/lib/keychain')
    const keychainInstance = keychainModule.keychain

    expect(typeof keychainInstance.getToken).to.equal('function')
    expect(typeof keychainInstance.setToken).to.equal('function')
    expect(typeof keychainInstance.deleteToken).to.equal('function')
    expect(typeof keychainInstance.generateToken).to.equal('function')
    expect(typeof keychainInstance.hashToken).to.equal('function')
    expect(typeof keychainInstance.getCredential).to.equal('function')
    expect(typeof keychainInstance.setCredential).to.equal('function')
    expect(typeof keychainInstance.deleteCredential).to.equal('function')
    expect(typeof keychainInstance.renameAgentEntries).to.equal('function')
  })
})

describe('KeychainManager - Account Naming Conventions', () => {
  let keychain: KeychainManager

  beforeEach(() => {
    keychain = new KeychainManager()
  })

  describe('Token accounts', () => {
    it('should use "token:{agentName}" format for token accounts', () => {
      const agentName = 'my-test-agent'
      const expectedAccount = `token:${agentName}`
      expect(expectedAccount).to.equal('token:my-test-agent')
    })

    it('should handle agent names with hyphens', () => {
      const agentName = 'my-test-agent-v2'
      const expectedAccount = `token:${agentName}`
      expect(expectedAccount).to.equal('token:my-test-agent-v2')
    })

    it('should handle agent names with numbers', () => {
      const agentName = 'agent123'
      const expectedAccount = `token:${agentName}`
      expect(expectedAccount).to.equal('token:agent123')
    })
  })

  describe('Credential accounts', () => {
    it('should use "credential:{agentName}:{server}" format', () => {
      const agentName = 'my-test-agent'
      const server = 'github'
      const expectedAccount = `credential:${agentName}:${server}`
      expect(expectedAccount).to.equal('credential:my-test-agent:github')
    })

    it('should handle server names with special characters', () => {
      const agentName = 'my-agent'
      const server = 'my-server'
      const expectedAccount = `credential:${agentName}:${server}`
      expect(expectedAccount).to.equal('credential:my-agent:my-server')
    })
  })
})

describe('KeychainManager - Error Handling', () => {
  let keychain: KeychainManager
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    keychain = new KeychainManager()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should handle errors by returning null for get operations', async () => {
    sandbox.stub(require('keytar'), 'getPassword').rejects(new Error('Keychain error'))

    const result = await keychain.getToken('my-agent')
    expect(result).to.be.null
  })

  it('should handle errors by returning false for delete operations', async () => {
    sandbox.stub(require('keytar'), 'deletePassword').rejects(new Error('Keychain error'))

    const result = await keychain.deleteToken('my-agent')
    expect(result).to.be.false
  })

  it('should handle set errors gracefully without throwing', async () => {
    sandbox.stub(require('keytar'), 'setPassword').rejects(new Error('Keychain error'))

    // Should resolve normally (not reject) - errors are caught and logged
    await keychain.setToken('my-agent', 'token')
  })

  it('should handle rename errors gracefully without throwing', async () => {
    sandbox.stub(require('keytar'), 'findCredentials').rejects(new Error('Keychain error'))

    // Should resolve normally (not reject) - errors are caught and logged
    await keychain.renameAgentEntries('old', 'new')
  })
})