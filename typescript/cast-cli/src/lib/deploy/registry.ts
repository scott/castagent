import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {createRequire} from 'module'
import {getProviderToken, loadConfig} from './deploy-utils'
import {dockerProvider} from './providers/docker'
import {digitaloceanProvider} from './providers/digitalocean'
import {flyProvider} from './providers/fly'
import {localProvider} from './providers/local'
import {microvmProvider} from './providers/microvm'
import {railwayProvider} from './providers/railway'
import {spritesProvider} from './providers/sprites'
import type {DeploymentProvider} from './types'

const nodeRequire = createRequire(__filename)

/**
 * Built-in picker order. TUI number key 7 is `local` when no externals are loaded.
 * Externals append after this list; they do not replace it.
 */
export const builtinDeploymentProviders: DeploymentProvider[] = [
  railwayProvider,
  flyProvider,
  digitaloceanProvider,
  microvmProvider,
  spritesProvider,
  dockerProvider,
  localProvider,
]

const KEY_PATTERN = /^[a-z0-9-]+$/

interface RegistryCache {
  providers: DeploymentProvider[]
  errors: Error[]
  sources: Map<string, string>
}

let cache: RegistryCache | null = null

function causeMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  return String(cause)
}

function expandHome(entry: string): string {
  if (entry === '~') return os.homedir()
  if (entry.startsWith('~/')) return path.join(os.homedir(), entry.slice(2))
  return entry
}

function resolveConfigEntry(entry: string): string {
  const isPath =
    entry.startsWith('~/') ||
    entry === '~' ||
    path.isAbsolute(entry) ||
    entry.startsWith('./') ||
    entry.startsWith('../') ||
    entry.endsWith('.cjs') ||
    entry.endsWith('.js')
  if (isPath) {
    const expanded = expandHome(entry)
    return path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
  }
  return nodeRequire.resolve(entry)
}

function unwrapProvider(loaded: unknown): unknown {
  if (!loaded || typeof loaded !== 'object') return loaded
  const record = loaded as {key?: unknown; deploy?: unknown; default?: unknown}
  if (typeof record.key === 'string' && typeof record.deploy === 'function') return loaded
  const inner = record.default
  if (inner && typeof inner === 'object') {
    const candidate = inner as {key?: unknown; deploy?: unknown}
    if (typeof candidate.key === 'string' && typeof candidate.deploy === 'function') return inner
  }
  return loaded
}

function registerProvider(
  cacheIn: RegistryCache,
  provider: DeploymentProvider,
  source: string,
): void {
  if (!provider || typeof provider !== 'object') {
    cacheIn.errors.push(new Error(`Deployment provider at ${source} did not export a provider object`))
    return
  }
  if (typeof provider.key !== 'string' || !KEY_PATTERN.test(provider.key)) {
    cacheIn.errors.push(new Error(
      `Deployment provider key '${String(provider.key)}' in ${source} must match [a-z0-9-]+`,
    ))
    return
  }
  if (typeof provider.deploy !== 'function') {
    cacheIn.errors.push(new Error(`Deployment provider at ${source} is missing deploy()`))
    return
  }
  const existing = cacheIn.sources.get(provider.key)
  if (existing) {
    cacheIn.errors.push(new Error(
      `Deployment provider key '${provider.key}' collides between ${existing} and ${source}`,
    ))
    return
  }
  cacheIn.providers.push(provider)
  cacheIn.sources.set(provider.key, source)
}

function loadProviderFile(cacheIn: RegistryCache, filePath: string, folderName?: string): void {
  let loaded: unknown
  try {
    loaded = nodeRequire(filePath)
  } catch (cause) {
    cacheIn.errors.push(new Error(
      `Failed to load deployment provider at ${filePath}: ${causeMessage(cause)}`,
    ))
    return
  }
  const provider = unwrapProvider(loaded) as DeploymentProvider
  if (folderName && provider && typeof provider === 'object' && provider.key && provider.key !== folderName) {
    cacheIn.errors.push(new Error(
      `Deployment provider key '${provider.key}' in ${filePath} does not match folder '${folderName}'`,
    ))
    return
  }
  registerProvider(cacheIn, provider, filePath)
}

