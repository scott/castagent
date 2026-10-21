import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import YAML from 'yaml'

/**
 * Used when the project virtualenv cannot be frozen.
 * Direct runtime minimums are declared in python/pyproject.toml.
 * Packages named there use the same floors here, so a deploy that cannot
 * read pyproject.toml does not install the older minimums.
 * renderRequirementsFile still keeps the higher minimum when both name a package.
 * GitPython is appended later when the frozen list and pyproject.toml both omit it.
 */
export const FALLBACK_REQUIREMENTS = `anyio>=4.13.0
certifi>=2026.10.19
charset-normalizer>=3.4.7
distro>=1.9.0
httpx>=0.28.1
idna>=3.13
jiter>=0.14.0
jsonpatch>=1.33
jsonpointer>=3.1.1
langchain>=1.2.15
langchain-anthropic>=1.7.6
langchain-core>=1.6.12
langchain-openai>=1.7.2
langgraph>=1.2.16
langgraph-checkpoint>=4.0.3
langgraph-prebuilt>=1.0.12
langgraph-sdk>=0.3.13
openai>=2.33.0
orjson>=3.11.8
packaging>=26.2
pydantic>=2.13.3
pydantic_core>=2.46.3
python-dotenv>=1.2.2
PyYAML>=6.0.3
regex>=2026.4.4
requests>=2.33.1
requests-toolbelt>=1.0.0
sniffio>=1.3.1
starlette>=1.9.0
tenacity>=9.1.4
tiktoken>=0.12.0
tqdm>=4.67.3
typing-extensions>=4.16.0
typing-inspection>=0.4.2
urllib3>=2.6.3
uvicorn>=0.54.0
xxhash>=3.7.0
`

/** The runtime imports GitPython before the server binds. 3.2.1 is outside every historical OSV range. */
export const GITPYTHON_REQUIREMENT = 'GitPython>=3.2.1'

/**
 * PEP 503 name so GitPython, gitpython, and git_python compare as one package.
 * Runs of `-`, `_`, and `.` collapse to a single `-`.
 */
export function canonicalRequirementName(spec: string): string {
  return parseRequirement(spec).canonical
}

/**
 * Lower bound from >=, ==, ~=, or ===, taken from the specifier and not the
 * environment marker. A bare name has none. Epochs and implicit post-releases
 * stay in the returned text.
 */
export function requirementLowerBound(spec: string): string | null {
  const parsed = parseRequirement(spec)
  if (parsed.url || parsed.opaque) return null
  let best: string | null = null
  for (const item of parsed.specs) {
    if (item.op !== '>=' && item.op !== '==' && item.op !== '~=' && item.op !== '===') continue
    let version = item.version
    if (item.op === '==' && version.endsWith('.*')) version = version.slice(0, -2)
    if (!best || compareVersions(version, best) > 0) best = version
  }
  return best
}

const PRE_RANK: Record<string, number> = {
  a: 1,
  alpha: 1,
  b: 2,
  beta: 2,
  c: 3,
  rc: 3,
  pre: 3,
  preview: 3,
}

type ParsedVersion = {
  epoch: number
  release: number[]
  pre: {rank: number; n: number} | null
  post: number | null
  dev: number | null
  local: string[] | null
}

const ZERO_VERSION: ParsedVersion = {epoch: 0, release: [0], pre: null, post: null, dev: null, local: null}

/**
 * PEP 440, including the epoch (`1!0.5`) and the implicit post-release
 * (`1.2.16-1`, same as `1.2.16.post1`). A local segment sorts above the
 * same public version. Unparseable text sorts as 0.
 */
const VERSION_RE = new RegExp(
  '^v?' +
  '(?:(?<epoch>\\d+)!)?' +
  '(?<release>\\d+(?:\\.\\d+)*)' +
  '(?:' +
    '[-_.]?' +
    '(?<pre_l>alpha|a|beta|b|preview|pre|c|rc)' +
    '[-_.]?' +
    '(?<pre_n>\\d+)?' +
  ')?' +
  '(?:' +
    '(?:-(?<post_n1>\\d+))' +
    '|' +
    '(?:' +
      '[-_.]?' +
      '(?<post_l>post|rev|r)' +
      '[-_.]?' +
      '(?<post_n>\\d+)?' +
    ')' +
  ')?' +
  '(?:' +
    '[-_.]?' +
    '(?<dev_l>dev)' +
    '[-_.]?' +
    '(?<dev_n>\\d+)?' +
  ')?' +
  '(?:\\+(?<local>[a-z0-9]+(?:[-_.][a-z0-9]+)*))?' +
  '$',
  'i',
)

