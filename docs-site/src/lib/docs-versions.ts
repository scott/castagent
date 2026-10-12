/**
 * Docs version manifest, path mapping, and snapshot packing.
 *
 * Href values are absolute site paths. A relative URL would be rewritten by
 * `<base href="/vX.Y.Z/">` and nest the version prefix. The latest package
 * version is served at `/` and is not unpacked under `/vX.Y.Z/`.
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const PICKER_FROZEN_LIMIT = 5
export const OLDER_VERSIONS_HREF = '/versions'

const PRODUCT_TAG = /^v(\d+\.\d+\.\d+)$/

export interface VersionEntry {
  version: string
  label: string
  href: string
  latest: boolean
}

export interface VersionsManifest {
  latest: string
  versions: VersionEntry[]
}

export type PickerRow =
  | { kind: 'version'; entry: VersionEntry }
  | { kind: 'older'; href: typeof OLDER_VERSIONS_HREF }

export interface PickerState {
  open: boolean
  index: number
  count: number
}

export type PickerAction = 'none' | 'open' | 'close' | 'select' | 'move'

export interface PickerKeyResult {
  open: boolean
  index: number
  action: PickerAction
}

export interface ReleaseInput {
  tag: string
  hasDocsAsset?: boolean
}

export interface DocsReleaseAsset {
  tag: string
  isDraft?: boolean
  assetNames: string[]
}

export interface GitHubReleasePayload {
  tag_name?: string
  tagName?: string
  draft?: boolean
  isDraft?: boolean
  assets?: { name?: string }[]
  assetNames?: string[]
}

/** `gh api repos/.../releases` rows. `gh release list` does not include assets. */
export function docsReleasesFromApi(payload: GitHubReleasePayload[]): DocsReleaseAsset[] {
  return payload.map(row => ({
    tag: row.tag_name || row.tagName || '',
    isDraft: Boolean(row.draft || row.isDraft),
    assetNames: row.assetNames ?? (row.assets ?? []).map(asset => asset.name || '').filter(Boolean),
  }))
}

export interface RetainedDocsArchive {
  version: string
  tag: string
  asset: string
}

export function canonicalVersion(version: string): string {
  const stripped = version.trim().replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+$/.test(stripped)) {
    throw new Error(`Invalid docs version: ${version}`)
  }
  return stripped
}

/** Product releases only. `cast-cli@*` and `cast-tui@*` are not docs versions. */
export function parseProductTag(tag: string): string | null {
  const match = PRODUCT_TAG.exec(tag)
  return match ? match[1] : null
}