function loadDirectoryProviders(cacheIn: RegistryCache): void {
  const root = path.join(os.homedir(), '.cast', 'providers')
  if (!fs.existsSync(root)) return
  let names: string[]
  try {
    names = fs.readdirSync(root)
  } catch (cause) {
    cacheIn.errors.push(new Error(
      `Failed to load deployment provider at ${root}: ${causeMessage(cause)}`,
    ))
    return
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  for (const name of names) {
    const filePath = path.join(root, name, 'provider.cjs')
    if (!fs.existsSync(filePath)) continue
    loadProviderFile(cacheIn, filePath, name)
  }
}

function loadConfigProviders(cacheIn: RegistryCache): void {
  const config = loadConfig()
  const entries = config?.deploymentProviders
  if (entries == null) return
  if (!Array.isArray(entries)) {
    cacheIn.errors.push(new Error(
      'Failed to load deployment provider at ~/.cast/config.yaml: deploymentProviders must be a list',
    ))
    return
  }
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) {
      cacheIn.errors.push(new Error(
        'Failed to load deployment provider at ~/.cast/config.yaml: deploymentProviders entries must be paths or package names',
      ))
      continue
    }
    let resolved: string
    try {
      resolved = resolveConfigEntry(entry)
    } catch (cause) {
      cacheIn.errors.push(new Error(
        `Failed to load deployment provider at ${entry}: ${causeMessage(cause)}`,
      ))
      continue
    }
    loadProviderFile(cacheIn, resolved)
  }
}

/**
 * Synchronous on purpose: `cast deploy` merges provider flags while the
 * command class is defined. The result is memoized for the process.
 * Only deploy, upgrade, shutdown, and connect should call this.
 */
function loadRegistry(): RegistryCache {
  if (cache) return cache
  const next: RegistryCache = {
    providers: [],
    errors: [],
    sources: new Map(),
  }
  for (const provider of builtinDeploymentProviders) {
    registerProvider(next, provider, `built-in (providers/${provider.key}.ts)`)
  }
  loadDirectoryProviders(next)
  loadConfigProviders(next)
  cache = next
  return next
}

export function resetDeploymentProviderRegistry(): void {
  cache = null
}

export function listDeploymentProviders(): DeploymentProvider[] {
  return loadRegistry().providers
}

export function deploymentProviderLoadErrors(): Error[] {
  return loadRegistry().errors
}

export function assertDeploymentProvidersLoaded(): void {
  const errors = deploymentProviderLoadErrors()
  if (errors.length === 0) return
  throw new Error(errors.map(error => error.message).join('\n'))
}

export function getDeploymentProvider(key: string): DeploymentProvider | undefined {
  return listDeploymentProviders().find(provider => provider.key === key)
}

export function deploymentProviderSource(key: string): string | undefined {
  return loadRegistry().sources.get(key)
}

export function isBuiltinDeploymentProvider(key: string): boolean {
  return (deploymentProviderSource(key) || '').startsWith('built-in ')
}

export function deploymentProviderKeys(): string[] {
  return listDeploymentProviders().map(provider => provider.key)
}

/** First hit from auth.envVars, then auth.configKey. DigitalOcean keeps the historical config lookup. */
export function resolveProviderAuthToken(provider: DeploymentProvider): string | undefined {
  if (provider.auth?.configKey === 'providers.digitalocean.token') {
    return getProviderToken('digitalocean', provider.auth.envVars)
  }
  for (const name of provider.auth?.envVars || []) {
    if (process.env[name]) return process.env[name]
  }
  const configKey = provider.auth?.configKey
  if (!configKey) return undefined
  const value = configKey.split('.').reduce<unknown>((acc, part) => {
    if (!acc || typeof acc !== 'object') return undefined
    return (acc as Record<string, unknown>)[part]
  }, loadConfig())
  if (typeof value !== 'string' || !value) return undefined
  if (value.startsWith('${') && value.endsWith('}')) {
    return process.env[value.slice(2, -1)]
  }
  return value
}