function parseVersion(version: string): ParsedVersion {
  let raw = version.trim()
  if (/^v\d/i.test(raw)) raw = raw.slice(1)
  if (raw.endsWith('.*')) raw = raw.slice(0, -2)
  const groups = VERSION_RE.exec(raw)?.groups
  if (!groups?.release) return ZERO_VERSION
  const preLabel = (groups.pre_l || '').toLowerCase()
  const pre = preLabel in PRE_RANK
    ? {rank: PRE_RANK[preLabel], n: groups.pre_n ? Number(groups.pre_n) : 0}
    : null
  let post: number | null = null
  if (groups.post_n1) post = Number(groups.post_n1)
  else if (groups.post_l) post = groups.post_n ? Number(groups.post_n) : 0
  const dev = groups.dev_l ? (groups.dev_n ? Number(groups.dev_n) : 0) : null
  const local = groups.local ? groups.local.split(/[-_.]+/) : null
  return {
    epoch: groups.epoch ? Number(groups.epoch) : 0,
    release: groups.release.split('.').map(part => Number(part)),
    pre,
    post,
    dev,
    local,
  }
}

const MISSING_HIGH = Number.MAX_SAFE_INTEGER

function preKey(version: ParsedVersion): number {
  if (version.pre) return version.pre.rank
  if (version.dev !== null && version.post === null) return -1
  return MISSING_HIGH
}

/**
 * PEP 440 local segments: numeric compares as an integer and sorts above
 * alphanumeric. Alphanumeric compares case-insensitively. `1.0+1` > `1.0+a`.
 */
function compareLocalPart(left: string, right: string): number {
  const leftNum = /^\d+$/.test(left)
  const rightNum = /^\d+$/.test(right)
  if (leftNum && rightNum) return Number(left) - Number(right)
  if (leftNum !== rightNum) return leftNum ? 1 : -1
  const a = left.toLowerCase()
  const b = right.toLowerCase()
  if (a === b) return 0
  return a < b ? -1 : 1
}

function compareLocal(left: string[] | null, right: string[] | null): number {
  if (!left && !right) return 0
  if (!left) return -1
  if (!right) return 1
  const length = Math.max(left.length, right.length)
  for (let i = 0; i < length; i++) {
    if (i >= left.length) return -1
    if (i >= right.length) return 1
    const diff = compareLocalPart(left[i], right[i])
    if (diff !== 0) return diff
  }
  return 0
}

/** Compare versions. A pre-release or dev release sorts below the final release. Missing numeric parts are 0. An implicit post-release sorts above the final release. A higher epoch sorts above a lower one. */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a.epoch !== b.epoch) return a.epoch - b.epoch
  const length = Math.max(a.release.length, b.release.length)
  for (let i = 0; i < length; i++) {
    const diff = (a.release[i] ?? 0) - (b.release[i] ?? 0)
    if (diff !== 0) return diff
  }
  const preDiff = preKey(a) - preKey(b)
  if (preDiff !== 0) return preDiff
  if (a.pre && b.pre && a.pre.n !== b.pre.n) return a.pre.n - b.pre.n
  const postDiff = (a.post ?? -1) - (b.post ?? -1)
  if (postDiff !== 0) return postDiff
  const devDiff = (a.dev ?? MISSING_HIGH) - (b.dev ?? MISSING_HIGH)
  if (devDiff !== 0) return devDiff
  return compareLocal(a.local, b.local)
}

type SpecOp = '===' | '==' | '!=' | '<=' | '>=' | '~=' | '<' | '>'

interface Specifier {
  op: SpecOp
  version: string
}

interface ParsedRequirement {
  name: string
  canonical: string
  extras: string
  url: string | null
  specs: Specifier[]
  marker: string | null
  hashes: boolean
  opaque: boolean
}

