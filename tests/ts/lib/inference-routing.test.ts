import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

import {
  filterInferenceEnv,
  loadInferenceCatalog,
  type InferenceCatalogEntry,
} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {
  inferencePrefixError,
  loadReservedDirectPrefixes,
  loadVendorPrefixes,
  matchingProvider,
} from '../../../typescript/cast-cli/src/lib/inference-routing'

const OPENROUTER = 'sk-or-v1-secret-openrouter-key'
const DIGITALOCEAN = 'do-model-secret-key-0123456789'
const XAI = 'xai-secret-key-0123456789'
const OPENAI = 'sk-openai-test-key-0123456789'

const BOTH = {
  OPENROUTER_API_KEY: OPENROUTER,
  DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN,
  XAI_API_KEY: XAI,
  OPENAI_API_KEY: OPENAI,
  OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
  DIGITALOCEAN_INFERENCE_BASE_URL: 'https://inference.example/v1',
  XAI_BASE_URL: 'https://xai.example/v1',
  OPENAI_BASE_URL: 'https://proxy.example/v1',
  FAKEAI_REGION: 'sfo3',
  FAKEAI_BASE_URL: 'https://fakeai.example/v1',
}

describe('inference prefix routing', () => {
  const catalog = loadInferenceCatalog()

  it('loads OpenRouter and DigitalOcean from the shared catalog', () => {
    const openrouter = catalog.find(entry => entry.key === 'openrouter')
    const digitalocean = catalog.find(entry => entry.key === 'digitalocean')
    expect(openrouter?.envVar).to.equal('OPENROUTER_API_KEY')
    expect(openrouter?.prefixes).to.deep.equal(['openrouter/'])
    expect(openrouter?.default).to.equal(true)
    expect(openrouter?.modelsPath).to.equal(undefined)
    expect(digitalocean?.envVar).to.equal('DIGITALOCEAN_MODEL_ACCESS_KEY')
    expect(digitalocean?.prefixes).to.deep.equal(['digitalocean/'])
    expect(digitalocean?.modelsPath).to.equal('/models')
    expect(digitalocean?.fallbackModels).to.deep.equal(['llama3.3-70b-instruct', 'deepseek-v3.2'])
    const xai = catalog.find(entry => entry.key === 'xai')
    expect(xai?.envVar).to.equal('XAI_API_KEY')
    expect(xai?.prefixes).to.deep.equal(['xai/'])
    expect(xai?.baseUrl).to.equal('https://api.x.ai/v1')
    expect(xai?.baseUrlEnv).to.equal('XAI_BASE_URL')
    expect(xai?.modelsPath).to.equal('/models')
    expect(xai?.defaultModel).to.equal('xai/grok-4.7')
    expect(xai?.fallbackModels).to.deep.equal([
      'grok-4.7',
      'grok-4.20-0309-non-reasoning',
      'grok-4.20-0309-reasoning',
    ])
    expect(xai?.modelsFilter).to.be.a('string')
    const openai = catalog.find(entry => entry.key === 'openai-api')
    expect(openai?.envVar).to.equal('OPENAI_API_KEY')
    expect(openai?.prefixes).to.deep.equal(['openai-api/'])
    expect(openai?.baseUrl).to.equal('https://api.openai.com/v1')
    expect(openai?.baseUrlEnv).to.equal(undefined)
    expect(openai?.modelsPath).to.equal('/models')
    expect(openai?.modelsFilter).to.be.a('string')
    expect(openai?.fallbackModels).to.deep.equal(['gpt-4o', 'gpt-4o-mini'])
    expect(openai?.defaultModel).to.equal('openai-api/gpt-4o')
    expect(openai?.acceptsAnyModel).to.equal(true)
    for (const entry of catalog) {
      expect(entry).to.not.have.property('knownModels')
    }
  })

  it('keeps OpenRouter vendor ids on OpenRouter', () => {
    for (const model of [
      'openai/gpt-4o',
      'anthropic/claude-sonnet-4.6',
      'google/gemini-2.5-pro',
      'x-ai/grok-2',
      'claude-sonnet-4',
      'claude-haiku-latest',
    ]) {
      expect(inferencePrefixError(model, catalog), model).to.equal(null)
      expect(matchingProvider(model, catalog), model).to.equal(undefined)
    }
    expect(matchingProvider('openrouter/minimax/minimax-m2.5', catalog)?.key).to.equal('openrouter')
    expect(matchingProvider('digitalocean/llama3.3-70b-instruct', catalog)?.key).to.equal('digitalocean')
    expect(matchingProvider('openai-api/gpt-4o', catalog)?.key).to.equal('openai-api')
    expect(matchingProvider('openai/gpt-4o', catalog)?.key).to.equal(undefined)
  })

  it('names reserved direct prefixes and routes other slash ids to OpenRouter', () => {
    const reserved = loadReservedDirectPrefixes().map(item => item.prefix)
    expect(reserved).to.include.members([
      'anthropic-api/',
      'gemini/',
      'bedrock/',
      'ollama/',
    ])
    expect(reserved).to.not.include('xai/')
    expect(reserved).to.not.include('openai-api/')
    expect(inferencePrefixError('openai-api/gpt-4o', catalog)).to.equal(null)
    expect(matchingProvider('openai-api/gpt-4o', catalog)?.key).to.equal('openai-api')
    expect(inferencePrefixError('xai/grok-4.7', catalog)).to.equal(null)
    expect(matchingProvider('xai/grok-4.7', catalog)?.key).to.equal('xai')
    const reservedDirect = inferencePrefixError('anthropic-api/claude-sonnet-4.6', catalog)
    expect(reservedDirect).to.include("reserved prefix 'anthropic-api/'")
    expect(reservedDirect).to.include('anthropic/claude-sonnet-4.6 still routes to OpenRouter')
    expect(inferencePrefixError('qwen/qwen3-coder', catalog)).to.equal(null)
    expect(inferencePrefixError('z-ai/glm-4.6', catalog)).to.equal(null)
    expect(inferencePrefixError('unknown/model', catalog)).to.equal(null)
    expect(matchingProvider('qwen/qwen3-coder', catalog)).to.equal(undefined)
    expect(loadVendorPrefixes()).to.include.members(['openai/', 'anthropic/', 'google/', 'x-ai/'])
    const bare = inferencePrefixError('gpt-5', catalog)
    expect(bare).to.include('has no provider prefix')
    expect(bare).to.include('openai-api/')
    expect(bare).to.include('xai/')
    expect(bare).to.include('claude-sonnet-4')
  })

  it('forwards only the brain.model key for both shipped providers', () => {
    expect(filterInferenceEnv('openai/gpt-4o', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('anthropic/claude-sonnet-4.6', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('google/gemini-2.5-pro', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('x-ai/grok-2', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('openrouter/minimax/minimax-m2.5', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('claude-sonnet-4', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('digitalocean/llama3.3-70b-instruct', BOTH, catalog)).to.deep.equal({
      DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN,
    })
    expect(filterInferenceEnv('qwen/qwen3-coder', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('z-ai/glm-4.6', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('unknown/model', BOTH, catalog)).to.deep.equal({
      OPENROUTER_API_KEY: OPENROUTER,
    })
    expect(filterInferenceEnv('xai/grok-4.7', BOTH, catalog)).to.deep.equal({
      XAI_API_KEY: XAI,
    })
    expect(filterInferenceEnv('openai-api/gpt-4o', BOTH, catalog)).to.deep.equal({
      OPENAI_API_KEY: OPENAI,
    })
    expect(filterInferenceEnv('openai-api/o3', BOTH, catalog)).to.deep.equal({
      OPENAI_API_KEY: OPENAI,
    })
    expect(filterInferenceEnv('anthropic-api/claude-sonnet-4.6', BOTH, catalog)).to.deep.equal({})
    expect(filterInferenceEnv('gpt-5', BOTH, catalog)).to.deep.equal({})
    const xaiForwarded = JSON.stringify(filterInferenceEnv('xai/grok-4.7', BOTH, catalog))
    expect(xaiForwarded).to.not.include('BASE_URL')
    expect(xaiForwarded).to.not.include(OPENROUTER)
    expect(xaiForwarded).to.not.include(DIGITALOCEAN)
    expect(xaiForwarded).to.not.include(OPENAI)
    expect(xaiForwarded).to.not.include('https://')
    const openrouterOnly = JSON.stringify(filterInferenceEnv('openai/gpt-4o', BOTH, catalog))
    expect(openrouterOnly).to.not.include(OPENAI)
    expect(openrouterOnly).to.not.include(XAI)
    expect(openrouterOnly).to.not.include('BASE_URL')
    const forwarded = JSON.stringify(filterInferenceEnv('digitalocean/llama3.3-70b-instruct', BOTH, catalog))
    expect(forwarded).to.not.include('BASE_URL')
    expect(forwarded).to.not.include(OPENROUTER)
    expect(forwarded).to.not.include(OPENAI)
    expect(forwarded).to.not.include(XAI)
    const openaiOnly = JSON.stringify(filterInferenceEnv('openai-api/gpt-4o', BOTH, catalog))
    expect(openaiOnly).to.not.include(OPENROUTER)
    expect(openaiOnly).to.not.include(DIGITALOCEAN)
    expect(openaiOnly).to.not.include(XAI)
    expect(openaiOnly).to.not.include('BASE_URL')
    expect(openaiOnly).to.not.include('https://proxy.example')
  })

  it('Fly, Railway, Sprites, and DigitalOcean forward through filterInferenceEnv', () => {
    const root = path.resolve(__dirname, '../../../typescript/cast-cli/src/lib/deploy')
    for (const file of ['fly.ts', 'railway.ts', 'sprites.ts', 'digitalocean.ts']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8')
      expect(source, file).to.include('filterInferenceEnv')
      expect(source, file).to.not.include('OPENAI_API_KEY')
      expect(source, file).to.not.include('XAI_API_KEY')
    }
  })

  it('forwards a non-secret setting and drops a base URL setting', () => {
    const withSettings: InferenceCatalogEntry[] = [
      ...catalog,
      {
        key: 'fakeai',
        name: 'Fake AI',
        default: false,
        prefixes: ['fakeai/'],
        envVar: 'FAKEAI_API_KEY',
        configKey: 'providers.fakeai.api_key',
        baseUrl: 'https://fakeai.example/v1',
        baseUrlEnv: 'FAKEAI_BASE_URL',
        acceptsAnyModel: true,
        settings: [
          {env: 'FAKEAI_REGION', configKey: 'providers.fakeai.region'},
          {env: 'FAKEAI_BASE_URL', configKey: 'providers.fakeai.base_url'},
        ],
      },
    ]
    const env = filterInferenceEnv('fakeai/chat-small', {
      ...BOTH,
      FAKEAI_API_KEY: 'fake-secret-key-0123456789',
    }, withSettings)
    expect(env).to.deep.equal({
      FAKEAI_API_KEY: 'fake-secret-key-0123456789',
      FAKEAI_REGION: 'sfo3',
    })
    expect(JSON.stringify(env)).to.not.include('BASE_URL')
  })
})
