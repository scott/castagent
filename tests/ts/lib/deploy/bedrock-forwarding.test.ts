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
const XAI = 'xai-secret-key-0123456789'
const OPENAI = 'sk-openai-test-key-0123456789'
const GEMINI = 'gemini-test-key-0123456789'
const BEDROCK = 'bedrock-test-key-0123456789'
const REGION = 'eu-west-1'
const MODEL = 'bedrock/global.anthropic.claude-sonnet-4-6'

const RESOLVED = {
  OPENROUTER_API_KEY: OPENROUTER,
  DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN,
  XAI_API_KEY: XAI,
  OPENAI_API_KEY: OPENAI,
  GEMINI_API_KEY: GEMINI,
  AWS_BEARER_TOKEN_BEDROCK: BEDROCK,
  BEDROCK_REGION: REGION,
  OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
  DIGITALOCEAN_INFERENCE_BASE_URL: 'https://inference.example/v1',
  XAI_BASE_URL: 'https://xai.example/v1',
  OPENAI_BASE_URL: 'https://proxy.example/v1',
  GEMINI_BASE_URL: 'https://generativelanguage.example/v1beta/openai',
  BEDROCK_BASE_URL: 'https://bedrock-runtime.eu-west-1.amazonaws.com/openai/v1',
}

function expectOnlyBedrock(text: string): void {
  expect(text).to.include('AWS_BEARER_TOKEN_BEDROCK')
  expect(text).to.include(BEDROCK)
  expect(text).to.include('BEDROCK_REGION')
  expect(text).to.include(REGION)
  expect(text).to.not.include('OPENROUTER_API_KEY')
  expect(text).to.not.include('DIGITALOCEAN_MODEL_ACCESS_KEY')
  expect(text).to.not.include('XAI_API_KEY')
  expect(text).to.not.include('OPENAI_API_KEY')
  expect(text).to.not.include('GEMINI_API_KEY')
  expect(text).to.not.include('BEDROCK_BASE_URL')
  expect(text).to.not.include('BASE_URL')
  expect(text).to.not.include(OPENROUTER)
  expect(text).to.not.include(DIGITALOCEAN)
  expect(text).to.not.include(XAI)
  expect(text).to.not.include(OPENAI)
  expect(text).to.not.include(GEMINI)
  expect(text).to.not.include('https://')
}

describe('bedrock deploy forwarding', () => {
  const catalog = loadInferenceCatalog()
  const inference = filterInferenceEnv(MODEL, RESOLVED, catalog)

  it('keeps the Bedrock API key and region for a bedrock brain.model', () => {
    expect(inference).to.deep.equal({
      AWS_BEARER_TOKEN_BEDROCK: BEDROCK,
      BEDROCK_REGION: REGION,
    })
  })

  it('sends that pair on the Fly secrets stdin and nowhere else', () => {
    const stdin = formatFlySecretsImport({
      CAST_AGENT_NAME: 'demo',
      AUTH_TOKEN: TOKEN,
      ...inference,
    })
    expectOnlyBedrock(stdin)
    expect(stdin).to.include('AUTH_TOKEN=')
    expect(railwaySecretSetArgs('AWS_BEARER_TOKEN_BEDROCK')).to.deep.equal([
      'variables', 'set', 'AWS_BEARER_TOKEN_BEDROCK', '--stdin',
    ])
    expect(railwaySecretSetArgs('BEDROCK_REGION')).to.deep.equal([
      'variables', 'set', 'BEDROCK_REGION', '--stdin',
    ])
  })

  it('puts that pair in the sprite launch script', () => {
    const script = spriteAgentLaunchScript('demo', TOKEN, inference)
    expectOnlyBedrock(script)
  })

  it('writes that pair into the DigitalOcean droplet env file', () => {
    const file = buildDropletEnvFile({
      CAST_AGENT_NAME: 'demo',
      CAST_AGENT_PATH: '/app/agent',
      PYTHONPATH: '/app',
      ...inference,
      AUTH_TOKEN: TOKEN,
    })
    expectOnlyBedrock(file)
    expect(file).to.include('AUTH_TOKEN=')
  })
})