const SPEC_OPS: SpecOp[] = ['===', '==', '!=', '<=', '>=', '~=', '<', '>']
const NAME_RE = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/

function emptyRequirement(): ParsedRequirement {
  return {name: '', canonical: '', extras: '', url: null, specs: [], marker: null, hashes: false, opaque: false}
}

/** A `#` comment starts at whitespace. `#` inside a URL, such as `#egg=`, stays. */
function stripInlineComment(input: string): string {
  let quote: string | null = null
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      if (ch === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(input[i - 1]))) return input.slice(0, i).trimEnd()
  }
  return input
}

function findCut(text: string): {specEnd: number; markerAt: number; hashAt: number} {
  let quote: string | null = null
  let markerAt = -1
  let hashAt = -1
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ';' && markerAt < 0) markerAt = i
    if (hashAt < 0 && text.startsWith('--hash', i)) hashAt = i
  }
  const points = [markerAt, hashAt].filter(point => point >= 0)
  return {specEnd: points.length ? Math.min(...points) : text.length, markerAt, hashAt}
}

function parseSpecifiers(text: string): Specifier[] | null {
  const specs: Specifier[] = []
  let rest = text.trim()
  if (!rest) return specs
  while (rest) {
    const op = SPEC_OPS.find(candidate => rest.startsWith(candidate))
    if (!op) return null
    rest = rest.slice(op.length).trimStart()
    const match = /^([^\s,]+)/.exec(rest)
    if (!match) return null
    let version = match[1]
    if (/^v\d/i.test(version)) version = version.slice(1)
    specs.push({op, version})
    rest = rest.slice(match[1].length).trimStart()
    if (rest.startsWith(',')) {
      rest = rest.slice(1).trimStart()
      if (!rest) return null
    } else if (rest) {
      return null
    }
  }
  return specs
}

function parseRequirement(raw: string): ParsedRequirement {
  const code = stripInlineComment(raw.trim())
  const nameMatch = NAME_RE.exec(code)
  if (!nameMatch) return emptyRequirement()
  const name = nameMatch[1]
  let rest = code.slice(name.length)
  let extras = ''
  const extrasMatch = /^\s*\[([^\]]*)\]/.exec(rest)
  if (extrasMatch) {
    extras = extrasMatch[1]
    rest = rest.slice(extrasMatch[0].length)
  }
  const cut = findCut(rest)
  let marker: string | null = null
  if (cut.markerAt >= 0) {
    const after = rest.slice(cut.markerAt + 1)
    const hashInMarker = findCut(after).hashAt
    marker = (hashInMarker >= 0 ? after.slice(0, hashInMarker) : after).trim()
  }
  const body = rest.slice(0, cut.specEnd).trim()
  const parsed: ParsedRequirement = {
    name,
    canonical: name.toLowerCase().replace(/[-_.]+/g, '-'),
    extras,
    url: null,
    specs: [],
    marker,
    hashes: cut.hashAt >= 0,
    opaque: false,
  }
  if (!body) return parsed
  if (/^@(\s|$)/.test(body)) {
    const url = body.replace(/^@\s*/, '').trim()
    if (!url) return {...parsed, opaque: true}
    return {...parsed, url}
  }
  const specs = parseSpecifiers(body)
  if (!specs) return {...parsed, opaque: true}
  return {...parsed, specs}
}

function wildcardUpper(version: string): string | null {
  if (!version.endsWith('.*')) return null
  const parts = version.slice(0, -2).split('.')
  if (!parts.length || parts.some(part => !/^\d+$/.test(part))) return null
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1)
  return parts.join('.')
}

function matchesPrefix(version: string, prefix: string): boolean {
  if (!versionParses(version)) return false
  const parts = prefix.split('.')
  if (parts.some(part => !/^\d+$/.test(part))) return false
  const parsed = parseVersion(version)
  for (let i = 0; i < parts.length; i++) {
    if ((parsed.release[i] ?? 0) !== Number(parts[i])) return false
  }
  return true
}

function compatibleUpper(version: string): string | null {
  const parsed = parseVersion(version)
  if (!versionParses(version) || parsed.release.length < 2) return null
  const prefix = parsed.release.slice(0, -1)
  prefix[prefix.length - 1] += 1
  return prefix.join('.')
}

