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
const ANTHROPIC = 'sk-ant-test-key-0123456789'
const MODEL = 'anthropic-api/claude-sonnet-5-5'

const RESOLVED = {
  OPENROUTER_API_KEY: OPENROUTER,
  DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN,
  ANTHROPIC_API_KEY: ANTHROPIC,
  OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
  DIGITALOCEAN_INFERENCE_BASE_URL: 'https://inference.example/v1',
  ANTHROPIC_BASE_URL: 'https://anthropic.example/v1',
  GEMINI_API_KEY: 'gemini-test-key-0123456789',
  OPENAI_API_KEY: 'sk-openai-test-key-0123456789',
  XAI_API_KEY: 'xai-secret-key-0123456789',
}

function expectOnlyAnthropicKey(text: string): void {
  expect(text).to.include('ANTHROPIC_API_KEY')
  expect(text).to.include(ANTHROPIC)
  expect(text).to.not.include('OPENROUTER_API_KEY')
  expect(text).to.not.include('DIGITALOCEAN_MODEL_ACCESS_KEY')
  expect(text).to.not.include('GEMINI_API_KEY')
  expect(text).to.not.include('OPENAI_API_KEY')
  expect(text).to.not.include('XAI_API_KEY')
  expect(text).to.not.include('ANTHROPIC_BASE_URL')
  expect(text).to.not.include('BASE_URL')
  expect(text).to.not.include(OPENROUTER)
  expect(text).to.not.include(DIGITALOCEAN)
  expect(text).to.not.include('https://')
}

describe('anthropic deploy forwarding', () => {
  const catalog = loadInferenceCatalog()
  const inference = filterInferenceEnv(MODEL, RESOLVED, catalog)

  it('keeps only ANTHROPIC_API_KEY for an anthropic-api brain.model', () => {
    expect(inference).to.deep.equal({ANTHROPIC_API_KEY: ANTHROPIC})
  })

  it('sends that key on the Fly secrets stdin and nowhere else', () => {
    const stdin = formatFlySecretsImport({
      CAST_AGENT_NAME: 'demo',
      AUTH_TOKEN: TOKEN,
      ...inference,
    })
    expectOnlyAnthropicKey(stdin)
    expect(stdin).to.include('AUTH_TOKEN=')
    expect(railwaySecretSetArgs('ANTHROPIC_API_KEY')).to.deep.equal([
      'variables', 'set', 'ANTHROPIC_API_KEY', '--stdin',
    ])
  })

  it('puts that key in the sprite launch script', () => {
    const script = spriteAgentLaunchScript('demo', TOKEN, inference)
    expectOnlyAnthropicKey(script)
  })

  it('writes that key into the DigitalOcean droplet env file', () => {
    const file = buildDropletEnvFile({
      CAST_AGENT_NAME: 'demo',
      CAST_AGENT_PATH: '/app/agent',
      PYTHONPATH: '/app',
      ...inference,
      AUTH_TOKEN: TOKEN,
    })
    expectOnlyAnthropicKey(file)
    expect(file).to.include('AUTH_TOKEN=')
  })
})
