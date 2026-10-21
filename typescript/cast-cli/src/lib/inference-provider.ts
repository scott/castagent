import * as fs from 'fs'
import {
  InferenceCatalogEntry,
  loadInferenceCatalog,
  loadInferenceKnownModels,
} from './deploy/deploy-utils'
import {keychain} from './keychain'
import {
  baseUrlConfigKey,
  dottedConfigString,
  expandConfigSecret,
  parseInferenceUrl,
  resolvedBaseUrl,
  resolvedInferenceToken,
} from './inference-credentials'
import {inferencePrefixError} from './inference-routing'
import {
  DEFAULT_BUILDER_MODEL,
  ensureConfigDefaults,
  getCurrentBuilderModel,
  MODELS,
  modelInfo,
  ModelInfo,
  readCastConfig,
  resolveBuilderModelId,
  setBuilderModel,
  unknownModelMessage,
  writeCastConfig,
} from './models'

export {parseInferenceUrl} from './inference-credentials'

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
  modelsPath?: string
  fallbackModels: string[]
  defaultModel: string
}

export function providerDisplayName(entry: {key?: string; name: string; displayName?: string}): string {
  return entry.displayName || entry.name
}

export async function resolvedToken(entry: InferenceCatalogEntry, config = readCastConfig()): Promise<string | undefined> {
  return resolvedInferenceToken(entry, config)
}

function providerByPrefix(
  model: string,
  catalog: readonly InferenceCatalogEntry[],
): InferenceCatalogEntry | undefined {
  let best: InferenceCatalogEntry | undefined
  let bestLen = -1
  for (const entry of catalog) {
    for (const prefix of entry.prefixes ?? []) {
      if (prefix && model.startsWith(prefix) && prefix.length > bestLen) {
        best = entry
        bestLen = prefix.length
      }
    }
  }
  return best
}

/**
 * The builder model prefix selects the provider. `defaults.inference_provider`
 * is only a hint when the model has no registered prefix.
 */