function versionParses(version: string): boolean {
  return parseVersion(version) !== ZERO_VERSION
}

function conflictsWithFloor(parsed: ParsedRequirement, floor: string): boolean {
  if (parsed.opaque) return true
  for (const spec of parsed.specs) {
    if (spec.op === '==' && spec.version.endsWith('.*')) {
      const prefix = spec.version.slice(0, -2)
      const upper = wildcardUpper(spec.version)
      if (!upper || !versionParses(prefix)) return true
      if (compareVersions(upper, floor) <= 0) return true
      const above = compareVersions(prefix, floor) > 0
      const inside = matchesPrefix(floor, prefix) && compareVersions(floor, upper) < 0
      if (!above && !inside) return true
      continue
    }
    if (spec.op === '==' || spec.op === '===') {
      if (!versionParses(spec.version) || compareVersions(spec.version, floor) < 0) return true
      continue
    }
    if (spec.op === '<' && compareVersions(spec.version, floor) <= 0) return true
    if (spec.op === '<=' && compareVersions(spec.version, floor) < 0) return true
    if (spec.op === '~=') {
      const upper = compatibleUpper(spec.version)
      if (!upper || compareVersions(floor, upper) >= 0) return true
    }
  }
  return false
}

function allowsBelowFloor(parsed: ParsedRequirement, floor: string): boolean {
  const lowers = parsed.specs.filter(spec =>
    spec.op === '>=' || spec.op === '>' || spec.op === '==' || spec.op === '===' || spec.op === '~='
  )
  if (lowers.length === 0) return parsed.specs.length > 0
  return lowers.some(spec => {
    const version = spec.op === '==' && spec.version.endsWith('.*') ? spec.version.slice(0, -2) : spec.version
    return compareVersions(version, floor) < 0
  })
}

/** Raise >= clauses below the floor. Other clauses and markers stay. */
function raiseLowerBound(spec: string, floor: string): string {
  const trimmed = spec.trim()
  const cut = findCut(trimmed)
  const head = trimmed.slice(0, cut.specEnd)
  const tail = trimmed.slice(cut.specEnd)
  let raised = false
  const next = head.replace(/(>=\s*)([^\s,]+)/g, (full, op: string, ver: string) => {
    const bare = ver.replace(/^v/i, '')
    if (compareVersions(bare, floor) < 0) {
      raised = true
      return `${op}${floor}`
    }
    return full
  })
  if (raised) return `${next}${tail}`
  const lower = requirementLowerBound(trimmed)
  if (!lower || compareVersions(lower, floor) < 0) {
    const trimmedHead = next.replace(/\s+$/, '')
    const joiner = /[=<>!~]/.test(trimmedHead) ? ',' : ''
    return `${trimmedHead}${joiner}>=${floor}${tail}`
  }
  return trimmed
}

function isSimpleLowerBound(parsed: ParsedRequirement): boolean {
  return parsed.specs.length === 1 && parsed.specs[0].op === '>=' && !parsed.url && !parsed.opaque && parsed.marker === null
}

function isSimpleFloorLine(spec: string): boolean {
  const parsed = parseRequirement(spec)
  return !parsed.extras && !parsed.url && parsed.marker === null && !parsed.hashes && !parsed.opaque
    && parsed.specs.length === 1
    && (parsed.specs[0].op === '>=' || parsed.specs[0].op === '==')
}

function withExtras(line: string, extras: string): string {
  const trimmed = line.trim()
  const match = NAME_RE.exec(trimmed)
  if (!match) return trimmed
  const extrasMatch = /^\s*\[[^\]]*\]/.exec(trimmed.slice(match[0].length))
  const restAt = match[0].length + (extrasMatch ? extrasMatch[0].length : 0)
  return `${match[1]}[${extras}]${trimmed.slice(restAt)}`
}

/** A pin or upper bound that cannot meet the floor. Deploy stops before the image build. */
export class RequirementError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RequirementError'
  }
}

/** Hide `user:token` in any URL before it reaches stderr or CI logs. `https://***@host/...`. */
export function maskUrlUserinfo(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, '$1***@')
}

