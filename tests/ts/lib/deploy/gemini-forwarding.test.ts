import {expect} from 'chai'

import {buildDropletEnvFile} from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'
import {
  filterInferenceEnv,
  formatFlySecretsImport,
  loadInferenceCatalog,
  railwaySecretSetArgs,
} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {spriteAgentLaunchScript} from '../../../../typescript/cast-cli/src/lib/deploy/sprites-service'

const TOKEN = 'bearer-token-value-0123456789abcdef'
const OPENROUTER = 'sk-or-v1-secret-openrouter-key'
const DIGITALOCEAN = 'do-model-secret-key-0123456789'
const GEMINI = 'gemini-test-key-0123456789'
const MODEL = 'gemini/gemini-3.8-flash'

const RESOLVED = {
  OPENROUTER_API_KEY: OPENROUTER,
  DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN,
  GEMINI_API_KEY: GEMINI,
  OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
  DIGITALOCEAN_INFERENCE_BASE_URL: 'https://inference.example/v1',
  GEMINI_BASE_URL: 'https://generativelanguage.example/v1beta/openai',
}

function expectOnlyGeminiKey(text: string): void {
  expect(text).to.include('GEMINI_API_KEY')
  expect(text).to.include(GEMINI)
  expect(text).to.not.include('OPENROUTER_API_KEY')
  expect(text).to.not.include('DIGITALOCEAN_MODEL_ACCESS_KEY')
  expect(text).to.not.include('GEMINI_BASE_URL')
  expect(text).to.not.include('BASE_URL')
  expect(text).to.not.include(OPENROUTER)
  expect(text).to.not.include(DIGITALOCEAN)
}

describe('gemini deploy forwarding', () => {
  const catalog = loadInferenceCatalog()
  const inference = filterInferenceEnv(MODEL, RESOLVED, catalog)

  it('keeps only GEMINI_API_KEY for a gemini brain.model', () => {
    expect(inference).to.deep.equal({GEMINI_API_KEY: GEMINI})
  })

  it('sends that key on the Fly secrets stdin and nowhere else', () => {
    const stdin = formatFlySecretsImport({
      CAST_AGENT_NAME: 'demo',
      AUTH_TOKEN: TOKEN,
      ...inference,
    })
    expectOnlyGeminiKey(stdin)
    expect(stdin).to.include('AUTH_TOKEN=')
    expect(railwaySecretSetArgs('GEMINI_API_KEY')).to.deep.equal([
      'variables', 'set', 'GEMINI_API_KEY', '--stdin',
    ])
  })

  it('puts that key in the sprite launch script', () => {
    const script = spriteAgentLaunchScript('demo', TOKEN, inference)
    expectOnlyGeminiKey(script)
  })

  it('writes that key into the DigitalOcean droplet env file', () => {
    const file = buildDropletEnvFile({
      CAST_AGENT_NAME: 'demo',
      CAST_AGENT_PATH: '/app/agent',
      PYTHONPATH: '/app',
      ...inference,
      AUTH_TOKEN: TOKEN,
    })
    expectOnlyGeminiKey(file)
    expect(file).to.include('AUTH_TOKEN=')
  })
})
