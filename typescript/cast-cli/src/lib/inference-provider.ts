import * as fs from 'fs'
import {
  InferenceCatalogEntry,
  loadInferenceCatalog,
  loadInferenceKnownModels,
} from './deploy/deploy-utils'
import {keychain} from './keychain'
import {
  DEFAULT_BUILDER_MODEL,
  ensureConfigDefaults,
  getCurrentBuilderModel,
  MODELS,
  modelInfo,
  ModelInfo,
  readCastConfig,
  resolveBuilderModelId,
  writeCastConfig,
} from './models'

export const DIGITALOCEAN_FALLBACK_IDS = ['llama3.3-70b-instruct', 'deepseek-v3.2']
export const DIGITALOCEAN_DEFAULT_MODEL = 'digitalocean/llama3.3-70b-instruct'

export interface InferenceProviderStatus {
  key: string
  name: string
  displayName: string
  enabled: boolean
  current: boolean
  baseUrl: string
  defaultBaseUrl: string
  prefixes: string[]
  acceptsAnyModel: boolean
  envVar: string
  freeform: boolean
}

export function providerDisplayName(key: string, fallback: string): string {
  if (key === 'digitalocean') return 'DigitalOcean Serverless Inference'
  return fallback
}

export function parseInferenceUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  if (url.username || url.password) return null
  if (url.search || url.hash) return null
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${pathname}`
}

function expandSecret(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  let missing = false
  const expanded = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => {
    const found = process.env[name]
    if (!found) {
      missing = true
      return ''
    }
    return found
  })
  if (missing || !expanded.trim()) return undefined
  return expanded.trim()
}

function configString(config: Record<string, any>, dotted: string): string | undefined {
  if (!dotted) return undefined
  let current: any = config
  for (const part of dotted.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = current[part]
  }
  return typeof current === 'string' ? current : undefined
}

function baseUrlConfigKey(configKey: string): string {
  if (!configKey.endsWith('.api_key')) return ''
  return `${configKey.slice(0, -'api_key'.length)}base_url`
}

export function resolvedBaseUrl(entry: InferenceCatalogEntry, config = readCastConfig()): string {
  if (entry.baseUrlEnv) {
    const fromEnv = process.env[entry.baseUrlEnv]
    if (fromEnv && fromEnv.trim()) return fromEnv.trim()
  }
  const stored = expandSecret(configString(config, baseUrlConfigKey(entry.configKey)))
  return stored || entry.baseUrl
}

export async function resolvedToken(entry: InferenceCatalogEntry, config = readCastConfig()): Promise<string | undefined> {
  if (entry.envVar) {
    const fromEnv = process.env[entry.envVar]
    if (fromEnv) return fromEnv
  }
  const fromKeychain = await keychain.getInferenceToken(entry.key)
  if (fromKeychain) return fromKeychain
  return expandSecret(configString(config, entry.configKey))
}

export function activeProviderKey(
  config: Record<string, any>,
  catalog: readonly InferenceCatalogEntry[],
): string {
  const stored = config.defaults?.inference_provider
  if (typeof stored === 'string' && catalog.some(entry => entry.key === stored)) return stored
  const model = typeof config.defaults?.builder_model === 'string'
    ? config.defaults.builder_model
    : getCurrentBuilderModel()
  let best: InferenceCatalogEntry | undefined
  let bestLen = -1
  for (const entry of catalog) {
    if (entry.default) continue
    for (const prefix of entry.prefixes ?? []) {
      if (model.startsWith(prefix) && prefix.length > bestLen) {
        best = entry
        bestLen = prefix.length
      }
    }
  }
  if (best) return best.key
  return catalog.find(entry => entry.default)?.key ?? 'openrouter'
}

export async function listInferenceProviders(): Promise<InferenceProviderStatus[]> {
  const catalog = loadInferenceCatalog()
  const config = readCastConfig()
  const active = activeProviderKey(config, catalog)
  const rows: InferenceProviderStatus[] = []
  for (const entry of catalog) {
    const token = await resolvedToken(entry, config)
    const baseUrl = resolvedBaseUrl(entry, config)
    rows.push({
      key: entry.key,
      name: entry.name,
      displayName: providerDisplayName(entry.key, entry.name),
      enabled: Boolean(token),
      current: entry.key === active,
      baseUrl,
      defaultBaseUrl: entry.baseUrl,
      prefixes: entry.prefixes ?? [],
      acceptsAnyModel: entry.acceptsAnyModel,
      envVar: entry.envVar,
      freeform: entry.acceptsAnyModel,
    })
  }
  rows.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return rows
}

export function formatProviderList(rows: readonly InferenceProviderStatus[]): string {
  return rows.map(row => {
    const current = row.current ? ' (current)' : ''
    const enabled = row.enabled ? 'enabled' : 'not enabled'
    return `${row.key}  ${row.displayName}  ${row.baseUrl}  ${enabled}${current}`
  }).join('\n')
}

function readStdin(): string {
  return fs.readFileSync(0, 'utf8').trim()
}

function providerOrThrow(catalog: InferenceCatalogEntry[], key: string): InferenceCatalogEntry {
  const found = catalog.find(entry => entry.key === key)
  if (!found) {
    const names = catalog.map(entry => entry.key).join(', ')
    throw new Error(`Unknown inference provider '${key}'.\nProviders: ${names}`)
  }
  return found
}

export async function enableInferenceProvider(
  key: string,
  options: {token?: string; url?: string},
): Promise<{baseUrl: string; tokenStore?: 'keychain' | 'file'}> {
  if (!options.token && !options.url) {
    throw new Error('Pass --token, --url, or both.')
  }
  const catalog = loadInferenceCatalog()
  const entry = providerOrThrow(catalog, key)
  const config = readCastConfig()
  let parsedUrl: string | null = null
  if (options.url) {
    parsedUrl = parseInferenceUrl(options.url)
    if (!parsedUrl) {
      throw new Error('Inference URL must be an http(s) URL with a host and no userinfo or query.')
    }
  }
  let token = options.token
  if (token === '-') token = readStdin()
  if (options.token !== undefined && !token) {
    throw new Error('The inference token is empty.')
  }
  let tokenStore: 'keychain' | 'file' | undefined
  if (!token) {
    const existing = await resolvedToken(entry, config)
    if (!existing) {
      throw new Error(`Provider '${key}' has no token. Pass --token.`)
    }
  } else {
    tokenStore = await keychain.setInferenceToken(key, token)
  }
  if (parsedUrl) {
    const urlKey = baseUrlConfigKey(entry.configKey)
    if (!urlKey) throw new Error(`Provider '${key}' has no config key for a base URL.`)
    const parts = urlKey.split('.')
    let cursor: Record<string, any> = config
    for (let index = 0; index < parts.length - 1; index++) {
      const part = parts[index]
      if (!cursor[part] || typeof cursor[part] !== 'object' || Array.isArray(cursor[part])) {
        cursor[part] = {}
      }
      cursor = cursor[part]
    }
    cursor[parts[parts.length - 1]] = parsedUrl
    writeCastConfig(config)
  }
  return {baseUrl: parsedUrl || resolvedBaseUrl(entry, readCastConfig()), tokenStore}
}

export interface ModelCatalogResult {
  models: ModelInfo[]
  fallback: boolean
  freeform: boolean
  providerKey: string
}

async function digitalOceanModels(
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ids: string[]; fallback: boolean}> {
  if (!token) {
    return {ids: DIGITALOCEAN_FALLBACK_IDS.map(id => `digitalocean/${id}`), fallback: true}
  }
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/models`, {
      headers: {Authorization: `Bearer ${token}`},
      signal: AbortSignal.timeout(8000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json() as {data?: Array<{id?: string}>}
    const ids = (body.data ?? [])
      .map(row => row.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .map(id => id.startsWith('digitalocean/') ? id : `digitalocean/${id}`)
    if (ids.length === 0) throw new Error('empty catalog')
    return {ids, fallback: false}
  } catch {
    return {ids: DIGITALOCEAN_FALLBACK_IDS.map(id => `digitalocean/${id}`), fallback: true}
  }
}

export async function modelsForProvider(
  entry: InferenceCatalogEntry,
  options: {fetchImpl?: typeof fetch; knownModels?: Record<string, string[]>} = {},
): Promise<ModelCatalogResult> {
  if (entry.key === 'openrouter') {
    return {models: MODELS, fallback: false, freeform: false, providerKey: entry.key}
  }
  const config = readCastConfig()
  const baseUrl = resolvedBaseUrl(entry, config)
  if (entry.key === 'digitalocean') {
    const token = await resolvedToken(entry, config)
    const fetched = await digitalOceanModels(baseUrl, token, options.fetchImpl ?? fetch)
    return {
      models: fetched.ids.map(modelInfo),
      fallback: fetched.fallback,
      freeform: true,
      providerKey: entry.key,
    }
  }
  const known = options.knownModels ?? loadInferenceKnownModels()
  const ids = known[entry.key] ?? []
  return {
    models: ids.map(modelInfo),
    fallback: false,
    freeform: entry.acceptsAnyModel && ids.length === 0,
    providerKey: entry.key,
  }
}

export async function activeModelCatalog(
  options: {fetchImpl?: typeof fetch} = {},
): Promise<ModelCatalogResult> {
  const catalog = loadInferenceCatalog()
  const config = readCastConfig()
  const key = activeProviderKey(config, catalog)
  const entry = catalog.find(item => item.key === key) ?? catalog.find(item => item.default)
  if (!entry) {
    return {models: MODELS, fallback: false, freeform: false, providerKey: 'openrouter'}
  }
  return modelsForProvider(entry, options)
}

function defaultModelId(entry: InferenceCatalogEntry, models: readonly {id: string}[]): string {
  if (entry.key === 'openrouter') return DEFAULT_BUILDER_MODEL
  if (entry.key === 'digitalocean') {
    if (models.some(model => model.id === DIGITALOCEAN_DEFAULT_MODEL)) return DIGITALOCEAN_DEFAULT_MODEL
    return models[0]?.id ?? DIGITALOCEAN_DEFAULT_MODEL
  }
  return models[0]?.id ?? ''
}

export async function switchInferenceProvider(
  key: string,
  options: {fetchImpl?: typeof fetch} = {},
): Promise<{provider: string; model: string; needsModel: boolean}> {
  const catalog = loadInferenceCatalog()
  const entry = providerOrThrow(catalog, key)
  const config = readCastConfig()
  const token = await resolvedToken(entry, config)
  if (!token) {
    throw new Error(
      `'${key}' is not enabled.\nEnable it with: cast provider enable ${key} --token <model-access-key>`,
    )
  }
  const currentKey = activeProviderKey(config, catalog)
  const currentModel = getCurrentBuilderModel()
  const defaults = ensureConfigDefaults(config)
  const remembered = defaults.provider_models && typeof defaults.provider_models === 'object' && !Array.isArray(defaults.provider_models)
    ? defaults.provider_models
    : {}
  remembered[currentKey] = currentModel
  defaults.provider_models = remembered
  defaults.inference_provider = key
  const catalogResult = await modelsForProvider(entry, options)
  const rememberedModel = typeof remembered[key] === 'string' ? remembered[key] : ''
  const accepted = rememberedModel
    ? resolveBuilderModelId(rememberedModel, catalogResult.models)
    : null
  let model = accepted ?? ''
  const prefix = entry.prefixes?.[0] ?? ''
  if (!model && catalogResult.freeform && prefix && rememberedModel.startsWith(prefix)) {
    model = rememberedModel
  }
  if (!model && catalogResult.models.length > 0) {
    model = defaultModelId(entry, catalogResult.models)
  }
  const needsModel = !model
  if (model) defaults.builder_model = model
  writeCastConfig(config)
  return {provider: providerDisplayName(entry.key, entry.name), model, needsModel}
}

/** Copy keychain tokens into the process environment for a child Python process. */
export async function primeInferenceProcessEnv(): Promise<void> {
  const catalog = loadInferenceCatalog()
  const config = readCastConfig()
  for (const entry of catalog) {
    if (entry.envVar && !process.env[entry.envVar]) {
      const token = await keychain.getInferenceToken(entry.key)
      if (token) process.env[entry.envVar] = token
    }
    if (entry.baseUrlEnv && !process.env[entry.baseUrlEnv]) {
      const baseUrl = resolvedBaseUrl(entry, config)
      if (baseUrl && baseUrl !== entry.baseUrl) process.env[entry.baseUrlEnv] = baseUrl
    }
  }
}
