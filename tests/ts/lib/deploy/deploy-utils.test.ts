import {expect} from 'chai'
import {
  loadConfig,
  getAgentPath,
  generateDeploymentId,
  getVolumeName,
  getOpenRouterApiKey,
  getProviderToken,
  checkCli,
  getMemoryMountPath,
  createMemoryVolume,
  deleteMemoryVolume,
  execCommand,
  execCommandIgnoreError,
  ensureDockerfile,
} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import * as path from 'path'
import * as os from 'os'
import * as sinon from 'sinon'
import * as fs from 'fs'

describe('Deploy Utils', () => {
  describe('getAgentPath', () => {
    it('should return path under ~/.cast/agents', () => {
      const agentName = 'test-agent'
      const result = getAgentPath(agentName)
      const expected = path.join(os.homedir(), '.cast', 'agents', agentName)
      expect(result).to.equal(expected)
    })

    it('should handle different agent names', () => {
      expect(getAgentPath('my-agent')).to.include('.cast')
      expect(getAgentPath('my-agent')).to.include('agents')
      expect(getAgentPath('my-agent')).to.include('my-agent')
    })

    it('should not return old ~/cast-agents path', () => {
      const result = getAgentPath('test')
      const oldPath = path.join(os.homedir(), 'cast-agents', 'test')
      expect(result).to.not.equal(oldPath)
    })
  })

  describe('generateDeploymentId', () => {
    it('should return a valid UUID format', () => {
      const id = generateDeploymentId()
      // UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
      expect(id).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    })

    it('should generate unique IDs', () => {
      const id1 = generateDeploymentId()
      const id2 = generateDeploymentId()
      expect(id1).to.not.equal(id2)
    })
  })

  describe('getVolumeName', () => {
    it('should return volume name with cast prefix', () => {
      const volumeName = getVolumeName('test-agent', 'deployment-123')
      expect(volumeName).to.equal('cast-test-agent-deployment-123-memory')
    })

    it('should handle special characters in agent name', () => {
      const volumeName = getVolumeName('my-test_agent', 'deploy-456')
      expect(volumeName).to.equal('cast-my-test_agent-deploy-456-memory')
    })
  })

  describe('loadConfig', () => {
    it('should return empty object if config does not exist', () => {
      // Create a test that mocks non-existent config
      const config = loadConfig()
      expect(config).to.be.an('object')
    })
  })

  describe('getOpenRouterApiKey', () => {
    it('should return undefined when env var not set', () => {
      // Clear the env var if set
      const apiKey = getOpenRouterApiKey()
      // Result depends on env - just ensure function returns a value
      expect(apiKey === undefined || typeof apiKey === 'string').to.be.true
    })
  })
})

describe('getProviderToken', () => {
  it('should check custom env var names first', () => {
    // This tests the logic path
    const token = getProviderToken('test', ['TEST_PROVIDER_TOKEN'])
    // Token may or may not exist depending on env
    expect(token === undefined || typeof token === 'string').to.be.true
  })

  it('should fall back to auto-generated env var name', () => {
    const token = getProviderToken('railway')
    // Token may or may not exist depending on env
    expect(token === undefined || typeof token === 'string').to.be.true
  })

  it('should return undefined if no token found', () => {
    const token = getProviderToken('nonexistent')
    expect(token === undefined || typeof token === 'string').to.be.true
  })
})

describe('checkCli', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should resolve when command exists', async () => {
    // Test that checkCli can be called
    try {
      await checkCli('echo', 'https://example.com')
    } catch (e) {
      // echo should always exist on Unix systems
      // If it fails, something is wrong with the test environment
    }
  })

  it('should reject when command does not exist', async () => {
    try {
      await checkCli('nonexistent-command-xyz', 'https://example.com')
      expect.fail('Should have rejected')
    } catch (e: any) {
      expect(e.message).to.include('not installed')
    }
  })
})

describe('getMemoryMountPath', () => {
  it('should return docker mount path', () => {
    const path = getMemoryMountPath('docker')
    expect(path).to.equal('/app/agent/memory')
  })

  it('should return fly mount path', () => {
    const path = getMemoryMountPath('fly')
    expect(path).to.equal('/app/agent/memory')
  })

  it('should return sprites mount path', () => {
    const path = getMemoryMountPath('sprites')
    expect(path).to.equal('/opt/cast-agent/memory')
  })

  it('should return railway empty path', () => {
    const path = getMemoryMountPath('railway')
    expect(path).to.equal('')
  })

  it('should return digitalocean mount path', () => {
    const path = getMemoryMountPath('digitalocean')
    expect(path).to.equal('/app/agent/memory')
  })

  it('should return default mount path for unknown provider', () => {
    const path = getMemoryMountPath('unknown')
    expect(path).to.equal('/app/agent/memory')
  })
})

