import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'
import * as keytar from 'keytar'

const privateHome = process.env.HOME
const savedEnv = {
  OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
  DIGITALOCEAN_MODEL_ACCESS_KEY: process.env.DIGITALOCEAN_MODEL_ACCESS_KEY,
  OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  DIGITALOCEAN_INFERENCE_BASE_URL: process.env.DIGITALOCEAN_INFERENCE_BASE_URL,
  XAI_API_KEY: process.env.XAI_API_KEY,
  XAI_BASE_URL: process.env.XAI_BASE_URL,
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}

async function loadCommand(id: string): Promise<any> {
  return require(`../../../typescript/cast-cli/src/commands/provider/${id}`).default
}

async function runCommand(Cmd: any, args: any, flags: any): Promise<{logs: string[]; errors: string[]}> {
  const logs: string[] = []
  const errors: string[] = []
  const instance = new Cmd([], {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({args, flags, argv: [], raw: [], metadata: {}, nonExistentFlags: []})
  instance.log = (msg?: string) => logs.push(msg ?? '')
  instance.error = (msg: string) => {
    errors.push(msg)
    const error = new Error(msg)
    ;(error as any).oclif = {exit: 1}
    throw error
  }
  try {
    await instance.run()
  } catch (error: any) {
    if (errors.length === 0) errors.push(error.message ?? String(error))
  }
  return {logs, errors}
}

describe('cast provider', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cast-provider-'))
    process.env.HOME = home
    delete process.env.OPENROUTER_API_KEY
    delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    delete process.env.OPENROUTER_BASE_URL
    delete process.env.DIGITALOCEAN_INFERENCE_BASE_URL
    delete process.env.XAI_API_KEY
    delete process.env.XAI_BASE_URL
  })

  afterEach(() => {
    process.env.HOME = privateHome
    restoreEnv('OPENROUTER_API_KEY', savedEnv.OPENROUTER_API_KEY)
    restoreEnv('DIGITALOCEAN_MODEL_ACCESS_KEY', savedEnv.DIGITALOCEAN_MODEL_ACCESS_KEY)
    restoreEnv('OPENROUTER_BASE_URL', savedEnv.OPENROUTER_BASE_URL)
    restoreEnv('DIGITALOCEAN_INFERENCE_BASE_URL', savedEnv.DIGITALOCEAN_INFERENCE_BASE_URL)
    restoreEnv('XAI_API_KEY', savedEnv.XAI_API_KEY)
    restoreEnv('XAI_BASE_URL', savedEnv.XAI_BASE_URL)
    fs.rmSync(home, {recursive: true, force: true})
  })

  const configPath = () => path.join(home, '.cast', 'config.yaml')
  const tokenPath = (key: string) => path.join(home, '.cast', 'tokens', 'inference', `${key}.token`)

  it('lists providers with the base URL and does not print a token', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-secret-value'
    const Provider = await loadCommand('index')
    const result = await runCommand(Provider, {}, {json: false, current: false})
    expect(result.errors).to.deep.equal([])
    const text = result.logs.join('\n')
    expect(text).to.include('openrouter')
    expect(text).to.include('OpenRouter')
    expect(text).to.include('enabled')
    expect(text).to.include('https://openrouter.ai/api/v1')
    expect(text).to.include('DigitalOcean Serverless Inference')
    expect(text).to.include('xAI')
    expect(text).to.include('https://api.x.ai/v1')
    expect(text).to.include('not enabled')
    expect(text).to.not.include('sk-secret-value')
  })

  it('enables xAI from a token and lists it without printing the key', async () => {
    const Enable = await loadCommand('enable')
    const enabled = await runCommand(Enable, {provider: 'xai'}, {
      token: 'xai-secret-token',
    })
    expect(enabled.errors, enabled.errors.join('\n')).to.deep.equal([])
    expect(enabled.logs.join('\n')).to.not.include('xai-secret-token')
    expect(await keytar.getPassword('cast', 'inference:xai')).to.equal('xai-secret-token')
    const Provider = await loadCommand('index')
    const listed = await runCommand(Provider, {}, {json: true, current: false})
    expect(listed.errors, listed.errors.join('\n')).to.deep.equal([])
    const rows = JSON.parse(listed.logs.join('\n'))
    const xai = rows.find((row: {key: string}) => row.key === 'xai')
    expect(xai.displayName).to.equal('xAI')
    expect(xai.enabled).to.equal(true)
    expect(xai.baseUrl).to.equal('https://api.x.ai/v1')
    expect(listed.logs.join('\n')).to.not.include('xai-secret-token')
  })

  it('refuses to switch to a provider that has no token', async () => {
    const Provider = await loadCommand('index')
    const result = await runCommand(Provider, {provider: 'digitalocean'}, {json: false, current: false})
    expect(result.errors.join('\n')).to.include('cast provider enable digitalocean --token')
    expect(fs.existsSync(configPath())).to.equal(false)
  })

  it('stores the token in the keychain and writes the URL', async () => {
    const Enable = await loadCommand('enable')
    const result = await runCommand(Enable, {provider: 'digitalocean'}, {
      token: 'do-secret-token',
      url: 'https://inference.example/v1',
    })
    expect(result.errors, result.errors.join('\n')).to.deep.equal([])
    expect(result.logs.join('\n')).to.not.include('do-secret-token')
    expect(result.logs.join('\n')).to.include('system keychain')
    expect(await keytar.getPassword('cast', 'inference:digitalocean')).to.equal('do-secret-token')
    expect(fs.existsSync(tokenPath('digitalocean'))).to.equal(false)
    const config = yaml.parse(fs.readFileSync(configPath(), 'utf8'))
    expect(config.providers.digitalocean_inference.base_url).to.equal('https://inference.example/v1')
    expect(JSON.stringify(config)).to.not.include('do-secret-token')
  })

  it('treats a private token file as enabled when the keychain has no entry', async () => {
    fs.mkdirSync(path.dirname(tokenPath('digitalocean')), {recursive: true})
    fs.writeFileSync(tokenPath('digitalocean'), 'do-file-token\n', {mode: 0o600})
    const Provider = await loadCommand('index')
    const result = await runCommand(Provider, {}, {json: true, current: false})
    expect(result.errors).to.deep.equal([])
    const rows = JSON.parse(result.logs.join('\n'))
    const digitalocean = rows.find((row: {key: string}) => row.key === 'digitalocean')
    expect(digitalocean.enabled).to.equal(true)
    expect(result.logs.join('\n')).to.not.include('do-file-token')
  })

  it('rejects a remote http URL and accepts loopback http', async () => {
    const Enable = await loadCommand('enable')
    const remote = await runCommand(Enable, {provider: 'digitalocean'}, {
      token: 'do-secret-token',
      url: 'http://evil.example/v1',
    })
    expect(remote.errors.join('\n')).to.match(/https/)
    expect(fs.existsSync(configPath())).to.equal(false)
    const local = await runCommand(Enable, {provider: 'digitalocean'}, {
      token: 'do-secret-token',
      url: 'http://127.0.0.1:9/v1',
    })
    expect(local.errors, local.errors.join('\n')).to.deep.equal([])
    const config = yaml.parse(fs.readFileSync(configPath(), 'utf8'))
    expect(config.providers.digitalocean_inference.base_url).to.equal('http://127.0.0.1:9/v1')
    expect(JSON.stringify(config)).to.not.include('do-secret-token')
  })

  it('writes nothing when the URL has userinfo', async () => {
    const Enable = await loadCommand('enable')
    const result = await runCommand(Enable, {provider: 'digitalocean'}, {
      token: 'do-secret-token',
      url: 'https://user:pass@inference.example/v1',
    })
    expect(result.errors.join('\n')).to.match(/userinfo/)
    expect(fs.existsSync(tokenPath('digitalocean'))).to.equal(false)
    expect(fs.existsSync(configPath())).to.equal(false)
  })

  it('does not enable a provider with --url alone', async () => {
    const Enable = await loadCommand('enable')
    const result = await runCommand(Enable, {provider: 'digitalocean'}, {
      url: 'https://inference.example/v1',
    })
    expect(result.errors.join('\n')).to.include('Pass --token')
    expect(fs.existsSync(configPath())).to.equal(false)
  })

  it('switches an enabled provider and restores the previous model', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test'
    process.env.DIGITALOCEAN_INFERENCE_BASE_URL = 'http://127.0.0.1:1'
    fs.mkdirSync(path.dirname(tokenPath('digitalocean')), {recursive: true})
    fs.writeFileSync(tokenPath('digitalocean'), 'do-secret-token\n', {mode: 0o600})
    fs.mkdirSync(path.join(home, '.cast'), {recursive: true})
    fs.writeFileSync(configPath(), yaml.stringify({
      defaults: {builder_model: 'openrouter/minimax/minimax-m2.5'},
    }))
    const Provider = await loadCommand('index')
    const switched = await runCommand(Provider, {provider: 'digitalocean'}, {json: false, current: false})
    expect(switched.errors, switched.errors.join('\n')).to.deep.equal([])
    const config = yaml.parse(fs.readFileSync(configPath(), 'utf8'))
    expect(config.defaults.inference_provider).to.equal('digitalocean')
    expect(config.defaults.builder_model).to.equal('digitalocean/llama3.3-70b-instruct')
    expect(config.defaults.provider_models.openrouter).to.equal('openrouter/minimax/minimax-m2.5')

    const back = await runCommand(Provider, {provider: 'openrouter'}, {json: false, current: false})
    expect(back.errors, back.errors.join('\n')).to.deep.equal([])
    const restored = yaml.parse(fs.readFileSync(configPath(), 'utf8'))
    expect(restored.defaults.inference_provider).to.equal('openrouter')
    expect(restored.defaults.builder_model).to.equal('openrouter/minimax/minimax-m2.5')
  })

  it('treats the builder model prefix as the active provider', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-test'
    fs.mkdirSync(path.join(home, '.cast'), {recursive: true})
    fs.writeFileSync(configPath(), yaml.stringify({
      defaults: {
        builder_model: 'openrouter/minimax/minimax-m2.5',
        inference_provider: 'digitalocean',
      },
    }))
    const Provider = await loadCommand('index')
    const result = await runCommand(Provider, {}, {json: true, current: false})
    expect(result.errors, result.errors.join('\n')).to.deep.equal([])
    const rows = JSON.parse(result.logs.join('\n'))
    const openrouter = rows.find((row: {key: string}) => row.key === 'openrouter')
    const digitalocean = rows.find((row: {key: string}) => row.key === 'digitalocean')
    expect(openrouter.current).to.equal(true)
    expect(digitalocean.current).to.equal(false)
    expect(result.logs.join('\n')).to.not.include('sk-test')
  })
})
