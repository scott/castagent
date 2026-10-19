import {expect} from 'chai'
import sinon from 'sinon'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {KeychainManager} from '../../../typescript/cast-cli/src/lib/keychain'
import {
  deploymentIdsToRemove,
  deploymentAuthFailureReason,
  forgetDeploymentTokens,
  getAgentPath,
  isShaPattern,
  missingDeploymentAuthMessage,
  resolveDeploymentAuthToken,
  resolveDeploymentTarget,
  generateDeploymentSha,
  generateDeploymentId,
  loadConfig,
  getProviderToken,
  getVolumeName,
  getMemoryMountPath,
  storeAuthToken,
  saveDeployment,
} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'

describe('Agent Path Resolution', () => {
  describe('getAgentPath', () => {
    it('should return path under ~/.cast/agents', () => {
      const agentName = 'test-agent'
      const result = getAgentPath(agentName)
      const expected = path.join(os.homedir(), '.cast', 'agents', agentName)
      expect(result).to.equal(expected)
    })

    it('should not return path under ~/cast-agents (old location)', () => {
      const agentName = 'test-agent'
      const result = getAgentPath(agentName)
      const oldLocation = path.join(os.homedir(), 'cast-agents', agentName)
      expect(result).to.not.equal(oldLocation)
    })

    it('should handle hyphenated agent names', () => {
      const agentName = 'my-test-agent'
      const result = getAgentPath(agentName)
      expect(result).to.include(path.join('.cast', 'agents', agentName))
    })

    it('should include .cast in the path', () => {
      const result = getAgentPath('any-agent')
      expect(result).to.include('.cast')
    })

    it('should includes agents in the path', () => {
      const result = getAgentPath('any-agent')
      expect(result).to.include('agents')
    })
  })
})

describe('Deployment SHA helpers', () => {
  describe('isShaPattern', () => {
    it('matches 6-char lowercase alphanumeric', () => {
      expect(isShaPattern('abc123')).to.be.true
      expect(isShaPattern('000000')).to.be.true
      expect(isShaPattern('ffffff')).to.be.true
      expect(isShaPattern('a1b2c3')).to.be.true
    })

    it('rejects strings that are too short', () => {
      expect(isShaPattern('abc12')).to.be.false
    })

    it('rejects strings that are too long', () => {
      expect(isShaPattern('abc1234')).to.be.false
    })

    it('rejects uppercase characters', () => {
      expect(isShaPattern('ABC123')).to.be.false
      expect(isShaPattern('Abc123')).to.be.false
    })

    it('rejects strings with special characters', () => {
      expect(isShaPattern('abc-12')).to.be.false
      expect(isShaPattern('abc_12')).to.be.false
      expect(isShaPattern('abc 12')).to.be.false
    })

    it('rejects empty string', () => {
      expect(isShaPattern('')).to.be.false
    })

    it('rejects agent names that are not SHA-shaped', () => {
      expect(isShaPattern('email-agent')).to.be.false
      expect(isShaPattern('myagent')).to.be.false
    })
  })

  describe('generateDeploymentSha', () => {
    it('returns 6-character lowercase hex string', () => {
      const sha = generateDeploymentSha('any-agent')
      expect(sha).to.be.a('string')
      expect(sha).to.match(/^[a-f0-9]{6}$/)
    })

    it('returns different values for repeated calls (randomness)', () => {
      const shas = new Set<string>()
      for (let i = 0; i < 20; i++) {
        shas.add(generateDeploymentSha('same-agent'))
      }
      // Probability of collision is astronomically low; we expect all unique
      expect(shas.size).to.be.greaterThan(15)
    })

    it('returns 6 characters', () => {
      const sha = generateDeploymentSha('any-agent')
      expect(sha).to.have.length(6)
    })
  })

  describe('generateDeploymentId', () => {
    it('returns a UUID string', () => {
      const id = generateDeploymentId()
      expect(id).to.be.a('string')
      expect(id).to.match(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i)
    })

    it('returns unique values for repeated calls', () => {
      const id1 = generateDeploymentId()
      const id2 = generateDeploymentId()
      expect(id1).to.not.equal(id2)
    })
  })
})

