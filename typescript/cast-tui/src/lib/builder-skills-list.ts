/**
 * Builder-skill list formatting and GitHub source classification.
 * No OpenTUI imports: the slash registry cannot be loaded under Node,
 * and tests transpile this file on its own.
 *
 * GitHub shapes match typescript/cast-cli/src/lib/builder-skills.ts.
 */

export interface BuilderSkillRow {
  name: string
  description: string
  subpath?: string
}

export interface GithubSkillSource {
  owner: string
  repo: string
  ref?: string
  subpath?: string
}

export const SKILL_DESCRIPTION_LIMIT = 50

const GITHUB_HOST_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const REF_RE = /^[A-Za-z0-9._/-]+$/

export function truncateSkillDescription(description: string, limit = SKILL_DESCRIPTION_LIMIT): string {
  const oneLine = description.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= limit) return oneLine
  if (limit <= 3) return oneLine.slice(0, limit)
  return oneLine.slice(0, limit - 3) + '...'
}

export function sortBuilderSkillRows<T extends {name: string}>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.name < b.name) return -1
    if (a.name > b.name) return 1
    const aPath = String((a as {subpath?: string}).subpath ?? '')
    const bPath = String((b as {subpath?: string}).subpath ?? '')
    if (aPath < bPath) return -1
    if (aPath > bPath) return 1
    return 0
  })
}

export function wrapSkillIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const next = (index + delta) % length
  return next < 0 ? next + length : next
}

/** Selected rows start with `▸ `; other rows start with two spaces. No numbers. */
export function formatBuilderSkillRow(row: BuilderSkillRow, selected: boolean): string {
  const prefix = selected ? '▸ ' : '  '
  const description = truncateSkillDescription(row.description)
  return description ? `${prefix}${row.name}  ${description}` : `${prefix}${row.name}`
}

export function formatBuilderSkillRows(rows: readonly BuilderSkillRow[], selectedIndex: number): string[] {
  const sorted = sortBuilderSkillRows(rows)
  return sorted.map((row, index) => formatBuilderSkillRow(row, index === selectedIndex))
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function validRef(ref: string): boolean {
  return REF_RE.test(ref) && !ref.includes('..') && !ref.startsWith('/') && !ref.endsWith('/')
}

function validSubpath(subpath: string): boolean {
  if (!subpath || subpath.startsWith('/') || subpath.endsWith('/') || subpath.includes('\\')) return false
  const parts = subpath.split('/')
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..')
}

export function parseGithubSkillSource(input: string): GithubSkillSource | null {
  let raw = input.trim()
  if (!raw) return null
  raw = raw.replace(/[?#].*$/, '').replace(/\/+$/, '')
  if (!raw || raw.includes('\\') || /\s/.test(raw)) return null

  const host = raw.match(GITHUB_HOST_RE)
  if (host) return parseGithubPath(host[1], true)
  if (raw.startsWith('.') || raw.startsWith('/')) return null
  if (!/^[^:\s]+\/[^:\s]+/.test(raw)) return null
  return parseGithubPath(raw, false)
}

function parseGithubPath(spec: string, fromUrl: boolean): GithubSkillSource | null {
  const parts = spec.split('/').filter((part) => part.length > 0).map(safeDecode)
  if (parts.length < 2) return null

  let repoPart = parts[1]
  let refFromAt: string | undefined
  const at = repoPart.indexOf('@')
  if (at !== -1) {
    refFromAt = repoPart.slice(at + 1)
    repoPart = repoPart.slice(0, at)
  }
  if (repoPart.endsWith('.git')) repoPart = repoPart.slice(0, -4)

  const owner = parts[0]
  if (!OWNER_RE.test(owner) || !REPO_RE.test(repoPart) || repoPart === '.' || repoPart === '..') {
    return null
  }
  if (refFromAt !== undefined && !validRef(refFromAt)) return null

  const extra = parts.slice(2)
  if (fromUrl) {
    if (refFromAt) return null
    if (extra.length === 0) return {owner, repo: repoPart}
    if (extra[0] !== 'tree' || extra.length < 2) return null
    const ref = extra[1]
    if (!validRef(ref)) return null
    const subpath = extra.slice(2).join('/')
    if (subpath && !validSubpath(subpath)) return null
    return subpath ? {owner, repo: repoPart, ref, subpath} : {owner, repo: repoPart, ref}
  }

  if (extra.length === 0) {
    return refFromAt ? {owner, repo: repoPart, ref: refFromAt} : {owner, repo: repoPart}
  }
  const subpath = extra.join('/')
  if (!validSubpath(subpath)) return null
  if (refFromAt) return {owner, repo: repoPart, ref: refFromAt, subpath}
  return {owner, repo: repoPart, subpath}
}

/** Existing directories win. Otherwise a GitHub shape is a repo, and anything else is not installable from the command line. */
export function classifyBuilderSkillAddSource(source: string, directoryExists: boolean): 'folder' | 'github' | 'invalid' {
  if (directoryExists) return 'folder'
  if (parseGithubSkillSource(source)) return 'github'
  return 'invalid'
}
