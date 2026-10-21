import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {dockerContainerEnv, dockerContainerRunArgs} from '../../../../typescript/cast-cli/src/lib/deploy/docker'
import {
  ollamaContainerBaseUrl,
  ollamaDeployRefusal,
  ollamaDockerEnvFromBase,
  ollamaLinuxDockerHint,
  prepareOllamaDocker,
} from '../../../../typescript/cast-cli/src/lib/deploy/ollama'

const CLOUD_KEY = 'ollama-cloud-key-0123456789'

describe('ollama deploy target', () => {
  for (const provider of ['fly', 'railway', 'sprites', 'digitalocean', 'microvm', 'custom-cloud']) {
    it(`refuses ${provider}`, () => {
      const message = ollamaDeployRefusal(provider, 'ollama/qwen3', 'http://127.0.0.1:11434/v1')
      expect(message).to.be.a('string')
      expect(message).to.include('Refusing to deploy ollama/qwen3')
      expect(message).to.include(provider)
      expect(message).to.include('cannot reach Ollama')
      expect(message).to.include('OLLAMA_BASE_URL')
      expect(message).to.include('OLLAMA_API_KEY')
      expect(message).to.include('host.docker.internal')
      expect(message).to.not.include(CLOUD_KEY)
    })
  }

  it('allows a non-ollama model on a remote host', () => {
    expect(ollamaDeployRefusal('fly', 'openai-api/gpt-4o', 'https://ollama.com/v1')).to.equal(null)
  })

  it('allows the local provider without copying a base URL', () => {
    expect(ollamaDeployRefusal('local', 'ollama/llama3.1', 'https://ollama.com/v1')).to.equal(null)
  })

  it('allows docker when the builder URL is loopback', () => {
    expect(ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://localhost:11434/v1')).to.equal(null)
    expect(ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://127.0.0.1:11435/v1')).to.equal(null)
    expect(ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://127.4.5.6:11434/v1')).to.equal(null)
    expect(ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://localhost.:11434/v1')).to.equal(null)
    expect(ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://[::1]:11434/v1')).to.equal(null)
    expect(ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://[::ffff:127.0.0.1]:11434/v1')).to.equal(null)
    expect(ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://[::ffff:127.1.2.3]:11434/v1')).to.equal(null)
  })

  it('refuses docker when the builder URL is not loopback', () => {
    const message = ollamaDeployRefusal('docker', 'ollama/qwen3', 'https://ollama.com/v1')
    expect(message).to.include('not a loopback address')
    expect(message).to.include('https://ollama.com/v1')
    expect(message).to.include('host.docker.internal')
    expect(message).to.not.include(CLOUD_KEY)
  })

  it('refuses 0.0.0.0 because it is every interface', () => {
    const message = ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://0.0.0.0:11434/v1')
    expect(message).to.include('0.0.0.0')
    expect(message).to.include('every interface')
    expect(message).to.include('http://127.0.0.1:11434/v1')
  })

  it('refuses https on loopback instead of rewriting it', () => {
    const message = ollamaDeployRefusal('docker', 'ollama/qwen3', 'https://127.0.0.1:11434/v1')
    expect(message).to.include('plain http')
    expect(message).to.include('https://127.0.0.1:11434/v1')
    expect(message).to.include('fail TLS')
    expect(message).to.not.include('host.docker.internal')
  })

  it('refuses a builder URL that carries userinfo', () => {
    const message = ollamaDeployRefusal('docker', 'ollama/qwen3', 'http://user:secret@127.0.0.1:11434/v1')
    expect(message).to.include('userinfo')
    expect(message).to.not.include('secret')
  })
})

describe('ollama docker base URL', () => {
  it('rewrites loopback hosts and keeps the port and path', () => {
    expect(ollamaContainerBaseUrl('http://localhost:11434/v1')).to.equal('http://host.docker.internal:11434/v1')
    expect(ollamaContainerBaseUrl('http://127.0.0.1:11435/v1/')).to.equal('http://host.docker.internal:11435/v1')
    expect(ollamaContainerBaseUrl('http://127.4.5.6:11434/v1')).to.equal('http://host.docker.internal:11434/v1')
    expect(ollamaContainerBaseUrl('http://localhost.:11434/v1')).to.equal('http://host.docker.internal:11434/v1')
    expect(ollamaContainerBaseUrl('http://[::1]:11434/v1')).to.equal('http://host.docker.internal:11434/v1')
    expect(ollamaContainerBaseUrl('http://[::ffff:127.0.0.1]:11434/v1')).to.equal('http://host.docker.internal:11434/v1')
    expect(ollamaContainerBaseUrl('http://[::ffff:127.1.2.3]:11435/v1')).to.equal('http://host.docker.internal:11435/v1')
    expect(ollamaContainerBaseUrl('')).to.equal('http://host.docker.internal:11434/v1')
  })

  it('names OLLAMA_HOST on Linux and stays quiet on other platforms', () => {
    const linux = ollamaLinuxDockerHint('linux')
    expect(linux).to.include('OLLAMA_HOST=0.0.0.0')
    expect(linux).to.include('firewall')
    expect(linux).to.include('172.17.0.1')
    expect(linux).to.include('127.0.0.1')
    expect(ollamaLinuxDockerHint('darwin')).to.equal(null)
  })

  it('puts only the rewritten URL in the container env', () => {
    const prepared = ollamaDockerEnvFromBase('ollama/qwen3', {
      OLLAMA_API_KEY: CLOUD_KEY,
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
      OPENROUTER_API_KEY: 'sk-or-v1-secret-openrouter-key',
    }, 'http://127.0.0.1:11434/v1')
    expect(prepared.hostGateway).to.equal(true)
    expect(prepared.inference).to.deep.equal({
      OPENROUTER_API_KEY: 'sk-or-v1-secret-openrouter-key',
      OLLAMA_BASE_URL: 'http://host.docker.internal:11434/v1',
    })
    const env = dockerContainerEnv({
      agentName: 'demo',
      authToken: 'bearer-token-value-0123456789abcdef',
      inference: prepared.inference,
    })
    expect(env.OLLAMA_BASE_URL).to.equal('http://host.docker.internal:11434/v1')
    expect(env).to.not.have.property('OLLAMA_API_KEY')
    expect(JSON.stringify(env)).to.not.include(CLOUD_KEY)
    expect(JSON.stringify(env)).to.not.include('127.0.0.1')
  })

  it('leaves other models unchanged and does not add a host gateway', () => {
    const inference = {OPENAI_API_KEY: 'sk-openai-test-key-0123456789'}
    const prepared = ollamaDockerEnvFromBase('openai-api/gpt-4o', inference, 'http://127.0.0.1:11434/v1')
    expect(prepared).to.deep.equal({inference, hostGateway: false})
    const args = dockerContainerRunArgs({
      containerName: 'cast-demo',
      publish: '8080:8080',
      image: 'cast-demo:latest',
      hostGateway: prepared.hostGateway,
    })
    expect(args).to.not.include('--add-host')
  })

  it('adds the host gateway only for an ollama container', () => {
    const args = dockerContainerRunArgs({
      containerName: 'cast-demo',
      publish: '8080:8080',
      image: 'cast-demo:latest',
      volumeId: 'cast-demo',
      hostGateway: true,
    })
    expect(args).to.include('--add-host')
    expect(args).to.include('host.docker.internal:host-gateway')
    expect(args.join('\0')).to.not.include(CLOUD_KEY)
  })

  it('reads the builder default and still drops the cloud key', () => {
    const previousHome = process.env.HOME
    const previousKey = process.env.OLLAMA_API_KEY
    const previousUrl = process.env.OLLAMA_BASE_URL
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-ollama-docker-'))
    process.env.HOME = home
    delete process.env.OLLAMA_API_KEY
    delete process.env.OLLAMA_BASE_URL
    try {
      const prepared = prepareOllamaDocker('ollama/qwen3', {OLLAMA_API_KEY: CLOUD_KEY})
      expect(prepared.inference).to.deep.equal({
        OLLAMA_BASE_URL: 'http://host.docker.internal:11434/v1',
      })
      expect(prepared.hostGateway).to.equal(true)
    } finally {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousKey === undefined) delete process.env.OLLAMA_API_KEY
      else process.env.OLLAMA_API_KEY = previousKey
      if (previousUrl === undefined) delete process.env.OLLAMA_BASE_URL
      else process.env.OLLAMA_BASE_URL = previousUrl
    }
  })
})