export function compareVersionsDesc(a: string, b: string): number {
  const left = a.split('.').map(part => Number.parseInt(part, 10))
  const right = b.split('.').map(part => Number.parseInt(part, 10))
  for (let i = 0; i < 3; i++) {
    const diff = (right[i] ?? 0) - (left[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function docsAssetName(version: string): string {
  return `docs-v${canonicalVersion(version)}.tar.gz`
}

export function retainedDocsReleases(
  latestVersion: string,
  releases: DocsReleaseAsset[],
): RetainedDocsArchive[] {
  const latest = canonicalVersion(latestVersion)
  const found = new Map<string, RetainedDocsArchive>()
  for (const release of releases) {
    if (release.isDraft) continue
    const version = parseProductTag(release.tag)
    if (!version || version === latest) continue
    const asset = docsAssetName(version)
    if (!release.assetNames.includes(asset)) continue
    if (!found.has(version)) found.set(version, { version, tag: release.tag, asset })
  }
  return [...found.values()].sort((a, b) => compareVersionsDesc(a.version, b.version))
}

export function buildVersionsManifest(
  latestVersion: string,
  releases: ReleaseInput[],
): VersionsManifest {
  const latest = canonicalVersion(latestVersion)
  const frozen = new Set<string>()
  for (const release of releases) {
    const version = parseProductTag(release.tag)
    if (!version || version === latest || !release.hasDocsAsset) continue
    frozen.add(version)
  }
  const versions: VersionEntry[] = [
    { version: latest, label: `v${latest}`, href: '/', latest: true },
    ...[...frozen].sort(compareVersionsDesc).map(version => ({
      version,
      label: `v${version}`,
      href: `/v${version}/`,
      latest: false,
    })),
  ]
  return { latest, versions }
}

export function versionsManifestFromReleases(
  latestVersion: string,
  releases: DocsReleaseAsset[],
): VersionsManifest {
  const retained = retainedDocsReleases(latestVersion, releases)
  return buildVersionsManifest(
    latestVersion,
    retained.map(release => ({ tag: release.tag, hasDocsAsset: true })),
  )
}

export function pickerRows(versions: VersionEntry[], limit = PICKER_FROZEN_LIMIT): PickerRow[] {
  const latest = versions.filter(entry => entry.latest)
  const frozen = versions.filter(entry => !entry.latest)
  const rows: PickerRow[] = [
    ...latest.map(entry => ({ kind: 'version' as const, entry })),
    ...frozen.slice(0, limit).map(entry => ({ kind: 'version' as const, entry })),
  ]
  if (frozen.length > limit) rows.push({ kind: 'older', href: OLDER_VERSIONS_HREF })
  return rows
}

export function normalizeVersionHref(href: string): string {
  if (!href || href === '/') return '/'
  let value = href.startsWith('/') ? href : `/${href}`
  if (!value.endsWith('/')) value += '/'
  return value
}

/**
 * Keep the page path when switching versions.
 * `/overview` + v2.2.0 → `/v2.2.0/overview`. `/v2.2.0/` + latest → `/`.
 */
export function mapDocsPath(currentPath: string, fromHref: string, toHref: string): string {
  const from = normalizeVersionHref(fromHref)
  const to = normalizeVersionHref(toHref)
  let raw = currentPath || '/'
  let suffix = ''
  const cuts = ['?', '#'].map(mark => raw.indexOf(mark)).filter(index => index >= 0).sort((a, b) => a - b)
  if (cuts.length > 0) {
    suffix = raw.slice(cuts[0])
    raw = raw.slice(0, cuts[0])
  }
  if (!raw.startsWith('/')) raw = `/${raw}`

  let rest = raw
  if (from !== '/') {
    const prefix = from.slice(0, -1)
    if (rest === prefix || rest === `${prefix}/`) rest = '/'
    else if (rest.startsWith(`${prefix}/`)) rest = rest.slice(prefix.length)
  }

  let mapped: string
  if (to === '/') mapped = rest
  else if (rest === '/') mapped = to
  else mapped = to.slice(0, -1) + rest
  return mapped + suffix
}

/** Enter selects; Space toggles; Escape closes without navigating; arrows wrap. */
export function pickerKey(state: PickerState, key: string): PickerKeyResult {
  if (key === 'Escape') {
    return { open: false, index: state.index, action: state.open ? 'close' : 'none' }
  }
  if (key === ' ' || key === 'Spacebar') {
    return { open: !state.open, index: state.index, action: state.open ? 'close' : 'open' }
  }
  if (key === 'Enter') {
    if (!state.open) return { open: true, index: state.index, action: 'open' }
    return { open: true, index: state.index, action: 'select' }
  }
  if (key === 'ArrowDown' || key === 'ArrowUp') {
    if (!state.open || state.count <= 0) {
      return { open: true, index: state.index, action: 'open' }
    }
    const delta = key === 'ArrowDown' ? 1 : -1
    let index = (state.index + delta) % state.count
    if (index < 0) index += state.count
    return { open: true, index, action: 'move' }
  }
  return { open: state.open, index: state.index, action: 'none' }
}

function classList(tag: string): string[] {
  const match = tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i)
  if (!match) return []
  return (match[1] ?? match[2] ?? '').split(/\s+/).filter(Boolean)
}

function findAnchor(html: string, className: string): { start: number; end: number } | null {
  const re = /<a\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(html))) {
    if (!classList(match[0]).includes(className)) continue
    const close = html.indexOf('</a>', match.index + match[0].length)
    if (close < 0) return null
    return { start: match.index, end: close + '</a>'.length }
  }
  return null
}

function withMarginReset(anchorHtml: string): string {
  const openEnd = anchorHtml.indexOf('>')
  if (openEnd < 0) return anchorHtml
  if (/\bstyle\s*=/.test(anchorHtml.slice(0, openEnd))) return anchorHtml
  return anchorHtml.replace(/<a\b/, '<a style="margin-bottom:0"')
}

function ensureHtmlVersion(html: string, version: string): string {
  return html.replace(/<html\b([^>]*)>/i, (full, attrs: string) => {
    if (/\bdata-docs-version\s*=/.test(full)) return full
    return `<html${attrs} data-docs-version="${version}">`
  })
}

/**
 * Insert the picker mount and absolute script next to `.brand` or
 * `.landing-brand`. Files with neither are left alone. A second call is a no-op
 * so unpacking an already-injected archive does not change bytes.
 */
export function injectPicker(html: string, version: string): string {
  if (html.includes('data-version-picker')) return html
  const ver = canonicalVersion(version)
  const landing = findAnchor(html, 'landing-brand')
  const anchor = landing ?? findAnchor(html, 'brand')
  if (!anchor) return html
  // Old snapshots have no .brand-row. Wrap the wordmark and the control so the
  // landing header's space-between layout does not push the picker to the center.
  const groupClass = landing ? 'landing-brand-group' : 'brand-row'
  const groupStyle = landing
    ? 'display:inline-flex;align-items:center;gap:0.65rem'
    : 'display:flex;align-items:center;gap:0.65rem;margin-bottom:1.5rem'
  const mount =
    `<div class="version-picker" data-version-picker data-docs-version="${ver}"></div>` +
    `<script src="/version-picker.js"></script>`
  const wrapped =
    `<div class="${groupClass}" style="${groupStyle}">` +
    `${withMarginReset(html.slice(anchor.start, anchor.end))}${mount}</div>`
  const next = html.slice(0, anchor.start) + wrapped + html.slice(anchor.end)
  return ensureHtmlVersion(next, ver)
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '.DS_Store' || name.startsWith('._')) continue
    const file = join(dir, name)
    const stat = statSync(file)
    if (stat.isDirectory()) walkFiles(file, out)
    else if (stat.isFile()) out.push(file)
  }
  return out
}