function failRequirement(message: string): never {
  throw new RequirementError(maskUrlUserinfo(message))
}

function floorConflict(name: string, agentSpec: string, existingLine: string, fromAgent: boolean): never {
  if (fromAgent) {
    failRequirement(
      `Runtime requirement for ${name} conflicts with another requirement from the agent. ` +
      `The agent specifies "${agentSpec}" and an earlier agent requirement is ${existingLine}. ` +
      `Change the agent's lines so they can be installed together, or remove one from runtime.requirements.`
    )
  }
  failRequirement(
    `Runtime requirement for ${name} cannot meet the required floor. ` +
    `The agent specifies "${agentSpec}" and the required floor is ${existingLine}. ` +
    `Raise the pin or upper bound to at least that floor, or remove the line from runtime.requirements.`
  )
}

function malformedRequirement(line: string): never {
  failRequirement(
    `Invalid runtime requirement "${line}". The line is malformed. ` +
    `Fix it in runtime.requirements.`
  )
}

/**
 * Drop `--hash` / `--hash=` options. Leaving one on any line turns on
 * pip require-hashes mode, and the floor lines have no hashes, so install fails.
 */
function stripHashOptions(input: string): {line: string; stripped: boolean} {
  let quote: string | null = null
  let out = ''
  let stripped = false
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (quote) {
      out += ch
      if (ch === quote && input[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    const atHash = (i === 0 || /\s/.test(input[i - 1])) && input.startsWith('--hash', i)
    if (!atHash) {
      out += ch
      continue
    }
    stripped = true
    i += '--hash'.length
    if (input[i] === '=') {
      i += 1
      while (i < input.length && !/\s/.test(input[i])) i++
    } else {
      while (i < input.length && /\s/.test(input[i])) i++
      if (input[i] === '"' || input[i] === "'") {
        const quoteChar = input[i]
        i += 1
        while (i < input.length && input[i] !== quoteChar) i++
        if (i < input.length) i += 1
      } else {
        while (i < input.length && !/\s/.test(input[i])) i++
      }
    }
    i -= 1
  }
  return {line: out.replace(/[ \t]{2,}/g, ' ').trim(), stripped}
}

const HASH_WARNING = 'Warning: --hash options are not supported in deploy requirements and were removed.'

function directReferenceWarning(requirement: string, existing: string | null, alongside: boolean): string {
  if (existing && alongside) {
    return `Warning: runtime requirement "${requirement}" is a direct reference and cannot be checked against ${existing}. Keeping the agent's line and ${existing}.`
  }
  if (existing) {
    return `Warning: runtime requirement "${requirement}" is a direct reference and cannot be checked against ${existing}. Keeping the agent's line.`
  }
  return `Warning: runtime requirement "${requirement}" is a direct reference and cannot be checked against a version floor. Keeping the agent's line.`
}

/**
 * Merge one agent `runtime.requirements` line.
 * A plain name keeps the floor. A lower bound below the floor is raised.
 * Extras, compatible upper bounds, and markers stay.
 * A direct URL or VCS reference is kept, with one warning.
 * A pin or upper bound that cannot meet the floor throws.
 * A marker line is added beside the unconditional floor.
 * `--hash` options are removed before the merge.
 */
function applyRuntimeRequirement(
  lines: string[],
  spec: string,
  warn: (message: string) => void,
  onHashes: () => void,
  castFloors: ReadonlyMap<string, string>,
): void {
  // Comments go first so `--hash` written in a comment is not a hash option.
  const withoutComment = stripInlineComment(spec.trim()).trim()
  if (!withoutComment) return
  const {line: withoutHashes, stripped} = stripHashOptions(withoutComment)
  if (stripped) onHashes()
  const trimmed = withoutHashes.trim()
  if (!trimmed) return
  if (trimmed.endsWith('\\')) malformedRequirement(trimmed)

  const parsed = parseRequirement(trimmed)
  if (!parsed.canonical || parsed.canonical === 'cast') return
  if (trimmed.toLowerCase().includes('castagent')) return
  if (parsed.opaque) malformedRequirement(trimmed)

  const index = lines.findIndex(line =>
    canonicalRequirementName(line) === parsed.canonical && parseRequirement(line).marker === null
  )
  const existing = index === -1 ? null : lines[index]
  const floor = existing ? requirementLowerBound(existing) : null
  const fromAgent = existing != null && existing !== castFloors.get(parsed.canonical)
  const reject = () => {
    floorConflict(parsed.name, trimmed, existing || floor || '', fromAgent)
  }
  const put = (line: string) => {
    if (index === -1) lines.push(line)
    else lines[index] = line
  }

  if (parsed.marker !== null) {
    let line = trimmed
    if (parsed.url) {
      warn(directReferenceWarning(trimmed, existing, true))
    } else if (floor && conflictsWithFloor(parsed, floor)) {
      reject()
    } else if (floor && allowsBelowFloor(parsed, floor)) {
      line = raiseLowerBound(trimmed, floor)
    }
    if (!lines.includes(line)) lines.push(line)
    return
  }

  if (parsed.url) {
    warn(directReferenceWarning(trimmed, existing, false))
    put(trimmed)
    return
  }

  if (parsed.specs.length === 0) {
    if (!existing) {
      lines.push(trimmed)
      return
    }
    if (parsed.extras) put(withExtras(existing, parsed.extras))
    return
  }

  if (floor && conflictsWithFloor(parsed, floor)) {
    reject()
  }

  if (floor && allowsBelowFloor(parsed, floor)) {
    if (isSimpleLowerBound(parsed) && !parsed.extras && !parsed.hashes && existing && isSimpleFloorLine(existing)) return
    put(raiseLowerBound(trimmed, floor))
    return
  }

  if (!existing) {
    lines.push(trimmed)
    return
  }
  if (isSimpleLowerBound(parsed) && !parsed.extras && !parsed.hashes && floor) {
    const userLower = requirementLowerBound(trimmed)
    if (userLower && compareVersions(userLower, floor) <= 0) return
  }
  put(trimmed)
}

export function filterRequirementLines(text: string): string[] {
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const lower = trimmed.toLowerCase()
    if (/^cast\b/.test(lower) || lower.includes('castagent')) continue
    if (!canonicalRequirementName(trimmed)) continue
    lines.push(trimmed)
  }
  return lines
}

export function upsertRequirement(lines: string[], spec: string): void {
  const trimmed = spec.trim()
  const name = canonicalRequirementName(trimmed)
  if (!name || name === 'cast') return
  if (trimmed.toLowerCase().includes('castagent')) return
  const index = lines.findIndex(line => canonicalRequirementName(line) === name)
  if (index === -1) {
    lines.push(trimmed)
    return
  }
  const incoming = requirementLowerBound(trimmed)
  if (!incoming) return
  const current = requirementLowerBound(lines[index])
  if (!current || compareVersions(current, incoming) < 0) {
    lines[index] = trimmed
  }
}

function extractTomlTable(source: string, name: string): string {
  const lines = source.split(/\r?\n/)
  const header = new RegExp(`^\\[${name}\\]\\s*(?:#.*)?$`)
  let inTable = false
  const collected: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (header.test(trimmed)) {
      inTable = true
      continue
    }
    if (inTable && /^\[[^\]]+\]/.test(trimmed)) break
    if (inTable) collected.push(line)
  }
  return collected.join('\n')
}