export function activeProviderKey(
  config: Record<string, any>,
  catalog: readonly InferenceCatalogEntry[],
): string {
  const model = typeof config.defaults?.builder_model === 'string' && config.defaults.builder_model
    ? config.defaults.builder_model
    : getCurrentBuilderModel()
  const matched = providerByPrefix(model, catalog)
  if (matched) return matched.key
  const hint = config.defaults?.inference_provider
  if (typeof hint === 'string' && catalog.some(entry => entry.key === hint)) return hint
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
      displayName: providerDisplayName(entry),
      enabled: Boolean(token) || Boolean(entry.keyless),
      current: entry.key === active,
      baseUrl,
      defaultBaseUrl: entry.baseUrl,
      prefixes: entry.prefixes ?? [],
      acceptsAnyModel: entry.acceptsAnyModel,
      envVar: entry.envVar,
      freeform: entry.acceptsAnyModel,
      modelsPath: entry.modelsPath,
      fallbackModels: entry.fallbackModels ?? [],
      defaultModel: entry.defaultModel ?? '',
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

const INFERENCE_URL_ERROR = 'Inference URL must be https, or http on 127.0.0.1, ::1, or localhost, with a host and no userinfo or query.'

export async function enableInferenceProvider(
  key: string,
  options: {token?: string; url?: string},
): Promise<{baseUrl: string; tokenStore?: 'keychain' | 'file'}> {
  const catalog = loadInferenceCatalog()
  const entry = providerOrThrow(catalog, key)
  if (!options.token && !options.url && !entry.keyless) {
    throw new Error('Pass --token, --url, or both.')
  }
  const config = readCastConfig()
  let parsedUrl: string | null = null
  if (options.url) {
    parsedUrl = parseInferenceUrl(options.url)
    if (!parsedUrl) throw new Error(INFERENCE_URL_ERROR)
  }
  let token = options.token
  if (token === '-') token = readStdin()
  if (options.token !== undefined && !token) {
    throw new Error('The inference token is empty.')
  }
  let tokenStore: 'keychain' | 'file' | undefined
  if (!token) {
    if (!entry.keyless) {
      const existing = await resolvedToken(entry, config)
      if (!existing) {
        throw new Error(`Provider '${key}' has no token. Pass --token -.`)
      }
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

function prefixedModelId(prefix: string, id: string): string {
  if (!prefix || id.startsWith(prefix)) return id
  return `${prefix}${id}`
}

function renderHeader(template: string, token: string | undefined): string | undefined {
  if (!template.includes('${token}')) return template
  if (!token) return undefined
  return template.split('${token}').join(token)
}

function modelListHeaders(
  entry: InferenceCatalogEntry,
  token: string | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {}
  const custom = entry.modelsHeaders
  if (custom && Object.keys(custom).length > 0) {
    for (const [name, value] of Object.entries(custom)) {
      const rendered = renderHeader(value, token)
      if (rendered) headers[name] = rendered
    }
    return headers
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function modelListRoot(entry: InferenceCatalogEntry, baseUrl: string): string {
  let root = baseUrl.replace(/\/+$/, '')
  if (entry.normalizeV1Base && !root.endsWith('/v1')) root = `${root}/v1`
  return root
}

function withQuery(url: string, key: string, value: string): string {
  const join = url.includes('?') ? '&' : '?'
  return `${url}${join}${encodeURIComponent(key)}=${encodeURIComponent(value)}`
}

async function readModelList(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
): Promise<{data?: Array<{id?: string; lifecycle?: string}>}> {
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(8000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as {data?: Array<{id?: string; lifecycle?: string}>}
}

async function fetchModels(
  entry: InferenceCatalogEntry,
  baseUrl: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<{ids: string[]; fallback: boolean}> {
  const prefix = entry.prefixes?.[0] ?? ''
  const fallbackIds = (entry.fallbackModels ?? []).map(id => prefixedModelId(prefix, id))
  if (!entry.modelsPath || (!token && !entry.keyless)) {
    return {ids: fallbackIds, fallback: true}
  }
  const root = modelListRoot(entry, baseUrl)
  const modelsPath = entry.modelsPath.startsWith('/') ? entry.modelsPath : `/${entry.modelsPath}`
  const plainUrl = `${root}${modelsPath}`
  const headers = modelListHeaders(entry, token)
  try {
    let body: {data?: Array<{id?: string; lifecycle?: string}>}
    if (entry.modelsLifecycle) {
      try {
        body = await readModelList(fetchImpl, withQuery(plainUrl, 'lifecycle', entry.modelsLifecycle), headers)
      } catch {
        // The host does not support the lifecycle query. List without it.
        body = await readModelList(fetchImpl, plainUrl, headers)
      }
    } else {
      body = await readModelList(fetchImpl, plainUrl, headers)
    }
    let ids = (body.data ?? [])
      .filter(row => {
        if (!row || typeof row.id !== 'string' || row.id.length === 0) return false
        if (!entry.modelsLifecycle) return true
        // A row with no lifecycle field is kept. The host did not report one.
        if (typeof row.lifecycle !== 'string' || row.lifecycle.length === 0) return true
        return row.lifecycle === entry.modelsLifecycle
      })
      .map(row => row.id as string)
    if (entry.stripModelIdPrefix) {
      const strip = entry.stripModelIdPrefix
      ids = ids.map(id => id.startsWith(strip) ? id.slice(strip.length) : id)
    }
    if (entry.modelsFilter) {
      const pattern = new RegExp(entry.modelsFilter)
      ids = ids.filter(id => pattern.test(id))
    }
    ids = ids.map(id => prefixedModelId(prefix, id))
    if (ids.length === 0) throw new Error('empty catalog')
    return {ids, fallback: false}
  } catch {
    return {ids: fallbackIds, fallback: true}
  }
}

export async function modelsForProvider(
  entry: InferenceCatalogEntry,
  options: {fetchImpl?: typeof fetch; knownModels?: Record<string, string[]>} = {},
): Promise<ModelCatalogResult> {
  if (entry.curatedModels) {
    const known = options.knownModels ?? loadInferenceKnownModels()
    const prefix = entry.prefixes?.[0] ?? ''
    const ids = (known[entry.key] ?? entry.fallbackModels ?? []).map(id => prefixedModelId(prefix, id))
    return {
      models: ids.map(modelInfo),
      fallback: false,
      freeform: entry.acceptsAnyModel && ids.length === 0,
      providerKey: entry.key,
    }
  }
  if (entry.modelsPath) {
    const config = readCastConfig()
    const baseUrl = resolvedBaseUrl(entry, config)
    const token = await resolvedToken(entry, config)
    const fetched = await fetchModels(entry, baseUrl, token, options.fetchImpl ?? fetch)
    return {
      models: fetched.ids.map(modelInfo),
      fallback: fetched.fallback,
      freeform: entry.acceptsAnyModel,
      providerKey: entry.key,
    }
  }
  if (entry.default && !entry.modelsPath) {
    return {models: MODELS, fallback: false, freeform: false, providerKey: entry.key}
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
  const preferred = entry.defaultModel || (entry.default ? DEFAULT_BUILDER_MODEL : '')
  if (preferred && modelAccepted(preferred, entry, models)) return preferred
  return models[0]?.id ?? preferred
}

function longestPrefix(id: string, prefixes: readonly string[]): string {
  let best = ''
  for (const prefix of prefixes) {
    if (prefix && id.startsWith(prefix) && prefix.length > best.length) best = prefix
  }
  return best
}

function modelAccepted(id: string, entry: InferenceCatalogEntry, models: readonly {id: string}[]): boolean {
  if (resolveBuilderModelId(id, models)) return true
  if (!entry.acceptsAnyModel) return false
  const prefix = longestPrefix(id, entry.prefixes ?? [])
  if (!prefix) return false
  const rest = id.slice(prefix.length)
  return rest.length > 0 && !/\s/.test(rest)
}

function acceptModelId(
  id: string,
  entry: InferenceCatalogEntry,
  models: readonly {id: string}[],
): string | null {
  const resolved = resolveBuilderModelId(id, models)
  if (resolved) return resolved
  if (!entry.acceptsAnyModel) return null
  const prefix = longestPrefix(id, entry.prefixes ?? [])
  if (!prefix) return null
  const rest = id.slice(prefix.length)
  if (!rest || /\s/.test(rest)) return null
  return id
}

function rememberedMap(defaults: Record<string, any>): Record<string, string> {
  const current = defaults.provider_models
  if (!current || typeof current !== 'object' || Array.isArray(current)) return {}
  return current
}

function writeSwitchedModel(
  config: Record<string, any>,
  fromKey: string,
  toKey: string,
  model: string,
): void {
  const defaults = ensureConfigDefaults(config)
  const remembered = rememberedMap(defaults)
  remembered[fromKey] = getCurrentBuilderModel()
  defaults.provider_models = remembered
  defaults.builder_model = model
  defaults.inference_provider = toKey
  writeCastConfig(config)
  const confirmed = readCastConfig()
  if (confirmed.defaults?.builder_model !== model) {
    throw new Error(
      `Failed to confirm builder model write. Read back ${String(confirmed.defaults?.builder_model)}, expected ${model}.`,
    )
  }
}

export async function switchInferenceProvider(
  key: string,
  options: {fetchImpl?: typeof fetch} = {},
): Promise<{provider: string; model: string; needsModel: boolean}> {
  const catalog = loadInferenceCatalog()
  const entry = providerOrThrow(catalog, key)
  const config = readCastConfig()
  const token = await resolvedToken(entry, config)
  if (!token && !entry.keyless) {
    throw new Error(
      `'${key}' is not enabled.\nEnable it with: cast provider enable ${key} --token -`,
    )
  }
  const currentKey = activeProviderKey(config, catalog)
  const defaults = ensureConfigDefaults(config)
  const remembered = rememberedMap(defaults)
  const rememberedModel = typeof remembered[key] === 'string' ? remembered[key] : ''
  const catalogResult = await modelsForProvider(entry, options)
  const accepted = rememberedModel ? acceptModelId(rememberedModel, entry, catalogResult.models) : null
  let model = accepted ?? ''
  if (!model && catalogResult.models.length > 0) {
    model = defaultModelId(entry, catalogResult.models)
  }
  const needsModel = !model
  if (needsModel) {
    return {provider: providerDisplayName(entry), model: '', needsModel: true}
  }
  writeSwitchedModel(config, currentKey, key, model)
  return {provider: providerDisplayName(entry), model, needsModel: false}
}

/**
 * Store a builder model. A `<prefix>/<id>` for another enabled provider
 * switches to that provider. A freeform provider accepts any id with its prefix.
 */
export async function applyBuilderModel(rawId: string): Promise<string> {
  const trimmed = rawId.trim()
  const catalog = loadInferenceCatalog()
  const routeError = inferencePrefixError(trimmed, catalog)
  if (routeError) throw new Error(routeError)
  const config = readCastConfig()
  const currentKey = activeProviderKey(config, catalog)
  const target = providerByPrefix(trimmed, catalog)
  const entry = target
    ?? catalog.find(item => item.key === currentKey)
    ?? catalog.find(item => item.default)
  if (!entry) throw new Error(unknownModelMessage(trimmed))
  if (target && target.key !== currentKey) {
    const token = await resolvedToken(entry, config)
    if (!token && !entry.keyless) {
      throw new Error(
        `'${entry.key}' is not enabled.\nEnable it with: cast provider enable ${entry.key} --token -`,
      )
    }
  }
  const result = await modelsForProvider(entry)
  const stored = acceptModelId(trimmed, entry, result.models)
  if (!stored) throw new Error(unknownModelMessage(trimmed, result.models))
  const switching = Boolean(target && target.key !== currentKey)
  const inCatalog = result.models.some(model => model.id === stored)
  if (!switching && inCatalog) return setBuilderModel(stored, result.models)
  writeSwitchedModel(config, currentKey, entry.key, stored)
  return stored
}

/** Copy resolved tokens into the process environment for a child Python process. */
export async function primeInferenceProcessEnv(): Promise<void> {
  const catalog = loadInferenceCatalog()
  const config = readCastConfig()
  for (const entry of catalog) {
    if (entry.envVar && !process.env[entry.envVar]) {
      const token = await resolvedInferenceToken(entry, config)
      if (token) process.env[entry.envVar] = token
    }
    if (entry.baseUrlEnv && !process.env[entry.baseUrlEnv]) {
      const baseUrl = resolvedBaseUrl(entry, config)
      if (baseUrl && baseUrl !== entry.baseUrl) process.env[entry.baseUrlEnv] = baseUrl
    }
    for (const setting of entry.settings ?? []) {
      if (!setting?.env || setting.env.includes('BASE_URL') || process.env[setting.env]) continue
      const fromConfig = expandConfigSecret(dottedConfigString(config, setting.configKey))
      if (fromConfig) process.env[setting.env] = fromConfig
    }
  }
}
