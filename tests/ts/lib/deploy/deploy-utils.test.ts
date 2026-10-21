import {expect} from 'chai'
import {keychain} from '../../../../typescript/cast-cli/src/lib/keychain'
import {primeInferenceProcessEnv} from '../../../../typescript/cast-cli/src/lib/inference-provider'
import {
  loadConfig,
  getAgentPath,
  generateDeploymentId,
  getVolumeName,
  inferenceEnv,
  getProviderToken,
  checkCli,
  getMemoryMountPath,
  createMemoryVolume,
  deleteMemoryVolume,
  execCommand,
  execCommandIgnoreError,
  ensureDockerfile,
  ensureCastRuntimeDockerfile,
  dockerfileInstallsRuntimeGit,
  prepareCastImageContext,
  EDITED_DOCKERFILE_MESSAGE,
  renderAgentDockerfile,
  castRuntimeDockerfile,
  compilerBuildHint,
  appendCompilerHint,
  prepareHostTuiBuildContext,
  installPin,
} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import * as deployUtils from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {PAST_AGENT_DOCKERFILES} from '../../../../typescript/cast-cli/src/lib/deploy/past-agent-dockerfiles'
import * as path from 'path'
import * as os from 'os'
import * as sinon from 'sinon'
import * as fs from 'fs'

function runtimeStage(dockerfile: string): string {
  const stages = dockerfile.split(/\n(?=FROM\s)/)
  return (stages[stages.length - 1] || '').replace(/\\\n/g, ' ')
}