/** Dependencies declared on `[project]`, not optional extras. */
export function parsePyprojectDependencies(source: string): string[] {
  const project = extractTomlTable(source, 'project')
  const match = project.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)
  if (!match) return []
  const deps: string[] = []
  const quoted = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g
  let found: RegExpExecArray | null
  while ((found = quoted.exec(match[1])) !== null) {
    const value = (found[1] ?? found[2] ?? '').replace(/\\"/g, '"').replace(/\\'/g, "'").trim()
    if (value) deps.push(value)
  }
  return deps
}

export function parseRuntimeRequirements(agentYaml: string): string[] {
  if (!agentYaml.trim()) return []
  let parsed: unknown
  try {
    parsed = YAML.parse(agentYaml)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const runtime = (parsed as {runtime?: {requirements?: unknown}}).runtime
  if (!runtime || !Array.isArray(runtime.requirements)) return []
  return runtime.requirements
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

// One CLI process is one deploy, and deploy writes this file before the provider
// writes it again. The same warning text is printed once until the next deploy.
const warnedThisProcess = new Set<string>()

function warnOnce(message: string): void {
  if (warnedThisProcess.has(message)) return
  warnedThisProcess.add(message)
  console.warn(message)
}

/** Call at the start of deploy or upgrade so a later deploy can warn again. */
export function beginRequirementWarnings(): void {
  warnedThisProcess.clear()
}

export function renderRequirementsFile(input: {
  frozen: string
  pyprojectSource?: string
  agentYaml?: string
  warn?: (message: string) => void
}): string {
  const frozen = input.frozen.trim()
  const lines = filterRequirementLines(frozen ? input.frozen : FALLBACK_REQUIREMENTS)
  const pyprojectDeps = input.pyprojectSource ? parsePyprojectDependencies(input.pyprojectSource) : []
  for (const dep of pyprojectDeps) upsertRequirement(lines, dep)
  const emit = input.warn ?? warnOnce
  const warn = (message: string) => {
    emit(maskUrlUserinfo(message))
  }
  let announcedHashes = false
  const onHashes = () => {
    if (announcedHashes) return
    announcedHashes = true
    warn(HASH_WARNING)
  }
  const castFloors = new Map<string, string>()
  for (const line of lines) {
    const parsed = parseRequirement(line)
    if (!parsed.canonical || parsed.marker !== null) continue
    castFloors.set(parsed.canonical, line)
  }
  for (const dep of parseRuntimeRequirements(input.agentYaml || '')) {
    applyRuntimeRequirement(lines, dep, warn, onHashes, castFloors)
  }
  if (!lines.some(line => canonicalRequirementName(line) === 'gitpython' && parseRequirement(line).marker === null)) {
    lines.push(GITPYTHON_REQUIREMENT)
  }
  return `${lines.join('\n')}\n`
}

export function readFrozenRequirements(projectRoot: string): string {
  // The pip script's shebang records the path where the virtualenv was
  // created. A renamed checkout still runs via `python -m pip` because
  // the interpreter is a symlink, not that script.
  const pythonPath = path.join(projectRoot, 'python', '.venv', 'bin', 'python')
  if (!fs.existsSync(pythonPath)) return ''
  try {
    return execFileSync(pythonPath, ['-m', 'pip', 'freeze'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return ''
  }
}

const CAST_PACKAGE = path.join('python', 'cast')
const PYPROJECT_MARKER = path.join('python', 'pyproject.toml')

/**
 * Cast checkout that owns the runtime minimums.
 * cwd wins when it contains both python/cast and python/pyproject.toml.
 * A directory that only has python/pyproject.toml is not this checkout.
 */
export function findRequirementsProjectRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
    path.resolve(__dirname, '../../../../../..'),
  ]
  for (const candidate of candidates) {
    if (
      fs.existsSync(path.join(candidate, CAST_PACKAGE))
      && fs.existsSync(path.join(candidate, PYPROJECT_MARKER))
    ) return candidate
  }
  return process.cwd()
}

/**
 * Write requirements.txt for a deployed agent.
 * python/pyproject.toml is the source of truth for runtime minimums.
 * Docker, Fly, Sprites, Droplets, MicroVMs, and Railway install this file.
 * cast deploy calls this before provider.deploy, so a new provider does too.
 */
export function stagePythonRequirements(agentPath: string, projectRoot = findRequirementsProjectRoot()): string {
  return writeRequirementsTxt(projectRoot, agentPath)
}

/** Write the image requirements for a Docker deploy or upgrade. Returns the file text. */
export function writeRequirementsTxt(projectRoot: string, agentPath: string): string {
  const pyprojectPath = path.join(projectRoot, 'python', 'pyproject.toml')
  const agentYamlPath = path.join(agentPath, 'agent.yaml')
  const text = renderRequirementsFile({
    frozen: readFrozenRequirements(projectRoot),
    pyprojectSource: fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, 'utf8') : '',
    agentYaml: fs.existsSync(agentYamlPath) ? fs.readFileSync(agentYamlPath, 'utf8') : '',
  })
  fs.writeFileSync(path.join(agentPath, 'requirements.txt'), text)
  return text
}