export function injectPickerTree(dir: string, version: string): void {
  for (const file of walkFiles(dir)) {
    if (!file.endsWith('.html')) continue
    const before = readFileSync(file, 'utf8')
    const after = injectPicker(before, version)
    if (after !== before) writeFileSync(file, after)
  }
}

function tarEnv(): NodeJS.ProcessEnv {
  return { ...process.env, COPYFILE_DISABLE: '1' }
}

function commandError(result: { status: number | null; stderr?: Buffer | string }): string {
  const err = result.stderr
  if (!err) return String(result.status)
  return typeof err === 'string' ? err : err.toString()
}

export function packDocsDirectory(dir: string, archivePath: string): void {
  const result = spawnSync(
    'tar',
    ['--exclude=._*', '--exclude=.DS_Store', '-czf', archivePath, '-C', dir, '.'],
    { env: tarEnv(), stdio: 'pipe' },
  )
  if (result.status !== 0) {
    throw new Error(`tar create failed: ${commandError(result)}`)
  }
}

/** Extract a release asset. Injects the picker only where the HTML lacks one. */
export function unpackDocsArchive(archivePath: string, destDir: string, version: string): void {
  rmSync(destDir, { recursive: true, force: true })
  mkdirSync(destDir, { recursive: true })
  const result = spawnSync('tar', ['-xzf', archivePath, '-C', destDir], {
    env: tarEnv(),
    stdio: 'pipe',
  })
  if (result.status !== 0) {
    throw new Error(`tar extract failed: ${commandError(result)}`)
  }
  const cname = join(destDir, 'CNAME')
  if (existsSync(cname)) rmSync(cname)
  injectPickerTree(destDir, version)
}
