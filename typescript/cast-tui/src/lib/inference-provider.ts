/**
 * Inference-provider picker with no OpenTUI imports.
 * Tests transpile this file. The modal shells out to `cast provider`
 * each time it opens, so a new provider shows up without restarting the TUI.
 */

export const INFERENCE_PROVIDER_MODAL_TITLE = 'Inference Provider'

export interface InferenceProviderRow {
  key: string
  displayName: string
  enabled: boolean
  current: boolean
  baseUrl: string
  defaultBaseUrl: string
}

export type ProviderField = 'list' | 'token' | 'url'

export function providerListArgv(): string[] {
  return ['provider', '--json']
}

export function providerSwitchArgv(key: string): string[] {
  return ['provider', key]
}

/** Token is written to the child stdin, not argv. Omit --url when it is unchanged. */
export function providerEnableArgv(key: string, url: string, defaultUrl: string): string[] {
  const args = ['provider', 'enable', key, '--token', '-']
  if (url.trim() !== defaultUrl.trim()) args.push('--url', url.trim())
  return args
}

export function formatProviderRow(row: InferenceProviderRow, selected: boolean): string {
  const mark = selected ? '▸' : '  '
  const enabled = row.enabled ? 'enabled' : 'not enabled'
  const current = row.current ? ' (current)' : ''
  return `${mark} ${row.displayName}  ${enabled}${current}`
}

export function wrapProviderIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const next = (index + delta) % length
  return next < 0 ? next + length : next
}

/** Enter on a disabled row collects a token. Enter on another enabled row switches. */
export function providerEnterAction(row: InferenceProviderRow | undefined): 'switch' | 'enable' | 'noop' {
  if (!row) return 'noop'
  if (!row.enabled) return 'enable'
  if (row.current) return 'noop'
  return 'switch'
}

export function maskSecret(secret: string): string {
  return '•'.repeat(secret.length)
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

export function parseProviderList(stdout: string): InferenceProviderRow[] {
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed)) throw new Error('cast provider --json did not return a list')
  const rows: InferenceProviderRow[] = []
  for (const item of parsed) {
    if (!item || typeof item.key !== 'string' || typeof item.displayName !== 'string') continue
    rows.push({
      key: item.key,
      displayName: item.displayName,
      enabled: Boolean(item.enabled),
      current: Boolean(item.current),
      baseUrl: typeof item.baseUrl === 'string' ? item.baseUrl : '',
      defaultBaseUrl: typeof item.defaultBaseUrl === 'string' ? item.defaultBaseUrl : '',
    })
  }
  return rows
}

export function providerSuccessMessage(name: string, model: string): string {
  const modelLine = model ? `\nBuilder model: ${model}` : ''
  return `Inference provider set to ${name}.${modelLine}\nRestart the builder to apply: cast dev`
}
