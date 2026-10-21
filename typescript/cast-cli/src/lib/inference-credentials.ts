/**
 * One resolver for an inference token and its base URL.
 * Deploy, upgrade, status, and `cast provider` all use this module.
 * The token is never read from `providers.digitalocean` (that is the deploy token).
 *
 * Token order: environment, keychain, private token file, then config.
 * Base URL order: baseUrlEnv, config `base_url`, then the manifest default.
 * Values are trimmed. An unsubstituted `${VAR}` is missing.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {keychain} from './keychain'

export interface InferenceCredentialEntry {
  key: string
  envVar?: string
  configKey: string
  baseUrl: string
  baseUrlEnv?: string
}

export function expandConfigSecret(value: unknown): string | undefined {
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
  if (missing) return undefined
  const trimmed = expanded.trim()
  return trimmed || undefined
}

export function dottedConfigString(config: any, dotted: string | undefined): string | undefined {
  if (!dotted) return undefined
  let current = config
  for (const part of dotted.split('.')) {
    if (!current || typeof current !== 'object' || !(part in current)) return undefined
    current = current[part]
  }
  if (typeof current !== 'string' || current.length === 0) return undefined
  return current
}

export function baseUrlConfigKey(configKey: string): string {
  if (!configKey || !configKey.endsWith('.api_key')) return ''
  return `${configKey.slice(0, -'api_key'.length)}base_url`
}

/** `~/.cast/tokens/inference/<key>.token`. Null when the key is not a safe path segment. */
export function inferenceTokenPath(providerKey: string, home = os.homedir()): string | null {
  if (!/^[a-z0-9-]+$/.test(providerKey)) return null
  return path.join(home, '.cast', 'tokens', 'inference', `${providerKey}.token`)
}

export function readInferenceTokenFile(providerKey: string): string | undefined {
  const file = inferenceTokenPath(providerKey)
  if (!file) return undefined
  try {
    const text = fs.readFileSync(file, 'utf8').trim()
    return text || undefined
  } catch {
    return undefined
  }
}

/** Literal loopback only. `localhost` is allowed here; it is not a DNS name we send a key to. */
export function isLoopbackInferenceHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

/**
 * https, or http on literal 127.0.0.1, ::1, or localhost.
 * Rejects userinfo, query, and fragment so a key is not sent in the clear
 * or embedded in the URL.
 */
export function parseInferenceUrl(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return null
  }
  const https = url.protocol === 'https:'
  const loopbackHttp = url.protocol === 'http:' && isLoopbackInferenceHost(url.hostname)
  if (!https && !loopbackHttp) return null
  if (!url.hostname) return null
  if (url.username || url.password) return null
  if (url.search || url.hash) return null
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${pathname}`
}

export function resolvedBaseUrl(entry: InferenceCredentialEntry, config: any): string {
  if (entry.baseUrlEnv) {
    const fromEnv = process.env[entry.baseUrlEnv]
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  }
  const stored = expandConfigSecret(dottedConfigString(config, baseUrlConfigKey(entry.configKey)))
  return stored || entry.baseUrl
}

export async function resolvedInferenceToken(
  entry: InferenceCredentialEntry,
  config: any,
): Promise<string | undefined> {
  if (entry.envVar) {
    const fromEnv = process.env[entry.envVar]
    if (typeof fromEnv === 'string' && fromEnv.trim()) return fromEnv.trim()
  }
  const fromKeychain = await keychain.getInferenceToken(entry.key)
  if (fromKeychain && fromKeychain.trim()) return fromKeychain.trim()
  const fromFile = readInferenceTokenFile(entry.key)
  if (fromFile) return fromFile
  return expandConfigSecret(dottedConfigString(config, entry.configKey))
}