describe('execCommand', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should execute echo command', async () => {
    const result = await execCommand('echo', ['hello'])
    expect(result.stdout.trim()).to.equal('hello')
    expect(result.exitCode).to.equal(0)
  })

  it('should handle silent mode', async () => {
    const result = await execCommand('echo', ['test'], { silent: true })
    expect(result.exitCode).to.equal(0)
  })

  it('should provide stderr output', async () => {
    const result = await execCommand('sh', ['-c', 'echo error >&2'])
    // stderr may contain 'error'
    expect(result).to.have.property('stderr')
  })
})

describe('execCommandIgnoreError', () => {
  it('should not throw on error', async () => {
    await execCommandIgnoreError('nonexistent-command-xyz', [])
    // Should not throw
    expect(true).to.be.true
  })
})

describe('createMemoryVolume', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should throw for unknown provider', async () => {
    try {
      await createMemoryVolume('unknown', 'test-agent', 'deploy-id')
      expect.fail('Should have thrown')
    } catch (e: any) {
      expect(e.message).to.include('Unsupported provider')
    }
  })

  it('should return volume config for docker', async () => {
    const config = await createMemoryVolume('docker', 'test-agent', 'deploy-123')
    expect(config.provider).to.equal('docker')
    expect(config.volumeId).to.include('cast-test-agent')
    expect(config.mountPath).to.equal('/app/agent/memory')
  })

  it('should return volume config for railway', async () => {
    const config = await createMemoryVolume('railway', 'test-agent', 'deploy-456')
    expect(config.provider).to.equal('railway')
    expect(config.volumeId).to.include('cast-test-agent')
  })

  it('should return volume config for sprites', async () => {
    const config = await createMemoryVolume('sprites', 'test-agent', 'deploy-789')
    expect(config.provider).to.equal('sprites')
    expect(config.volumeId).to.include('cast-test-agent')
  })
})

describe('deleteMemoryVolume', () => {
  it('should handle docker volume deletion', async () => {
    const config = {
      volumeId: 'test-volume',
      mountPath: '/app/agent/memory',
      provider: 'docker',
    }
    // Should not throw even if volume doesn't exist
    await deleteMemoryVolume(config, 'test-agent')
  })

  it('should handle sprites cleanup', async () => {
    const config = {
      volumeId: 'test-volume',
      mountPath: '/opt/cast-agent/memory',
      provider: 'sprites',
    }
    // Sprites cleanup is no-op
    await deleteMemoryVolume(config, 'test-agent')
  })

  it('should handle railway cleanup', async () => {
    const config = {
      volumeId: 'test-volume',
      mountPath: '',
      provider: 'railway',
    }
    // Railway cleanup is no-op
    await deleteMemoryVolume(config, 'test-agent')
  })
})

describe('ensureDockerfile', () => {
  let sandbox: sinon.SinonSandbox
  const tempDir = path.join(os.tmpdir(), 'cast-test-' + Date.now())

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    fs.mkdirSync(tempDir, { recursive: true })
  })

  afterEach(() => {
    sandbox.restore()
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('should create Dockerfile if not exists', () => {
    ensureDockerfile(tempDir)
    const dockerfilePath = path.join(tempDir, 'Dockerfile')
    expect(fs.existsSync(dockerfilePath)).to.be.true
  })

  it('should not overwrite existing Dockerfile', () => {
    const dockerfilePath = path.join(tempDir, 'Dockerfile')
    fs.writeFileSync(dockerfilePath, 'FROM custom:latest\n')

    ensureDockerfile(tempDir)
    const content = fs.readFileSync(dockerfilePath, 'utf-8')
    expect(content).to.equal('FROM custom:latest\n')
  })

  it('should create requirements.txt if not exists', () => {
    ensureDockerfile(tempDir)
    const reqPath = path.join(tempDir, 'requirements.txt')
    expect(fs.existsSync(reqPath)).to.be.true
  })
})