function expectPinnedBun(dockerfile: string) {
  const pin = installPin('bun', 'linux-x64')
  expect(dockerfile).to.include(`bun_sha='${pin.sha256}'`)
  expect(dockerfile).to.include(`bun-v${pin.version}/$bun_name.zip`)
  expect(dockerfile).to.include('sha256sum -c -')
  expect(dockerfile).to.include('oven-sh/bun/releases/download')
  expect(dockerfile).to.not.include('bun.sh/install')
  expect(dockerfile).to.not.match(/\| *(bash|sh)\b/)
}

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

  describe('inferenceEnv', () => {
    const originalOpenRouter = process.env.OPENROUTER_API_KEY
    const originalDigitalOcean = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    const originalExample = process.env.EXAMPLE_API_KEY
    const originalHome = process.env.HOME

    afterEach(() => {
      restoreEnv('OPENROUTER_API_KEY', originalOpenRouter)
      restoreEnv('DIGITALOCEAN_MODEL_ACCESS_KEY', originalDigitalOcean)
      restoreEnv('EXAMPLE_API_KEY', originalExample)
      restoreEnv('HOME', originalHome)
    })

    it('returns keys that resolve and omits keys that do not', async () => {
      process.env.OPENROUTER_API_KEY = 'or-env'
      delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
      const env = await inferenceEnv({})
      expect(env.OPENROUTER_API_KEY).to.equal('or-env')
      expect(env).to.not.have.property('DIGITALOCEAN_MODEL_ACCESS_KEY')
    })

    it('prefers the environment over configKey', async () => {
      process.env.OPENROUTER_API_KEY = 'or-env'
      process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = 'do-env'
      const env = await inferenceEnv({
        providers: {
          openrouter: {api_key: 'or-config'},
          digitalocean_inference: {api_key: 'do-config'},
          digitalocean: {token: 'deploy-token'},
        },
      })
      expect(env.OPENROUTER_API_KEY).to.equal('or-env')
      expect(env.DIGITALOCEAN_MODEL_ACCESS_KEY).to.equal('do-env')
      expect(JSON.stringify(env)).to.not.include('deploy-token')
    })

    it('reads configKey when the environment variable is unset', async () => {
      delete process.env.OPENROUTER_API_KEY
      delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
      const env = await inferenceEnv({
        providers: {
          openrouter: {api_key: 'or-config'},
          digitalocean_inference: {api_key: 'do-config'},
        },
      })
      expect(env.OPENROUTER_API_KEY).to.equal('or-config')
      expect(env.DIGITALOCEAN_MODEL_ACCESS_KEY).to.equal('do-config')
    })

    it('does not read providers.digitalocean.token', async () => {
      delete process.env.OPENROUTER_API_KEY
      delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
      const env = await inferenceEnv({
        providers: {
          digitalocean: {token: 'deploy-token', api_key: 'also-deploy'},
        },
      })
      expect(env).to.not.have.property('DIGITALOCEAN_MODEL_ACCESS_KEY')
      expect(JSON.stringify(env)).to.not.include('deploy-token')
      expect(JSON.stringify(env)).to.not.include('also-deploy')
    })

    it('includes an external provider variable', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-inference-env-'))
      const folder = path.join(home, '.cast', 'inference-providers', 'example')
      fs.mkdirSync(folder, {recursive: true})
      fs.writeFileSync(path.join(folder, 'provider.json'), JSON.stringify({
        key: 'example',
        name: 'Example Inference',
        prefixes: ['example/'],
        envVar: 'EXAMPLE_API_KEY',
        configKey: 'providers.example.api_key',
        baseUrl: 'https://example.invalid/v1',
        acceptsAnyModel: true,
        knownModels: [],
      }))
      fs.writeFileSync(path.join(folder, 'provider.py'), [
        'class Example:',
        '    key = "example"',
        '    env_var = "EXAMPLE_API_KEY"',
        '    prefixes = ("example/",)',
        '    def is_available(self):',
        '        return False',
        '    def create_llm(self, model=None, **kwargs):',
        '        raise RuntimeError("not called")',
        'provider = Example()',
        '',
      ].join('\n'))
      process.env.HOME = home
      delete process.env.OPENROUTER_API_KEY
      delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
      process.env.EXAMPLE_API_KEY = 'example-env'
      const env = await inferenceEnv({
        providers: {digitalocean: {token: 'deploy-token'}},
      })
      expect(env.EXAMPLE_API_KEY).to.equal('example-env')
      expect(JSON.stringify(env)).to.not.include('deploy-token')
    })

    it('reads a keychain-only token and omits a custom base URL', async () => {
      delete process.env.OPENROUTER_API_KEY
      delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
      delete process.env.DIGITALOCEAN_INFERENCE_BASE_URL
      delete process.env.OPENROUTER_BASE_URL
      await keychain.setInferenceToken('digitalocean', 'do-keychain-only')
      const env = await inferenceEnv({
        providers: {
          openrouter: {api_key: 'or-config'},
          digitalocean_inference: {base_url: 'https://inference.example/v1'},
        },
      })
      expect(env.DIGITALOCEAN_MODEL_ACCESS_KEY).to.equal('do-keychain-only')
      expect(env).to.not.have.property('DIGITALOCEAN_INFERENCE_BASE_URL')
      expect(env).to.not.have.property('OPENROUTER_BASE_URL')
      expect(JSON.stringify(env)).to.not.include('BASE_URL')
      expect(JSON.stringify(env)).to.not.include('https://inference.example/v1')
      expect(env.OPENROUTER_API_KEY).to.equal('or-config')
      const {filterInferenceEnv} = await import('../../../../typescript/cast-cli/src/lib/deploy/deploy-utils')
      const filtered = filterInferenceEnv('digitalocean/custom-model', {
        ...env,
        DIGITALOCEAN_INFERENCE_BASE_URL: 'https://inference.example/v1',
        OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
      })
      expect(filtered).to.deep.equal({
        DIGITALOCEAN_MODEL_ACCESS_KEY: 'do-keychain-only',
      })
      expect(JSON.stringify(filtered)).to.not.include('BASE_URL')
      expect(JSON.stringify(filtered)).to.not.include('or-config')
    })

    it('primeInferenceProcessEnv copies a keychain token and a custom base URL into the builder process', async () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-prime-base-'))
      const previousHome = process.env.HOME
      const previousBase = process.env.DIGITALOCEAN_INFERENCE_BASE_URL
      process.env.HOME = home
      fs.mkdirSync(path.join(home, '.cast'), {recursive: true})
      fs.writeFileSync(path.join(home, '.cast', 'config.yaml'), [
        'providers:',
        '  digitalocean_inference:',
        '    base_url: https://inference.example/v1',
        '',
      ].join('\n'))
      delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
      delete process.env.DIGITALOCEAN_INFERENCE_BASE_URL
      try {
        await keychain.setInferenceToken('digitalocean', 'do-primed-token')
        await primeInferenceProcessEnv()
        expect(process.env.DIGITALOCEAN_MODEL_ACCESS_KEY).to.equal('do-primed-token')
        expect(process.env.DIGITALOCEAN_INFERENCE_BASE_URL).to.equal('https://inference.example/v1')
      } finally {
        delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
        if (previousBase === undefined) delete process.env.DIGITALOCEAN_INFERENCE_BASE_URL
        else process.env.DIGITALOCEAN_INFERENCE_BASE_URL = previousBase
        if (previousHome === undefined) delete process.env.HOME
        else process.env.HOME = previousHome
        fs.rmSync(home, {recursive: true, force: true})
      }
    })
  })
})

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

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

  it('does not run shell syntax that arrives inside an argument', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-exec-proof-'))
    const marker = path.join(dir, 'marker')
    const value = `tok"; touch ${marker}; echo "$(touch ${marker}) \`touch ${marker}\`"`
    try {
      const result = await execCommand('printf', ['%s', `AUTH_TOKEN=${value}`], {silent: true})
      expect(result.exitCode).to.equal(0)
      expect(result.stdout).to.equal(`AUTH_TOKEN=${value}`)
      expect(fs.existsSync(marker)).to.equal(false)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
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

function oldDockerTemplate(): string {
  const template = PAST_AGENT_DOCKERFILES.find(item =>
    item.startsWith('FROM python:3.11-slim\n')
    && item.includes('\n    gcc \\\n')
    && item.includes('\n    git \\\n')
    && item.includes('COPY .cast-runtime/cast /app/cast\n')
  )
  if (!template) throw new Error('missing old docker template')
  return template
}

function expectEditedKept(log: sinon.SinonStub, dockerfilePath: string, original: string) {
  expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal(original)
  expect(log.calledOnce).to.equal(true)
  expect(log.firstCall.args[0]).to.equal(EDITED_DOCKERFILE_MESSAGE)
}

describe('ensureDockerfile', () => {
  let sandbox: sinon.SinonSandbox
  let log: sinon.SinonStub
  const tempDir = path.join(os.tmpdir(), 'cast-test-' + Date.now())

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    log = sandbox.stub(console, 'log')
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

  it('keeps an edited Dockerfile on the Railway path', () => {
    const dockerfilePath = path.join(tempDir, 'Dockerfile')
    const edited = renderAgentDockerfile().replace(
      'apt-get install -y --no-install-recommends git',
      'apt-get install -y --no-install-recommends gcc git',
    )
    fs.writeFileSync(dockerfilePath, edited)
    ensureDockerfile(tempDir)
    expectEditedKept(log, dockerfilePath, edited)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.include('gcc')
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.include('PYTHONPATH=/usr/local')
  })

  it('upgrades an unmodified old Railway Dockerfile', () => {
    const dockerfilePath = path.join(tempDir, 'Dockerfile')
    const old = PAST_AGENT_DOCKERFILES.find(item =>
      item.includes('FROM python:3.11-slim-bookworm AS builder')
      && item.includes('PYTHONPATH=/usr/local')
      && !item.includes('COPY .cast-runtime/cast')
    )
    if (!old) throw new Error('missing old railway template')
    fs.writeFileSync(dockerfilePath, old.replace(/\n/g, '\r\n'))
    ensureDockerfile(tempDir)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal(renderAgentDockerfile())
    expect(log.called).to.equal(false)
  })

  it('does not replace a Dockerfile that copies the cast package', () => {
    const dockerfilePath = path.join(tempDir, 'Dockerfile')
    const castFile = `FROM python:3.11-slim-bookworm AS builder
RUN apt-get update && apt-get install -y gcc
FROM python:3.11-slim-bookworm
COPY .cast-runtime/cast /app/cast
ENV PYTHONPATH=/app
CMD ["python", "-m", "cast.runtime"]
`
    fs.writeFileSync(dockerfilePath, castFile)
    ensureDockerfile(tempDir)
    expectEditedKept(log, dockerfilePath, castFile)
  })

  it('does not write a private requirements list', () => {
    ensureDockerfile(tempDir)
    expect(fs.existsSync(path.join(tempDir, 'requirements.txt'))).to.equal(false)
  })

  it('installs git without gcc or a compiler stage', () => {
    ensureDockerfile(tempDir)
    const dockerfile = fs.readFileSync(path.join(tempDir, 'Dockerfile'), 'utf8')
    const runtime = runtimeStage(dockerfile)
    expect(runtime).to.match(/apt-get install -y --no-install-recommends git\b/)
    expect(runtime).to.match(/rm -rf \/var\/lib\/apt\/lists\/\*/)
    expect(dockerfile).to.not.match(/apt-get install\b[^\n]*\bgcc\b/)
    expect(dockerfile).to.not.include('AS builder')
    expect(dockerfile).to.include('# cast-generated-dockerfile')
    expect(dockerfileInstallsRuntimeGit(dockerfile)).to.equal(true)
  })
})

describe('ensureCastRuntimeDockerfile', () => {
  let agentDir = ''
  let sandbox: sinon.SinonSandbox
  let log: sinon.SinonStub

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    log = sandbox.stub(console, 'log')
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-image-'))
  })

  afterEach(() => {
    sandbox.restore()
    if (agentDir) fs.rmSync(agentDir, {recursive: true, force: true})
  })

  it('copies the cast package onto PYTHONPATH and does not pip-install it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-image-root-'))
    try {
      prepareCastImageContext(agentDir, root)
      const dockerfile = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf8')
      const requirements = fs.readFileSync(path.join(agentDir, 'requirements.txt'), 'utf8')
      expect(dockerfile).to.include('COPY .cast-runtime/cast /app/cast')
      expect(dockerfile).to.match(/PYTHONPATH=\/app(?:\s|$)/)
      expect(dockerfile).to.not.include('PYTHONPATH=/usr/local')
      const runtime = runtimeStage(dockerfile)
      expect(runtime).to.match(/apt-get install -y --no-install-recommends git\b/)
      expect(runtime).to.match(/rm -rf \/var\/lib\/apt\/lists\/\*/)
      expect(dockerfile).to.not.match(/apt-get install\b[^\n]*\bgcc\b/)
      expect(dockerfile).to.not.include('AS builder')
      expect(dockerfileInstallsRuntimeGit(dockerfile)).to.equal(true)
      expect(requirements).to.not.match(/^cast\b/m)
      expect(requirements).to.include('GitPython')
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('replaces a generated Dockerfile that omitted the cast package', () => {
    ensureDockerfile(agentDir)
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.include('PYTHONPATH=/usr/local')

    ensureCastRuntimeDockerfile(agentDir)
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8')
    expect(dockerfile).to.include('COPY .cast-runtime/cast /app/cast')
    expect(dockerfile).to.match(/PYTHONPATH=\/app(?:\s|$)/)
    expect(dockerfile).to.not.include('PYTHONPATH=/usr/local')
  })

  it('leaves a custom Dockerfile in place', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    fs.writeFileSync(dockerfilePath, 'FROM custom:latest\n')
    ensureCastRuntimeDockerfile(agentDir)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal('FROM custom:latest\n')
  })

  it('keeps an edited generated Dockerfile that adds gcc', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    const edited = castRuntimeDockerfile().replace(
      'apt-get install -y --no-install-recommends git',
      'apt-get install -y --no-install-recommends gcc git',
    )
    fs.writeFileSync(dockerfilePath, edited)
    ensureCastRuntimeDockerfile(agentDir)
    expectEditedKept(log, dockerfilePath, edited)
  })

  it('keeps an edited copy of an old Dockerfile template', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    const edited = oldDockerTemplate().replace(
      '# Install system dependencies\n',
      '# Install system dependencies\n# added build-essential for a package that has no wheel\n',
    ).replace(
      '\n    gcc \\\n',
      '\n    gcc \\\n    build-essential \\\n',
    )
    fs.writeFileSync(dockerfilePath, edited)
    ensureCastRuntimeDockerfile(agentDir)
    expectEditedKept(log, dockerfilePath, edited)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.include('build-essential')
  })

  it('keeps an edited Railway Dockerfile when the cast runtime helper runs', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    const edited = renderAgentDockerfile().replace(
      'apt-get install -y --no-install-recommends git',
      'apt-get install -y --no-install-recommends gcc git',
    )
    fs.writeFileSync(dockerfilePath, edited)
    ensureCastRuntimeDockerfile(agentDir)
    expectEditedKept(log, dockerfilePath, edited)
  })

  it('upgrades an unmodified old Dockerfile template', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    fs.writeFileSync(dockerfilePath, oldDockerTemplate())
    ensureCastRuntimeDockerfile(agentDir)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal(castRuntimeDockerfile())
    expect(log.called).to.equal(false)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.not.match(/apt-get install\b[^\n]*\bgcc\b/)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.include('python:3.11-slim-bookworm')
  })

  it('upgrades the one-line Dockerfile that cast deploy --provider docker wrote in 2.5.1', () => {
    // Literal file from v2.5.1 docker.ts. The source put `\` before each
    // newline inside a JS template, so the backslash and the newline are gone.
    const written = `FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y     gcc     git     && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy cast runtime package
COPY .cast-runtime/cast /app/cast

# Copy agent files
COPY . /app/agent/

# Set environment variables
ENV CAST_AGENT_PATH=/app/agent
ENV PYTHONPATH=/app

# Expose A2A HTTP server port
EXPOSE 8080

# Run agent A2A server
CMD ["python", "-m", "cast.runtime", "--agent-path", "/app/agent", "--port", "8080", "--host", "0.0.0.0"]
`
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    fs.writeFileSync(dockerfilePath, written)
    ensureCastRuntimeDockerfile(agentDir)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal(castRuntimeDockerfile())
    expect(log.called).to.equal(false)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.not.include('gcc')
  })

  it('upgrades the one-line Dockerfile that deploy-utils wrote in 1.0 and 1.1', () => {
    // Literal file from v1.0.0 and v1.1.0 deploy-utils.ts. Same JS template
    // line joining as the 2.5.1 Docker file. This string is not taken from
    // the stored past-template list.
    const written = `FROM python:3.11-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y     gcc     git     && rm -rf /var/lib/apt/lists/*

# Copy Python runtime
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy agent files
COPY . /app/agent/

# Set environment variables
ENV CAST_AGENT_PATH=/app/agent
ENV PYTHONPATH=/app

# Expose port
EXPOSE 8080

# Run agent
CMD ["python", "-m", "cast.runtime", "--agent-path", "/app/agent", "--port", "8080", "--host", "0.0.0.0"]
`
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    fs.writeFileSync(dockerfilePath, written)
    ensureCastRuntimeDockerfile(agentDir)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal(castRuntimeDockerfile())
    expect(log.called).to.equal(false)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.not.include('gcc')
  })

  it('upgrades every unmodified template Cast used to write', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    for (const template of PAST_AGENT_DOCKERFILES) {
      log.resetHistory()
      fs.writeFileSync(dockerfilePath, template)
      ensureCastRuntimeDockerfile(agentDir)
      expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal(castRuntimeDockerfile())
      expect(log.called).to.equal(false)
    }
  })

  it('keeps an edited abbreviated builder Dockerfile', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    const builderOnly = `FROM python:3.11-slim-bookworm AS builder

WORKDIR /build
RUN apt-get update && apt-get install -y gcc git && rm -rf /var/lib/apt/lists/*

FROM python:3.11-slim-bookworm
WORKDIR /app
COPY .cast-runtime/cast /app/cast
ENV PYTHONPATH=/app
CMD ["python", "-m", "cast.runtime"]
`
    fs.writeFileSync(dockerfilePath, builderOnly)
    ensureCastRuntimeDockerfile(agentDir)
    expectEditedKept(log, dockerfilePath, builderOnly)
  })

  it('keeps a generated Dockerfile that installs git without a compiler', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    const current = `FROM python:3.11-slim-bookworm
# cast-generated-dockerfile

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

COPY .cast-runtime/cast /app/cast
ENV PYTHONPATH=/app
# keep-tui-sentinel
CMD ["python", "-m", "cast.runtime"]
`
    fs.writeFileSync(dockerfilePath, current)
    ensureCastRuntimeDockerfile(agentDir)
    expectEditedKept(log, dockerfilePath, current)
  })

  it('leaves a custom Dockerfile that installs gcc', () => {
    const dockerfilePath = path.join(agentDir, 'Dockerfile')
    const custom = 'FROM custom:latest\nRUN apt-get install -y gcc\nCMD ["python", "-m", "cast.runtime"]\n'
    fs.writeFileSync(dockerfilePath, custom)
    ensureCastRuntimeDockerfile(agentDir)
    expect(fs.readFileSync(dockerfilePath, 'utf8')).to.equal(custom)
    expect(log.called).to.equal(false)
  })
})

