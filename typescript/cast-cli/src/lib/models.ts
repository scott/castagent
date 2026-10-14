import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'

/**
 * Curated builder models. Copied from the OpenRouter knownModels list that
 * docs-site/scripts/extract-providers.ts turns into data/models.json.
 * Ids are validated against this list. A single leading `openrouter/` is
 * accepted and stored as given, so the shipped default round-trips.
 * There is no custom-id escape hatch.
 */
const OPENROUTER_PREFIX = 'openrouter/'
const MODEL_IDS = [
  'anthropic/claude-opus-4.5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-haiku-4',
  'anthropic/claude-3.7-sonnet',
  'anthropic/claude-3.7-sonnet:thinking',
  'anthropic/claude-3.5-sonnet',
  'anthropic/claude-3.5-haiku',
  'anthropic/claude-3-opus',
  'anthropic/claude-3-sonnet',
  'anthropic/claude-3-haiku',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-4o-search-preview',
  'openai/gpt-4o-mini-search',
  'openai/gpt-4.5-turbo',
  'openai/gpt-4-turbo',
  'openai/gpt-4',
  'google/gemini-2.5-pro',
  'google/gemini-2.5-flash',
  'google/gemini-2.0-flash',
  'google/gemini-1.5-pro',
  'google/gemini-1.5-flash',
  'google/gemini-1.5-flash-8b',
  'meta-llama/llama-4-scout',
  'meta-llama/llama-4-maverick',
  'meta-llama/llama-4-17b-16e-instruct',
  'meta-llama/llama-3.3-70b-instruct',
  'meta-llama/llama-3.2-90b-vision-instruct',
  'meta-llama/llama-3.2-11b-vision-instruct',
  'meta-llama/llama-3.1-405b-instruct',
  'meta-llama/llama-3.1-70b-instruct',
  'meta-llama/llama-3.1-8b-instruct',
  'kimi/k2.5',
  'kimi/k2',
  'kimi/kimi-2.5',
  'kimi/kimi-2',
  'minimax/minimax-m4',
  'minimax/minimax-m2.5',
  'minimax/minimax-m2',
  'deepseek/deepseek-chat-v3-0324',
  'deepseek/deepseek-chat',
  'deepseek/deepseek-coder',
  'mistralai/mistral-large',
  'mistralai/mistral-medium',
  'mistralai/mistral-small',
  'mistralai/mistral-nemo',
  'cohere/command-r-plus-08-2024',
  'cohere/command-r-plus',
  'cohere/command-r7b-12-2024',
  'cohere/command-r',
  'x-ai/grok-2',
  'x-ai/grok-2-mini',
  'x-ai/grok-beta',
  'perplexity/llama-3.1-sonar-large-128k-online',
  'perplexity/llama-3.1-sonar-huge-128k-online',
]

export interface ModelInfo {
  id: string
  provider: string
  family: string
}

export const DEFAULT_BUILDER_MODEL = 'openrouter/minimax/minimax-m2.5'

export const INVALID_CONFIG_YAML =
  '~/.cast/config.yaml is not valid YAML. Fix it manually or delete the file.'

/** `${NAME}` as it appears in the install.sh config scaffold. */
function envRef(name: string): string {
  return '${' + name + '}'
}

/**
 * Same default document install.sh writes before `cast new`. `cast new`
 * does not create this file itself.
 */
export const DEFAULT_CONFIG_SCAFFOLD = `cast:
  version: "1.0"

defaults:
  agent_storage: ~/.cast/agents
  builder_model: openrouter/minimax/minimax-m2.5
  deployment_provider: railway

providers:
  openrouter:
    api_key: ${envRef('OPENROUTER_API_KEY')}
    default_base_url: https://openrouter.ai/api/v1
  digitalocean_inference:
    api_key: ${envRef('DIGITALOCEAN_MODEL_ACCESS_KEY')}
    default_base_url: https://inference.do-ai.run/v1

deployment:
  railway:
    api_token: ${envRef('RAILWAY_API_TOKEN')}
    project_id: ${envRef('RAILWAY_PROJECT_ID')}
  digitalocean:
    api_token: ${envRef('DO_API_TOKEN')}
    app_id: ${envRef('DO_APP_ID')}
  fly:
    api_token: ${envRef('FLY_API_TOKEN')}
  docker:
    registry: localhost:5000
`

type ConfigDoc = Record<string, any>

