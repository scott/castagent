/**
 * Prefix routing shared with python/cast/providers/registry.py.
 * OpenRouter vendor ids stay on the default provider.
 * Reserved direct prefixes are not OpenRouter models.
 */
import * as fs from 'fs'
import * as path from 'path'

export interface PrefixCatalogEntry {
  key?: string
  default?: boolean
  prefixes?: string[]
}

export interface ReservedDirectPrefix {
  prefix: string
  key: string
  displayName: string
  openrouterVendor: string
}

interface ManifestRow {
  key?: string
  impl?: string
  name?: string
  displayName?: string
  prefixes?: string[]
  knownModels?: string[]
  openrouterVendor?: string
}

function repoRoot(): string {
  const marker = 'python/cast/providers/manifest.json'
  const candidates = [
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
    process.cwd(),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, marker))) return candidate
  }
  throw new Error(`Could not find ${marker} starting from ${__dirname}`)
}

function readJson(relative: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(repoRoot(), relative), 'utf8'))
}

let vendorPrefixes: string[] | undefined
let bareAliases: Set<string> | undefined
let reservedDirect: ReservedDirectPrefix[] | undefined
let openrouterKnown: Set<string> | undefined

export function loadVendorPrefixes(): string[] {
  if (!vendorPrefixes) {
    vendorPrefixes = readJson('python/cast/providers/vendor-prefixes.json') as string[]
  }
  return vendorPrefixes
}

export function loadBareAliases(): Set<string> {
  if (!bareAliases) {
    const ids = readJson('python/cast/providers/bare-aliases.json') as string[]
    bareAliases = new Set(ids.map(id => id.toLowerCase()))
  }
  return bareAliases
}

export function loadReservedDirectPrefixes(): ReservedDirectPrefix[] {
  if (!reservedDirect) {
    const rows = readJson('python/cast/providers/manifest.json') as ManifestRow[]
    const found: ReservedDirectPrefix[] = []
    for (const row of rows) {
      if (row.impl !== 'reserved') continue
      for (const prefix of row.prefixes ?? []) {
        found.push({
          prefix,
          key: row.key || prefix.replace(/\/$/, ''),
          displayName: row.displayName || row.name || row.key || prefix,
          openrouterVendor: row.openrouterVendor || '',
        })
      }
    }
    reservedDirect = found
  }
  return reservedDirect
}

function openrouterHandlesBare(text: string): boolean {
  if (loadBareAliases().has(text.toLowerCase()) || loadOpenRouterKnown().has(text)) return true
  if (/-\d{8}$/.test(text) || /:\w+$/.test(text)) return true
  if (/(?:^|\/)claude-\d-\d-/.test(text)) return true
  const lower = text.toLowerCase()
  if (lower.startsWith('anthropic/claude-sonnet-4') || lower === 'claude-sonnet-4') return true
  if (lower.startsWith('anthropic/claude-opus-4') || lower === 'claude-opus-4') return true
  if (lower.startsWith('anthropic/claude-opus') && lower.includes('4.6')) return true
  return false
}

function loadOpenRouterKnown(): Set<string> {
  if (!openrouterKnown) {
    const rows = readJson('python/cast/providers/manifest.json') as ManifestRow[]
    const row = rows.find(item => item.key === 'openrouter')
    openrouterKnown = new Set(row?.knownModels ?? [])
  }
  return openrouterKnown
}

function registeredPrefixes(catalog: readonly PrefixCatalogEntry[]): string[] {
  const prefixes: string[] = []
  for (const entry of catalog) {
    for (const prefix of entry.prefixes ?? []) {
      if (prefix) prefixes.push(prefix)
    }
  }
  return prefixes
}

export function matchingProvider<T extends PrefixCatalogEntry>(
  model: string,
  catalog: readonly T[],
): T | undefined {
  let best: T | undefined
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
 * Error when a model id cannot be routed. Null when the default provider
 * (OpenRouter) should serve it: any slash prefix that is not reserved,
 * a bare alias, or an empty id.
 */
export function inferencePrefixError(
  model: string,
  catalog: readonly PrefixCatalogEntry[],
): string | null {
  const text = model || ''
  if (!text) return null
  if (matchingProvider(text, catalog)) return null
  const registered = registeredPrefixes(catalog).join(', ') || 'none'
  for (const item of loadReservedDirectPrefixes()) {
    if (!text.startsWith(item.prefix)) continue
    const rest = text.slice(item.prefix.length)
    const vendorSentence = item.openrouterVendor
      ? ` ${item.openrouterVendor}${rest} still routes to OpenRouter.`
      : ''
    return (
      `Model '${text}' uses the reserved prefix '${item.prefix}' `
      + `for ${item.displayName}. That direct provider is not registered yet.`
      + `${vendorSentence} `
      + `Registered prefixes: ${registered}.`
    )
  }
  // Registered prefixes already returned above. Any other slash id,
  // including OpenRouter vendors that are not in vendor-prefixes.json,
  // stays on the default provider.
  if (text.includes('/')) return null
  if (openrouterHandlesBare(text)) return null
  const reserved = loadReservedDirectPrefixes().map(item => item.prefix).join(', ')
  return (
    `Model '${text}' has no provider prefix. `
    + `OpenRouter models look like openai/gpt-4o or openrouter/openai/gpt-4o. `
    + `Direct providers use ${reserved}. `
    + `A bare alias such as claude-sonnet-4 still uses OpenRouter.`
  )
}