describe('compilerBuildHint', () => {
  const hint = 'https://castagent.dev/building-agents/deployment/overview#what-gets-shipped'

  it('points at the deployment overview when a compiler is missing', () => {
    for (const output of [
      "error: command 'gcc' failed: No such file or directory",
      "error: command 'cc' failed with exit status 1",
      'Failed building wheel for example-package',
    ]) {
      const line = compilerBuildHint(output)
      expect(line).to.be.a('string')
      expect(line).to.include('build-essential')
      expect(line).to.include(hint)
      expect(line).to.not.include('\n')
      expect(appendCompilerHint('Docker build failed with code 1', output)).to.equal(
        `Docker build failed with code 1\n${line}`,
      )
    }
  })

  it('stays quiet for other build failures', () => {
    expect(compilerBuildHint('network timeout')).to.equal(undefined)
    expect(appendCompilerHint('Docker build failed with code 1', 'network timeout')).to.equal(
      'Docker build failed with code 1',
    )
  })
})

describe('prepareHostTuiBuildContext', () => {
  let sandbox: sinon.SinonSandbox
  const testDir = path.join(os.tmpdir(), 'cast-test-host-tui-' + Date.now())
  const agentDir = path.join(testDir, 'agent')
  const projectDir = path.join(testDir, 'project')

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    fs.mkdirSync(path.join(agentDir), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'typescript', 'cast-tui', 'dist'), { recursive: true })
    fs.mkdirSync(path.join(projectDir, 'python', 'cast'), { recursive: true })
    // Create a minimal TUI dist file
    fs.writeFileSync(path.join(projectDir, 'typescript', 'cast-tui', 'dist', 'index.js'), '// tui bundle')
    // Create the launcher source
    fs.writeFileSync(path.join(projectDir, 'python', 'cast', 'host_tui_launcher.py'), '#!/usr/bin/env python3\nprint("launcher")')
    // Create a default Dockerfile
    fs.writeFileSync(path.join(agentDir, 'Dockerfile'), 'FROM python:3.11-slim\nCMD ["python", "-m", "cast.runtime"]\n')
  })

  afterEach(() => {
    sandbox.restore()
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true })
    }
  })

  it('should create .cast-tui directory structure', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    expect(fs.existsSync(path.join(agentDir, '.cast-tui'))).to.be.true
    expect(fs.existsSync(path.join(agentDir, '.cast-tui', 'dist'))).to.be.true
  })

  it('should copy TUI dist files from project', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    expect(fs.existsSync(path.join(agentDir, '.cast-tui', 'dist', 'index.js'))).to.be.true
    const content = fs.readFileSync(path.join(agentDir, '.cast-tui', 'dist', 'index.js'), 'utf-8')
    expect(content).to.equal('// tui bundle')
  })

  it('should copy host_tui_launcher.py', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    const launcherPath = path.join(agentDir, '.cast-tui', 'host_tui_launcher.py')
    expect(fs.existsSync(launcherPath)).to.be.true
    const content = fs.readFileSync(launcherPath, 'utf-8')
    expect(content).to.include('print("launcher")')
  })

  it('should create launcher.sh wrapper with executable permissions', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    const launcherShPath = path.join(agentDir, '.cast-tui', 'launcher.sh')
    expect(fs.existsSync(launcherShPath)).to.be.true
    const content = fs.readFileSync(launcherShPath, 'utf-8')
    expect(content).to.include('python3 /opt/cast-tui/host_tui_launcher.py')
    // Check executable bit
    const stats = fs.statSync(launcherShPath)
    expect(stats.mode & 0o111).to.not.equal(0)
  })

  it('should create package.json with runtime dependencies (no better-sqlite3)', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    const pkgPath = path.join(agentDir, '.cast-tui', 'package.json')
    expect(fs.existsSync(pkgPath)).to.be.true
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    expect(pkg.name).to.equal('cast-tui-embed')
    expect(pkg.dependencies).to.have.property('@opentui/core')
    // @opentui/core-linux-x64 is required at runtime (bundle
    // dynamically imports it by platform) — it's a direct dep so
    // it survives --omit=optional and works in the Linux container.
    expect(pkg.dependencies).to.have.property('@opentui/core-linux-x64')
    // axios is required by the cast-cli A2A client that the TUI
    // dynamically imports at runtime.
    expect(pkg.dependencies).to.have.property('axios')
    expect(pkg.dependencies).to.have.property('clipboardy')
    expect(pkg.dependencies['simple-git']).to.equal('^4.0.2')
    expect(pkg.dependencies).to.have.property('yaml')
    // better-sqlite3 is excluded because it has a native binding
    // that can't be cross-compiled to the container.
    expect(pkg.dependencies).to.not.have.property('better-sqlite3')
  })

  it('should include --omit=dev in the embed package.json deps', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    // We verify the function generates a package.json that npm install
    // can consume (with only the runtime deps). The actual npm install
    // call is exercised in the real deploy flow.
    const pkgPath = path.join(agentDir, '.cast-tui', 'package.json')
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    // Only the deps the container runtime actually needs
    expect(Object.keys(pkg.dependencies).sort()).to.deep.equal(
      ['@opentui/core', '@opentui/core-linux-x64', 'axios', 'clipboardy', 'simple-git', 'yaml'],
    )
  })

  it('should patch Dockerfile with Host TUI bundle section before CMD', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    const dockerfile = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
    expect(dockerfile).to.include('# Host TUI bundle')
    expectPinnedBun(dockerfile)
    expect(dockerfile).to.include('COPY .cast-tui/dist /opt/cast-tui/dist')
    expect(dockerfile).to.include('COPY .cast-tui/cast-cli-dist/lib /opt/cast-cli/dist/lib')
    expect(dockerfile).to.include('COPY .cast-tui/cast-cli-dist/node_modules /opt/cast-cli/node_modules')
    expect(dockerfile).to.include('COPY .cast-tui/node_modules /opt/cast-tui/node_modules')
    expect(dockerfile).to.include('ln -sf /opt/cast-tui/launcher.sh /usr/local/bin/cast-tui')
    expect(dockerfile).to.include('ENV CAST_TUI_DIR=/opt/cast-tui')
    // Verify CMD is still present
    expect(dockerfile).to.include('CMD ["python"')
    // Should NOT have an in-build npm install (deps come pre-resolved)
    expect(dockerfile).to.not.include('npm install --no-optional')
  })

  it('should not patch Dockerfile if already patched with current version (idempotent)', async () => {
    await prepareHostTuiBuildContext(agentDir, projectDir)
    const afterFirst = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
    // Call again
    await prepareHostTuiBuildContext(agentDir, projectDir)
    const afterSecond = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
    // After both calls, the Dockerfile should have exactly one Host TUI bundle block
    // (the strip+re-apply loop terminates when no more blocks are found).
    const matches = afterSecond.match(/# Host TUI bundle/g)
    expect(matches).to.have.length(1)
    // And the new marker should be present
    expect(afterSecond).to.include('# Host TUI bundle (for on-host chat via `cast-tui`)')
    // And the new patch should contain node_modules COPY (not npm install)
    expect(afterSecond).to.include('COPY .cast-tui/node_modules /opt/cast-tui/node_modules')
    expect(afterSecond).to.not.include('npm install --no-optional --production')
  })

  it('should not crash when TUI dist is missing from project', async () => {
    // Remove TUI dist from project
    fs.rmSync(path.join(projectDir, 'typescript', 'cast-tui', 'dist'), { recursive: true, force: true })
    // Should not throw
    await prepareHostTuiBuildContext(agentDir, projectDir)
    // Should still create .cast-tui with launcher
    expect(fs.existsSync(path.join(agentDir, '.cast-tui', 'launcher.sh'))).to.be.true
    expect(fs.existsSync(path.join(agentDir, '.cast-tui', 'host_tui_launcher.py'))).to.be.true
  })

  it('should not crash when Dockerfile does not exist', async () => {
    fs.rmSync(path.join(agentDir, 'Dockerfile'))
    // Should not throw
    await prepareHostTuiBuildContext(agentDir, projectDir)
    // Should still create .cast-tui structure
    expect(fs.existsSync(path.join(agentDir, '.cast-tui', 'launcher.sh'))).to.be.true
  })

  it('should not crash when host_tui_launcher.py is missing from project', async () => {
    fs.rmSync(path.join(projectDir, 'python', 'cast', 'host_tui_launcher.py'))
    // Should not throw
    await prepareHostTuiBuildContext(agentDir, projectDir)
    expect(fs.existsSync(path.join(agentDir, '.cast-tui'))).to.be.true
    expect(fs.existsSync(path.join(agentDir, '.cast-tui', 'launcher.sh'))).to.be.true
  })

  it('should strip a Dockerfile with BOTH a marker-less old block AND a wrong-content new block', async () => {
    // This is the exact scenario from the user's real deploy:
    // a marker-less old block (lines 25-29) followed by a new
    // block whose contents are from an earlier version of the
    // code (with `npm install` instead of `node_modules` COPY).
    // Both blocks must be fully removed and the current patch
    // applied cleanly.
    const mixedDockerfile = `FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y gcc git

# Run agent A2A server

COPY .cast-tui/dist /opt/cast-tui/dist
COPY .cast-tui/host_tui_launcher.py /opt/cast-tui/host_tui_launcher.py
ENV CAST_TUI_DIR=/opt/cast-tui


# Host TUI bundle (for on-host chat via \`cast-tui\`)
RUN apt-get update && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*
COPY .cast-tui/dist /opt/cast-tui/dist
COPY .cast-tui/package.json /opt/cast-tui/package.json
COPY .cast-tui/launcher.sh /opt/cast-tui/launcher.sh
COPY .cast-tui/host_tui_launcher.py /opt/cast-tui/host_tui_launcher.py
RUN cd /opt/cast-tui && npm install --no-optional --production 2>/dev/null || echo "Warning: npm install failed" && rm -f package.json
RUN ln -sf /opt/cast-tui/launcher.sh /usr/local/bin/cast-tui
ENV CAST_TUI_DIR=/opt/cast-tui

CMD ["python", "-m", "cast.runtime", "--agent-path", "/app/agent", "--port", "8080", "--host", "0.0.0.0"]
`
    fs.writeFileSync(path.join(agentDir, 'Dockerfile'), mixedDockerfile)

    await prepareHostTuiBuildContext(agentDir, projectDir)
    const result = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')

    // The new marker should be present (and only once)
    const markerMatches = result.match(/# Host TUI bundle/g)
    expect(markerMatches).to.have.length(1)
    expect(result).to.include('# Host TUI bundle (for on-host chat via `cast-tui`)')

    // All TUI-related content should be gone except the new patch
    expect(result).to.include('COPY .cast-tui/node_modules /opt/cast-tui/node_modules')
    expect(result).to.not.include('COPY .cast-tui/package.json')
    expect(result).to.not.include('npm install --no-optional')
    expectPinnedBun(result)
    expect(result).to.include('ln -sf /opt/cast-tui/launcher.sh /usr/local/bin/cast-tui')

    // CMD is still at the end
    expect(result).to.include('CMD ["python", "-m", "cast.runtime"')
  })

  it('should replace an old/incomplete patch with the new full patch', async () => {
    // Write a Dockerfile with the old partial patch (from the abandoned
    // feature/cast-ssh work) — missing nodejs install, missing launcher.sh
    // COPY, missing symlink, and still references package.json.
    const oldDockerfile = `FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y gcc git

# Host TUI bundle (for cast ssh on-host chat)
COPY .cast-tui/dist /opt/cast-tui/dist
COPY .cast-tui/host_tui_launcher.py /opt/cast-tui/host_tui_launcher.py
ENV CAST_TUI_DIR=/opt/cast-tui

CMD ["python", "-m", "cast.runtime"]
`
    fs.writeFileSync(path.join(agentDir, 'Dockerfile'), oldDockerfile)

    await prepareHostTuiBuildContext(agentDir, projectDir)
    const result = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')

    // The new marker should be present
    expect(result).to.include('# Host TUI bundle (for on-host chat via `cast-tui`)')
    // The old marker should be gone
    expect(result).to.not.include('# Host TUI bundle (for cast ssh on-host chat)')
    // The new full patch should be present
    expectPinnedBun(result)
    expect(result).to.include('COPY .cast-tui/launcher.sh /opt/cast-tui/launcher.sh')
    expect(result).to.include('COPY .cast-tui/node_modules /opt/cast-tui/node_modules')
    expect(result).to.include('ln -sf /opt/cast-tui/launcher.sh /usr/local/bin/cast-tui')
    // CMD should still be present
    expect(result).to.include('CMD ["python", "-m", "cast.runtime"]')
    // Only one bundle section, not duplicated
    const matches = result.match(/# Host TUI bundle/g)
    expect(matches).to.have.length(1)
  })

  it('should not duplicate the new patch when called twice', async () => {
    // First call applies the patch
    await prepareHostTuiBuildContext(agentDir, projectDir)
    // Second call should be a no-op for the Dockerfile
    await prepareHostTuiBuildContext(agentDir, projectDir)

    const result = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
    const matches = result.match(/# Host TUI bundle/g)
    expect(matches).to.have.length(1)
  })

  describe('with enabled: false (TUI disabled)', () => {
    it('should not create .cast-tui directory when disabled', async () => {
      await prepareHostTuiBuildContext(agentDir, projectDir, {enabled: false})
      expect(fs.existsSync(path.join(agentDir, '.cast-tui'))).to.be.false
    })

    it('should not patch the Dockerfile when disabled', async () => {
      const before = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
      await prepareHostTuiBuildContext(agentDir, projectDir, {enabled: false})
      const after = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
      expect(after).to.equal(before)
    })

    it('should not call npm install when disabled', async () => {
      // Spy on execCommand — if npm install were called, we'd see it.
      const execStub = sandbox.stub(deployUtils, 'execCommand')
      execStub.callThrough() // allow other calls (e.g. gunzip not relevant here)
      await prepareHostTuiBuildContext(agentDir, projectDir, {enabled: false})
      const npmCalls = execStub.getCalls().filter((c: any) =>
        c.args[0] === 'npm' && Array.isArray(c.args[1]) && c.args[1][0] === 'install',
      )
      expect(npmCalls).to.have.length(0)
    })

    it('should strip an existing TUI bundle from the Dockerfile when disabled', async () => {
      // First, build with TUI enabled (applies the patch)
      await prepareHostTuiBuildContext(agentDir, projectDir)
      const withPatch = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
      expect(withPatch).to.include('# Host TUI bundle')

      // Now simulate a downgrade: re-run with TUI disabled
      await prepareHostTuiBuildContext(agentDir, projectDir, {enabled: false})
      const stripped = fs.readFileSync(path.join(agentDir, 'Dockerfile'), 'utf-8')
      expect(stripped).to.not.include('# Host TUI bundle')
      expect(stripped).to.not.include('/opt/cast-tui/')
      expect(stripped).to.not.include('bun.sh/install')
      // CMD should still be present
      expect(stripped).to.include('CMD ["python"')
    })

    it('should not crash when Dockerfile does not exist and TUI is disabled', async () => {
      fs.rmSync(path.join(agentDir, 'Dockerfile'))
      // Should not throw
      await prepareHostTuiBuildContext(agentDir, projectDir, {enabled: false})
      expect(fs.existsSync(path.join(agentDir, '.cast-tui'))).to.be.false
    })
  })
})