function compareModelId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** Same split as docs-site/scripts/extract-providers.ts. */
export function modelInfo(id: string): ModelInfo {
  const stripped = id.replace(/^openrouter\//, '')
  const slash = stripped.indexOf('/')
  if (slash === -1) {
    return {id, provider: stripped, family: stripped}
  }
  return {
    id,
    provider: stripped.slice(0, slash),
    family: stripped.slice(slash + 1),
  }
}

export const MODELS: ModelInfo[] = MODEL_IDS
  .map(modelInfo)
  .sort((a, b) => compareModelId(a.id, b.id))

export function configFilePath(): string {
  return path.join(os.homedir(), '.cast', 'config.yaml')
}

/**
 * Catalog id, or the same id with one leading `openrouter/`.
 * Returns the string to store, or null when it is not in the catalog.
 * The prefix is kept so `openrouter/minimax/minimax-m2.5` writes the
 * shipped default instead of a different bare id.
 */
export function resolveBuilderModelId(id: string): string | null {
  const trimmed = id.trim()
  if (trimmed.length === 0) return null
  const catalogId = trimmed.startsWith(OPENROUTER_PREFIX)
    ? trimmed.slice(OPENROUTER_PREFIX.length)
    : trimmed
  if (catalogId.length === 0 || catalogId.startsWith(OPENROUTER_PREFIX)) return null
  if (!MODELS.some(model => model.id === catalogId)) return null
  return trimmed
}

export function isKnownModel(id: string): boolean {
  return resolveBuilderModelId(id) != null
}

export function unknownModelMessage(id: string): string {
  const ids = MODELS.map(model => model.id).join(', ')
  return `Unknown model '${id}'.\nAvailable models: ${ids}`
}

function parseConfigDocument(text: string): ConfigDoc {
  let parsed: unknown
  try {
    parsed = yaml.parse(text)
  } catch {
    throw new Error(INVALID_CONFIG_YAML)
  }
  if (parsed == null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(INVALID_CONFIG_YAML)
  }
  return parsed as ConfigDoc
}

function readConfigDocument(): ConfigDoc {
  const text = fs.readFileSync(configFilePath(), 'utf8')
  return parseConfigDocument(text)
}

function ensureDefaults(config: ConfigDoc): Record<string, any> {
  const defaults = config.defaults
  if (defaults == null) {
    config.defaults = {}
    return config.defaults
  }
  if (typeof defaults !== 'object' || Array.isArray(defaults)) {
    throw new Error(INVALID_CONFIG_YAML)
  }
  return defaults
}

function writeConfigDocument(config: ConfigDoc): void {
  const file = configFilePath()
  const dir = path.dirname(file)
  fs.mkdirSync(dir, {recursive: true})
  const body = yaml.stringify(config)
  const text = body.endsWith('\n') ? body : `${body}\n`
  const tmp = path.join(dir, `.config.yaml.${process.pid}.${Date.now()}.tmp`)
  try {
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // The original OS error is the one to surface.
    }
    throw error
  }
}

/** Raw `defaults.builder_model`, or the default when the file or key is missing. */
export function getCurrentBuilderModel(): string {
  const file = configFilePath()
  if (!fs.existsSync(file)) return DEFAULT_BUILDER_MODEL
  const config = readConfigDocument()
  const model = config.defaults?.builder_model
  if (typeof model !== 'string' || model.length === 0) return DEFAULT_BUILDER_MODEL
  return model
}

/**
 * Set `defaults.builder_model`. Creates the install scaffold when the file
 * is missing. Other keys are kept. The write is a temp file plus rename,
 * then a re-read. Returns the id written.
 */
export function setBuilderModel(id: string): string {
  const stored = resolveBuilderModelId(id)
  if (stored == null) {
    throw new Error(unknownModelMessage(id.trim()))
  }
  const file = configFilePath()
  const config = fs.existsSync(file) ? readConfigDocument() : parseConfigDocument(DEFAULT_CONFIG_SCAFFOLD)
  ensureDefaults(config).builder_model = stored
  writeConfigDocument(config)
  const confirmed = readConfigDocument()
  if (confirmed.defaults?.builder_model !== stored) {
    throw new Error(
      `Failed to confirm builder model write. Read back ${String(confirmed.defaults?.builder_model)}, expected ${stored}.`,
    )
  }
  return stored
}

export function formatModelCatalog(current: string): string {
  const lines = [
    `Current builder model: ${current}`,
    '',
    'Available models:',
    ...MODELS.map((model, index) => `  ${index + 1}. ${model.id}`),
    '',
    'Set with: cast model <model-id>',
  ]
  return lines.join('\n')
}
