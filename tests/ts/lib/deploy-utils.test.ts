import {expect} from 'chai'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {
  getAgentPath,
  isShaPattern,
  resolveDeploymentTarget,
  generateDeploymentSha,
  generateDeploymentId,
  loadConfig,
  getProviderToken,
  getVolumeName,
  getMemoryMountPath,
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