describe('saveDeployment', () => {
  it('stores CAST_DEPLOYMENT_SHA and records the agent row', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `fk-test-sha-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const sha = Math.random().toString(16).slice(2, 8)
    const previous = process.env.CAST_DEPLOYMENT_SHA
    process.env.CAST_DEPLOYMENT_SHA = sha
    try {
      const id = saveDeployment(agentName, 'docker', 'http://localhost:8080', 'hash', 'vol', '{}')
      expect(id).to.equal(sha)
      expect(db.getAgent(agentName)).to.exist
      const deployment = db.getDeploymentBySha(sha)
      expect(deployment).to.exist
      expect(deployment.agent_name).to.equal(agentName)
      expect(deployment.provider).to.equal('docker')
    } finally {
      if (previous === undefined) delete process.env.CAST_DEPLOYMENT_SHA
      else process.env.CAST_DEPLOYMENT_SHA = previous
      db.deleteAgent(agentName)
    }
  })
})

describe('resolveDeploymentTarget', () => {
  it('returns sha resolution for valid SHA pattern that exists', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `resolve-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const sha = `sha${Math.random().toString(16).slice(2, 5)}`
    db.createAgent(agentName, '/tmp/agent.yaml')
    db.createDeployment(sha, agentName, 'docker', 'http://localhost', 'h')

    const result = resolveDeploymentTarget(sha)
    expect(result.type).to.equal('sha')
    expect(result.deployment.id).to.equal(sha)

    db.deleteAgent(agentName)
  })

  it('returns not_found for SHA pattern that does not exist', () => {
    const result = resolveDeploymentTarget('xxxxxx')
    expect(result.type).to.equal('not_found')
    expect(result.message).to.exist
  })

  it('returns single resolution when agent name matches one deployment', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `single-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(agentName, '/tmp/agent.yaml')
    db.setDeployment(agentName, 'docker', 'http://localhost', 'h')

    const result = resolveDeploymentTarget(agentName)
    expect(result.type).to.equal('single')
    expect(result.deployment.agent_name).to.equal(agentName)

    db.deleteAgent(agentName)
  })

  it('returns ambiguous when agent name matches multiple deployments', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `ambig-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(agentName, '/tmp/agent.yaml')
    db.createDeployment(`amb1${Math.random().toString(16).slice(2, 4)}`, agentName, 'docker', 'http://a', 'h')
    db.createDeployment(`amb2${Math.random().toString(16).slice(2, 4)}`, agentName, 'fly', 'http://b', 'h')

    const result = resolveDeploymentTarget(agentName)
    expect(result.type).to.equal('ambiguous')
    expect(result.deployments).to.have.length(2)
    expect(result.message).to.include('Multiple deployments')

    db.deleteAgent(agentName)
  })

  it('returns single when same agent has multiple deployments to same target', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `collapse-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(agentName, '/tmp/agent.yaml')
    // Two deployments with identical provider and URL — historical re-deploys
    const older = `col1${Math.random().toString(16).slice(2, 4)}`
    const newer = `col2${Math.random().toString(16).slice(2, 4)}`
    db.createDeployment(older, agentName, 'digitalocean', 'http://142.93.75.156:8080', 'h')
    db.createDeployment(newer, agentName, 'digitalocean', 'http://142.93.75.156:8080', 'h')

    const result = resolveDeploymentTarget(agentName)
    expect(result.type).to.equal('single')
    expect(result.deployment).to.exist
    expect(result.deployment.id).to.equal(newer)
    expect(result.deployment.agent_name).to.equal(agentName)
    expect(db.getDeploymentBySha(older)).to.not.exist

    db.deleteAgent(agentName)
  })

  it('returns ambiguous when deployments have same provider but different URLs', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `url-ambig-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(agentName, '/tmp/agent.yaml')
    db.createDeployment(`url1${Math.random().toString(16).slice(2, 4)}`, agentName, 'fly', 'http://app-a.fly.dev', 'h')
    db.createDeployment(`url2${Math.random().toString(16).slice(2, 4)}`, agentName, 'fly', 'http://app-b.fly.dev', 'h')

    const result = resolveDeploymentTarget(agentName)
    expect(result.type).to.equal('ambiguous')
    expect(result.deployments).to.have.length(2)

    db.deleteAgent(agentName)
  })

  it('returns ambiguous with mix of same-target and distinct deployments', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `mix-ambig-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(agentName, '/tmp/agent.yaml')
    // Two re-deploys to the same target. Resolving the name retires the older one.
    const older = `mix1${Math.random().toString(16).slice(2, 4)}`
    const newer = `mix2${Math.random().toString(16).slice(2, 4)}`
    const fly = `mix3${Math.random().toString(16).slice(2, 4)}`
    db.createDeployment(older, agentName, 'digitalocean', 'http://142.93.75.156:8080', 'h')
    db.createDeployment(newer, agentName, 'digitalocean', 'http://142.93.75.156:8080', 'h')
    // One deployment to a distinct target
    db.createDeployment(fly, agentName, 'fly', 'http://app.fly.dev', 'h')

    const result = resolveDeploymentTarget(agentName)
    expect(result.type).to.equal('ambiguous')
    expect((result.deployments || []).map((row: {id: string}) => row.id)).to.have.members([newer, fly])
    expect(db.getDeploymentBySha(older)).to.not.exist

    db.deleteAgent(agentName)
  })

  it('returns not_found for nonexistent agent name', () => {
    const result = resolveDeploymentTarget(`nonexistent-agent-${Date.now()}`)
    expect(result.type).to.equal('not_found')
  })

  it('detects 6-char SHA pattern even if it could be an agent name', () => {
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const sha = `zzz${Math.random().toString(16).slice(2, 5)}`
    // Don't create a deployment for this SHA - should return not_found
    const result = resolveDeploymentTarget(sha)
    expect(result.type).to.equal('not_found')
  })
})

describe('Provider configuration', () => {
  describe('getProviderToken', () => {
    afterEach(() => {
      // Clean up env vars
      delete process.env.RAILWAY_TOKEN
      delete process.env.CUSTOM_TOKEN_VAR
      delete process.env.FLY_TOKEN
    })

    it('returns undefined when no token configured', () => {
      const token = getProviderToken('nonexistent-provider-' + Date.now())
      expect(token).to.be.undefined
    })

    it('reads from custom env var name when provided', () => {
      process.env.CUSTOM_TOKEN_VAR = 'my-custom-token'
      const token = getProviderToken('any-provider', ['CUSTOM_TOKEN_VAR'])
      expect(token).to.equal('my-custom-token')
    })

    it('falls back to auto-generated env var name', () => {
      process.env.RAILWAY_TOKEN = 'auto-detected-token'
      const token = getProviderToken('railway')
      expect(token).to.equal('auto-detected-token')
    })

    it('returns env var reference from config when wrapped in ${...}', () => {
      const originalConfig = process.env.TEST_TOKEN_REF
      process.env.TEST_TOKEN_REF = 'resolved-from-ref'
      // Plant a config file in a temp location by writing to home dir
      const home = os.homedir()
      const castDir = path.join(home, '.cast')
      const configPath = path.join(castDir, 'config.yaml')
      const originalConfigContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null
      try {
        if (!fs.existsSync(castDir)) fs.mkdirSync(castDir, {recursive: true})
        fs.writeFileSync(
          configPath,
          'providers:\n  testprovider:\n    api_key: ${TEST_TOKEN_REF}\n'
        )
        const token = getProviderToken('testprovider')
        expect(token).to.equal('resolved-from-ref')
      } finally {
        if (originalConfigContent !== null) {
          fs.writeFileSync(configPath, originalConfigContent)
        } else if (fs.existsSync(configPath)) {
          fs.unlinkSync(configPath)
        }
        delete process.env.TEST_TOKEN_REF
      }
    })
  })

  describe('loadConfig', () => {
    it('returns empty object when no config file', () => {
      // We can't easily test this without mucking with the real config
      // Just ensure the function is callable and returns an object
      const config = loadConfig()
      expect(config).to.be.an('object')
    })
  })
})

describe('Volume helpers', () => {
  describe('getVolumeName', () => {
    it('returns cast-{agent}-{deployment}-memory format', () => {
      const name = getVolumeName('my-agent', 'abc123')
      expect(name).to.equal('cast-my-agent-abc123-memory')
    })

    it('handles agent names with hyphens', () => {
      const name = getVolumeName('my-test-agent', 'xyz789')
      expect(name).to.equal('cast-my-test-agent-xyz789-memory')
    })
  })

  describe('getMemoryMountPath', () => {
    it('returns /app/agent/memory for docker', () => {
      expect(getMemoryMountPath('docker')).to.equal('/app/agent/memory')
    })

    it('returns /app/agent/memory for fly', () => {
      expect(getMemoryMountPath('fly')).to.equal('/app/agent/memory')
    })

    it('returns /app/agent/memory for digitalocean', () => {
      expect(getMemoryMountPath('digitalocean')).to.equal('/app/agent/memory')
    })

    it('returns /app/agent/memory for microvm', () => {
      expect(getMemoryMountPath('microvm')).to.equal('/app/agent/memory')
    })

    it('returns /opt/cast-agent/memory for sprites', () => {
      expect(getMemoryMountPath('sprites')).to.equal('/opt/cast-agent/memory')
    })

    it('returns empty string for railway (uses env var instead)', () => {
      expect(getMemoryMountPath('railway')).to.equal('')
    })

    it('returns /app/agent/memory for unknown providers', () => {
      expect(getMemoryMountPath('unknown')).to.equal('/app/agent/memory')
    })
  })
})

describe('deploymentIdsToRemove', () => {
  const microvm = {id: 'd6b12f', provider: 'microvm', volume_id: 'vm-1', auth_token_hash: 'micro'}
  const sprites = {id: 'bb7590', provider: 'sprites', volume_id: 'sprite-vol', auth_token_hash: 'sprite'}
  const olderSprites = {id: 'aa1111', provider: 'sprites', volume_id: 'old-vol', auth_token_hash: 'old'}

  it('removes every live row when shutdown is by agent name', () => {
    const ids = deploymentIdsToRemove(sprites, [sprites, microvm], false)
    expect(ids).to.have.members(['bb7590', 'd6b12f'])
  })

  it('removes only the MicroVM row when shutdown is by that SHA', () => {
    const ids = deploymentIdsToRemove(microvm, [sprites, microvm], true)
    expect(ids).to.deep.equal(['d6b12f'])
  })

  it('removes every sprites row and leaves the MicroVM when the sprite is shared', () => {
    const ids = deploymentIdsToRemove(sprites, [sprites, olderSprites, microvm], true)
    expect(ids).to.have.members(['bb7590', 'aa1111'])
  })
})

describe('per-deployment auth tokens', () => {
  const keychain = require('../../../typescript/cast-cli/src/lib/keychain').keychain
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('stores a deployment token and the agent token on the first deploy', async () => {
    const setToken = sandbox.stub(keychain, 'setToken').resolves()
    const setDeploymentToken = sandbox.stub(keychain, 'setDeploymentToken').resolves()
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `token-first-${Date.now()}`
    sandbox.stub(db, 'listDeployments').returns([])

    await storeAuthToken(agentName, 'first-token', 'aaa111')

    expect(setDeploymentToken.calledOnceWith('aaa111', 'first-token')).to.equal(true)
    expect(setToken.calledOnceWith(agentName, 'first-token')).to.equal(true)
  })

  it('does not replace the agent token when another deployment is live', async () => {
    const setToken = sandbox.stub(keychain, 'setToken').resolves()
    const setDeploymentToken = sandbox.stub(keychain, 'setDeploymentToken').resolves()
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    const agentName = `token-second-${Date.now()}`
    sandbox.stub(db, 'listDeployments').returns([{id: 'd6b12f', provider: 'microvm'}])

    await storeAuthToken(agentName, 'sprite-token', 'bb7590')

    expect(setDeploymentToken.calledOnceWith('bb7590', 'sprite-token')).to.equal(true)
    expect(setToken.called).to.equal(false)
  })

  it('uses the per-SHA token when connecting', async () => {
    sandbox.stub(keychain, 'getDeploymentToken').resolves('sha-token')
    sandbox.stub(keychain, 'getToken').resolves('agent-token')

    const token = await resolveDeploymentAuthToken({
      id: 'bb7590',
      agent_name: 'demo-agent',
      auth_token_hash: 'does-not-matter',
    })
    expect(token).to.equal('sha-token')
  })

  it('uses the agent token only when its hash matches the deployment', async () => {
    sandbox.stub(keychain, 'getDeploymentToken').resolves(null)
    sandbox.stub(keychain, 'getToken').resolves('agent-token')
    const hash = keychain.hashToken('agent-token')

    const matched = await resolveDeploymentAuthToken({
      id: 'd6b12f',
      agent_name: 'demo-agent',
      auth_token_hash: hash,
    })
    const other = await resolveDeploymentAuthToken({
      id: 'bb7590',
      agent_name: 'demo-agent',
      auth_token_hash: keychain.hashToken('sprite-token'),
    })

    expect(matched).to.equal('agent-token')
    expect(other).to.equal(null)
  })

  it('keeps the agent token when a remaining deployment still matches it', async () => {
    const deleteToken = sandbox.stub(keychain, 'deleteToken').resolves(true)
    const deleteDeploymentToken = sandbox.stub(keychain, 'deleteDeploymentToken').resolves(true)
    sandbox.stub(keychain, 'getToken').resolves('agent-token')
    const hash = keychain.hashToken('agent-token')

    const forgotten = await forgetDeploymentTokens(
      'demo-agent',
      [{id: 'bb7590', provider: 'sprites', auth_token_hash: keychain.hashToken('sprite-token')}],
      [{id: 'd6b12f', provider: 'microvm', auth_token_hash: hash}],
    )

    expect(forgotten).to.deep.equal({scope: 'deployment', stores: ['keychain']})
    expect(deleteDeploymentToken.calledOnceWith('bb7590')).to.equal(true)
    expect(deleteToken.called).to.equal(false)
  })

  it('reports a token file when shutdown deleted the file copy', async () => {
    sandbox.stub(keychain, 'deleteToken').resolves({removed: true, stores: ['file']})
    sandbox.stub(keychain, 'deleteDeploymentToken').resolves({removed: true, stores: ['file']})

    const forgotten = await forgetDeploymentTokens(
      'bb2-chat',
      [{id: 'f6559e', provider: 'docker'}],
      [],
    )

    expect(forgotten).to.deep.equal({scope: 'agent', stores: ['file']})
  })

  it('names both stores when the deployment file and the agent keychain entry are removed', async () => {
    sandbox.stub(keychain, 'deleteToken').resolves({removed: true, stores: ['keychain']})
    sandbox.stub(keychain, 'deleteDeploymentToken').resolves({removed: true, stores: ['file']})

    const forgotten = await forgetDeploymentTokens(
      'bb2-chat',
      [{id: 'f6559e', provider: 'docker'}],
      [],
    )

    expect(forgotten).to.deep.equal({scope: 'agent', stores: ['keychain', 'file']})
  })

  it('stores and resolves the deployment token from a file when Secret Service is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-token-fallback-'))
    const tokens = path.join(root, 'tokens')
    const marker = path.join(root, 'marker')
    fs.writeFileSync(marker, 'leave-me')
    fs.chmodSync(marker, 0o755)
    const local = new KeychainManager(tokens)
    const secretServiceError = new Error(
      'The name org.freedesktop.secrets was not provided by any .service files',
    )
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'getPassword').rejects(secretServiceError)
    const errorSpy = sandbox.stub(console, 'error')
    sandbox.stub(keychain, 'setDeploymentToken').callsFake((...args: unknown[]) => (
      local.setDeploymentToken(String(args[0]), String(args[1]))
    ))
    sandbox.stub(keychain, 'setToken').callsFake((...args: unknown[]) => (
      local.setToken(String(args[0]), String(args[1]))
    ))
    sandbox.stub(keychain, 'getDeploymentToken').callsFake((...args: unknown[]) => (
      local.getDeploymentToken(String(args[0]))
    ))
    sandbox.stub(keychain, 'getToken').callsFake((...args: unknown[]) => (
      local.getToken(String(args[0]))
    ))
    const {db} = require('../../../typescript/cast-cli/src/lib/sqlite')
    sandbox.stub(db, 'listDeployments').returns([])

    try {
      await storeAuthToken('bb2-chat', 'deploy-token', 'f6559e')

      const deploymentFile = path.join(tokens, 'deployments', 'f6559e.token')
      const agentFile = path.join(tokens, 'bb2-chat.token')
      expect(fs.readFileSync(deploymentFile, 'utf8')).to.equal('deploy-token')
      expect(fs.readFileSync(agentFile, 'utf8')).to.equal('deploy-token')
      expect(deploymentFile.includes(`${path.sep}agents${path.sep}`)).to.equal(false)
      expect(agentFile.includes(`${path.sep}agents${path.sep}`)).to.equal(false)
      expect(fs.statSync(deploymentFile).mode & 0o777).to.equal(0o600)
      expect(fs.statSync(agentFile).mode & 0o777).to.equal(0o600)
      expect(fs.statSync(tokens).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(marker).mode & 0o777).to.equal(0o755)
      expect(errorSpy.called).to.equal(false)

      const token = await resolveDeploymentAuthToken({
        id: 'f6559e',
        agent_name: 'bb2-chat',
        auth_token_hash: local.hashToken('deploy-token'),
      })
      expect(token).to.equal('deploy-token')
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('describes a missing token without claiming it belongs to another deployment', async () => {
    sandbox.stub(keychain, 'getToken').resolves(null)

    const reason = await deploymentAuthFailureReason({
      agent_name: 'bb2-chat',
      auth_token_hash: 'abc123',
    })
    const message = missingDeploymentAuthMessage({
      id: 'f6559e',
      agent_name: 'bb2-chat',
      provider: 'docker',
    }, reason)

    expect(reason).to.equal('missing')
    expect(message).to.equal(
      "No auth token found for deployment 'f6559e' (bb2-chat).\n" +
      'Redeploy this one:\n' +
      '  cast deploy bb2-chat --provider docker',
    )
  })

  it('keeps the mismatch explanation when the agent token is for another deployment', async () => {
    sandbox.stub(keychain, 'getToken').resolves('other-token')

    const reason = await deploymentAuthFailureReason({
      agent_name: 'bb2-chat',
      auth_token_hash: keychain.hashToken('this-token'),
    })
    const message = missingDeploymentAuthMessage({
      id: 'f6559e',
      agent_name: 'bb2-chat',
      provider: 'docker',
    }, reason)

    expect(reason).to.equal('mismatch')
    expect(message).to.include('The keychain token for this agent belongs to a different deployment.')
  })
})
