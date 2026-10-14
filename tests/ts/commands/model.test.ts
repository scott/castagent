import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'
import {INVALID_CONFIG_YAML, MODELS, resolveBuilderModelId} from '../../../typescript/cast-cli/src/lib/models'

const privateHome = process.env.HOME

async function loadCommand(): Promise<any> {
  return require('../../../typescript/cast-cli/src/commands/model').default
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

function knownIdsFromRegistry(): string[] {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../../../python/cast/providers/manifest.json'),
    'utf8',
  )) as Array<{key: string; knownModels?: string[]}>
  const openrouter = manifest.find(provider => provider.key === 'openrouter')
  return openrouter?.knownModels ?? []
}

describe('cast model', () => {
  let home: string
  let Model: any

  before(async () => {
    Model = await loadCommand()
  })

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cast-model-'))
    process.env.HOME = home
  })

  afterEach(() => {
    process.env.HOME = privateHome
    fs.rmSync(home, {recursive: true, force: true})
  })

  const configPath = () => path.join(home, '.cast', 'config.yaml')

  it('lists the same ids as the OpenRouter registry with provider and family', () => {
    const ids = knownIdsFromRegistry()
    expect(MODELS.map(model => model.id).sort()).to.deep.equal([...ids].sort())
    const sonnet = MODELS.find(model => model.id === 'anthropic/claude-3.5-sonnet')
    expect(sonnet).to.deep.equal({
      id: 'anthropic/claude-3.5-sonnet',
      provider: 'anthropic',
      family: 'claude-3.5-sonnet',
    })
    const kimi = MODELS.find(model => model.id === 'kimi/k2.5')
    expect(kimi).to.deep.equal({id: 'kimi/k2.5', provider: 'kimi', family: 'k2.5'})
  })

  it('prints the current model and a numbered list when called with no args', async () => {
    const {logs, errors} = await runCommand(Model, {}, {list: false, json: false, current: false})
    expect(errors).to.deep.equal([])
    const text = logs.join('\n')
    expect(text).to.include('Current builder model: openrouter/minimax/minimax-m2.5')
    expect(text).to.include('Available models:')
    expect(text).to.match(/\n {2}1\. \S+/)
    expect(text).to.include('anthropic/claude-3.5-sonnet')
    expect(text).to.include('Set with: cast model <model-id>')
    expect(fs.existsSync(configPath())).to.equal(false)
  })

  it('sets defaults.builder_model without clobbering other keys', async () => {
    const castDir = path.join(home, '.cast')
    fs.mkdirSync(castDir, {recursive: true})
    fs.writeFileSync(configPath(), [
      'cast:',
      '  version: "9.9"',
      'custom_top: stay',
      'defaults:',
      '  agent_storage: /tmp/agents',
      '  builder_model: openrouter/minimax/minimax-m2.5',
      '  deployment_provider: docker',
      'providers:',
      '  openrouter:',
      '    api_key: keep-me',
      '',
    ].join('\n'))

    const {logs, errors} = await runCommand(
      Model,
      {model: 'anthropic/claude-3.5-sonnet'},
      {list: false, json: false, current: false},
    )
    expect(errors).to.deep.equal([])
    const text = logs.join('\n')
    expect(text).to.include('✓ Builder model set to: anthropic/claude-3.5-sonnet')
    expect(text).to.include('Restart the builder to take effect (run `cast dev <agent>` again).')

    const config = yaml.parse(fs.readFileSync(configPath(), 'utf8'))
    expect(config.defaults.builder_model).to.equal('anthropic/claude-3.5-sonnet')
    expect(config.defaults.agent_storage).to.equal('/tmp/agents')
    expect(config.defaults.deployment_provider).to.equal('docker')
    expect(config.cast.version).to.equal('9.9')
    expect(config.custom_top).to.equal('stay')
    expect(config.providers.openrouter.api_key).to.equal('keep-me')
    expect(fs.readdirSync(castDir).some(name => name.includes('.tmp'))).to.equal(false)
  })

  it('rejects an unknown id and lists available ids', async () => {
    const {errors} = await runCommand(
      Model,
      {model: 'not-a-real-model'},
      {list: false, json: false, current: false},
    )
    expect(errors).to.have.length(1)
    expect(errors[0]).to.include('not-a-real-model')
    expect(errors[0]).to.include('anthropic/claude-3.5-sonnet')
    expect(errors[0]).to.include('minimax/minimax-m2.5')
    expect(fs.existsSync(configPath())).to.equal(false)
  })

  it('resolves a catalog id and one leading openrouter prefix', () => {
    expect(resolveBuilderModelId('minimax/minimax-m2.5')).to.equal('minimax/minimax-m2.5')
    expect(resolveBuilderModelId('openrouter/minimax/minimax-m2.5')).to.equal('openrouter/minimax/minimax-m2.5')
    expect(resolveBuilderModelId('openrouter/anthropic/claude-3.5-sonnet')).to.equal(
      'openrouter/anthropic/claude-3.5-sonnet',
    )
    expect(resolveBuilderModelId('  openrouter/minimax/minimax-m2.5  ')).to.equal('openrouter/minimax/minimax-m2.5')
    expect(resolveBuilderModelId('openrouter/not-a-model')).to.equal(null)
    expect(resolveBuilderModelId('openrouter/openrouter/minimax/minimax-m2.5')).to.equal(null)
    expect(resolveBuilderModelId('digitalocean/llama3.3-70b-instruct')).to.equal(null)
    expect(resolveBuilderModelId('openrouter/')).to.equal(null)
    expect(resolveBuilderModelId('')).to.equal(null)
  })

  it('accepts the openrouter id printed by --current and restores the shipped default', async () => {
    const current = await runCommand(Model, {}, {list: false, json: false, current: true})
    expect(current.errors).to.deep.equal([])
    expect(current.logs).to.deep.equal(['openrouter/minimax/minimax-m2.5'])

    const changed = await runCommand(
      Model,
      {model: 'anthropic/claude-3.5-sonnet'},
      {list: false, json: false, current: false},
    )
    expect(changed.errors).to.deep.equal([])

    const restored = await runCommand(
      Model,
      {model: '  openrouter/minimax/minimax-m2.5  '},
      {list: false, json: false, current: false},
    )
    expect(restored.errors).to.deep.equal([])
    expect(restored.logs.join('\n')).to.include('✓ Builder model set to: openrouter/minimax/minimax-m2.5')

    const config = yaml.parse(fs.readFileSync(configPath(), 'utf8'))
    expect(config.defaults.builder_model).to.equal('openrouter/minimax/minimax-m2.5')
    expect(config.defaults.agent_storage).to.equal('~/.cast/agents')
    expect(config.providers.openrouter.api_key).to.equal('${OPENROUTER_API_KEY}')

    const again = await runCommand(Model, {}, {list: false, json: true, current: true})
    expect(again.errors).to.deep.equal([])
    expect(again.logs).to.deep.equal(['{"id":"openrouter/minimax/minimax-m2.5"}'])

    const fedBack = await runCommand(
      Model,
      {model: JSON.parse(again.logs[0]).id},
      {list: false, json: false, current: false},
    )
    expect(fedBack.errors).to.deep.equal([])
    expect(yaml.parse(fs.readFileSync(configPath(), 'utf8')).defaults.builder_model).to.equal(
      'openrouter/minimax/minimax-m2.5',
    )
  })

  it('stores a bare catalog id and a prefixed catalog id as given', async () => {
    const bare = await runCommand(
      Model,
      {model: 'minimax/minimax-m2.5'},
      {list: false, json: false, current: false},
    )
    expect(bare.errors).to.deep.equal([])
    expect(yaml.parse(fs.readFileSync(configPath(), 'utf8')).defaults.builder_model).to.equal('minimax/minimax-m2.5')

    const prefixed = await runCommand(
      Model,
      {model: 'openrouter/anthropic/claude-3.5-sonnet'},
      {list: false, json: false, current: false},
    )
    expect(prefixed.errors).to.deep.equal([])
    expect(prefixed.logs.join('\n')).to.include('✓ Builder model set to: openrouter/anthropic/claude-3.5-sonnet')
    expect(yaml.parse(fs.readFileSync(configPath(), 'utf8')).defaults.builder_model).to.equal(
      'openrouter/anthropic/claude-3.5-sonnet',
    )

    const current = await runCommand(Model, {}, {list: false, json: false, current: true})
    expect(current.logs).to.deep.equal(['openrouter/anthropic/claude-3.5-sonnet'])
    const roundTrip = await runCommand(
      Model,
      {model: current.logs[0]},
      {list: false, json: false, current: false},
    )
    expect(roundTrip.errors).to.deep.equal([])
  })

  it('rejects a prefixed id that is not in the catalog', async () => {
    for (const id of [
      'openrouter/not-a-real-model',
      'openrouter/openrouter/minimax/minimax-m2.5',
      'digitalocean/llama3.3-70b-instruct',
    ]) {
      const {errors} = await runCommand(
        Model,
        {model: id},
        {list: false, json: false, current: false},
      )
      expect(errors).to.have.length(1)
      expect(errors[0]).to.include(`Unknown model '${id}'`)
      expect(errors[0]).to.include('minimax/minimax-m2.5')
      expect(fs.existsSync(configPath())).to.equal(false)
    }
  })

  it('prints one model per line for --list', async () => {
    const {logs, errors} = await runCommand(Model, {}, {list: true, json: false, current: false})
    expect(errors).to.deep.equal([])
    expect(logs).to.deep.equal(MODELS.map(model => model.id))
    const sorted = [...logs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    expect(logs).to.deep.equal(sorted)
  })

  it('prints models.json shape for --list --json', async () => {
    const {logs, errors} = await runCommand(Model, {}, {list: true, json: true, current: false})
    expect(errors).to.deep.equal([])
    const parsed = JSON.parse(logs.join('\n'))
    expect(parsed).to.deep.equal(MODELS)
    expect(parsed[0]).to.have.keys('id', 'provider', 'family')
  })

  it('prints the current raw id as JSON', async () => {
    const {logs, errors} = await runCommand(Model, {}, {list: false, json: true, current: true})
    expect(errors).to.deep.equal([])
    expect(logs).to.deep.equal(['{"id":"openrouter/minimax/minimax-m2.5"}'])
  })

  it('creates the install scaffold when the config file is missing', async () => {
    expect(fs.existsSync(configPath())).to.equal(false)
    const {errors} = await runCommand(
      Model,
      {model: 'anthropic/claude-3.5-sonnet'},
      {list: false, json: false, current: false},
    )
    expect(errors).to.deep.equal([])
    const config = yaml.parse(fs.readFileSync(configPath(), 'utf8'))
    expect(config.cast.version).to.equal('1.0')
    expect(config.defaults.agent_storage).to.equal('~/.cast/agents')
    expect(config.defaults.deployment_provider).to.equal('railway')
    expect(config.defaults.builder_model).to.equal('anthropic/claude-3.5-sonnet')
    expect(config.providers.openrouter.api_key).to.equal('${OPENROUTER_API_KEY}')
    expect(config.providers.openrouter.default_base_url).to.equal('https://openrouter.ai/api/v1')
    expect(config.providers.digitalocean_inference.api_key).to.equal('${DIGITALOCEAN_MODEL_ACCESS_KEY}')
    expect(config.deployment.railway.api_token).to.equal('${RAILWAY_API_TOKEN}')
    expect(config.deployment.railway.project_id).to.equal('${RAILWAY_PROJECT_ID}')
    expect(config.deployment.digitalocean.api_token).to.equal('${DO_API_TOKEN}')
    expect(config.deployment.fly.api_token).to.equal('${FLY_API_TOKEN}')
    expect(config.deployment.docker.registry).to.equal('localhost:5000')
  })

  it('exits non-zero when config.yaml is not valid YAML', async () => {
    fs.mkdirSync(path.join(home, '.cast'), {recursive: true})
    fs.writeFileSync(configPath(), 'defaults: [\n')

    const shown = await runCommand(Model, {}, {list: false, json: false, current: false})
    expect(shown.errors).to.deep.equal([INVALID_CONFIG_YAML])

    const set = await runCommand(
      Model,
      {model: 'anthropic/claude-3.5-sonnet'},
      {list: false, json: false, current: false},
    )
    expect(set.errors).to.deep.equal([INVALID_CONFIG_YAML])
    expect(fs.readFileSync(configPath(), 'utf8')).to.equal('defaults: [\n')
  })

  it('surfaces an OS error when the config directory is not writable', async () => {
    const castDir = path.join(home, '.cast')
    fs.mkdirSync(castDir, {recursive: true})
    fs.chmodSync(castDir, 0o555)
    try {
      const {errors} = await runCommand(
        Model,
        {model: 'anthropic/claude-3.5-sonnet'},
        {list: false, json: false, current: false},
      )
      expect(errors).to.have.length(1)
      expect(errors[0]).to.match(/EACCES|EPERM|permission denied/i)
    } finally {
      fs.chmodSync(castDir, 0o755)
    }
  })
})
