import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'

/** Skill names match the builder frontmatter rule shared with issue #67. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/
const GITHUB_HOST_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i
const SKILL_MARKDOWN_NAMES = ['SKILL.md', 'skill.md']

/** Collapse a folded or literal YAML description onto one line. */
function collapseSkillDescription(description: string): string {
  return description
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
}

/** Agent Skills uses `SKILL.md` or `skill.md`. Prefer `SKILL.md` when both exist. */
function skillMarkdownFile(dir: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return null
  }
  for (const name of SKILL_MARKDOWN_NAMES) {
    if (!names.includes(name)) continue
    const full = path.join(dir, name)
    try {
      if (fs.statSync(full).isFile()) return full
    } catch {
      continue
    }
  }
  return null
}
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/
const REF_RE = /^[A-Za-z0-9._/-]+$/

export class BuilderSkillError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BuilderSkillError'
  }
}

export interface GithubSkillSource {
  owner: string
  repo: string
  ref?: string
  subpath?: string
}

export interface ParsedSkill {
  name: string
  description: string
  body: string
}

export interface ListedSkill {
  name: string
  description: string
  path: string
}

export interface SkillCandidate {
  name: string
  description: string
  subpath: string
}

export type InstallResult =
  | {kind: 'installed'; skill: ListedSkill}
  | {kind: 'multiple'; candidates: SkillCandidate[]}

type TreeSelection =
  | {kind: 'one'; directory: string; doc: ParsedSkill}
  | {kind: 'multiple'; candidates: SkillCandidate[]}

export function castHome(): string {
  return process.env.HOME || os.homedir()
}

export function builderSkillsRoot(home = castHome()): string {
  return path.join(home, '.cast', 'builder', 'skills')
}

export function isValidSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name)
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

/**
 * Parse a GitHub skill source. Returns null when the string is not one of
 * the supported shapes, so callers can treat it as a folder or an error.
 *
 * Shapes: https://github.com/owner/repo, .../tree/<ref>/<subpath>,
 * owner/repo, owner/repo/<subpath>, owner/repo@ref.
 */
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

export function parseSkillMarkdown(text: string): ParsedSkill | null {
  const cleaned = text.replace(/^\uFEFF/, '')
  const match = cleaned.match(FRONTMATTER_RE)
  if (!match) return null
  let data: unknown
  try {
    data = yaml.parse(match[1])
  } catch {
    return null
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const record = data as Record<string, unknown>
  const name = record.name
  const description = record.description
  if (typeof name !== 'string' || !isValidSkillName(name)) return null
  if (typeof description !== 'string') return null
  const oneLine = collapseSkillDescription(description)
  if (!oneLine) return null
  return {name, description: oneLine, body: match[2]}
}

export function renderSkillMarkdown(name: string, description: string, body: string): string {
  const front = yaml.stringify({name, description}, {lineWidth: 0}).trimEnd()
  let text = body.replace(/\r\n/g, '\n')
  if (text.startsWith('\n')) text = text.slice(1)
  if (text.length > 0 && !text.endsWith('\n')) text += '\n'
  return `---\n${front}\n---\n${text}`
}

function readSkillFile(filePath: string): ParsedSkill | null {
  try {
    return parseSkillMarkdown(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

export function assertSourceOutsideSkills(source: string, skillsRoot: string): void {
  if (!fs.existsSync(skillsRoot)) return
  const sourceReal = fs.realpathSync(source)
  const rootReal = fs.realpathSync(skillsRoot)
  const rel = path.relative(rootReal, sourceReal)
  const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  if (inside) {
    throw new BuilderSkillError(
      `Refusing to install from ${sourceReal}: it is already inside ${rootReal}.`,
    )
  }
}

function copySkillDirectory(srcDir: string, destDir: string): void {
  fs.cpSync(srcDir, destDir, {
    recursive: true,
    dereference: true,
    filter: (source) => path.basename(source) !== '.git',
  })
}

function placeSkillDirectory(srcDir: string, doc: ParsedSkill, skillsRoot: string): ListedSkill {
  if (!isValidSkillName(doc.name)) {
    throw new BuilderSkillError(`Invalid skill name '${doc.name}'.`)
  }
  fs.mkdirSync(skillsRoot, {recursive: true})
  assertSourceOutsideSkills(srcDir, skillsRoot)
  const dest = path.join(skillsRoot, doc.name)
  if (fs.existsSync(dest)) {
    throw new BuilderSkillError(`Builder skill '${doc.name}' is already installed.`)
  }
  try {
    copySkillDirectory(srcDir, dest)
    if (!skillMarkdownFile(dest)) {
      throw new BuilderSkillError(`No SKILL.md in ${srcDir}`)
    }
  } catch (err) {
    fs.rmSync(dest, {recursive: true, force: true})
    throw err
  }
  return {name: doc.name, description: doc.description, path: dest}
}

export function installFromFields(
  opts: {name: string; description: string; body: string},
  home = castHome(),
): ListedSkill {
  const name = opts.name.trim()
  const description = typeof opts.description === 'string' ? collapseSkillDescription(opts.description) : ''
  if (!isValidSkillName(name)) {
    throw new BuilderSkillError(`Invalid skill name '${opts.name}'.`)
  }
  if (!description) {
    throw new BuilderSkillError('Skill description must be a single non-empty line.')
  }
  const skillsRoot = builderSkillsRoot(home)
  fs.mkdirSync(skillsRoot, {recursive: true})
  const dest = path.join(skillsRoot, name)
  if (fs.existsSync(dest)) {
    throw new BuilderSkillError(`Builder skill '${name}' is already installed.`)
  }
  const markdown = renderSkillMarkdown(name, description, opts.body)
  try {
    fs.mkdirSync(dest)
    fs.writeFileSync(path.join(dest, 'SKILL.md'), markdown, 'utf8')
  } catch (err) {
    fs.rmSync(dest, {recursive: true, force: true})
    throw err
  }
  return {name, description, path: dest}
}

export function installFromFolder(folder: string, home = castHome()): ListedSkill {
  const resolved = path.resolve(folder)
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new BuilderSkillError(`Folder not found: ${folder}`)
  }
  const skillFile = skillMarkdownFile(resolved)
  if (!skillFile) {
    throw new BuilderSkillError(`No SKILL.md in ${resolved}`)
  }
  const skillsRoot = builderSkillsRoot(home)
  assertSourceOutsideSkills(resolved, skillsRoot)
  const parsed = readSkillFile(skillFile)
  if (!parsed) {
    throw new BuilderSkillError(`Invalid skill frontmatter in ${skillFile}`)
  }
  return placeSkillDirectory(resolved, parsed, skillsRoot)
}

interface DiscoveredSkill extends SkillCandidate {
  directory: string
  doc: ParsedSkill
}

function resolveInside(root: string, subpath: string): string {
  if (!validSubpath(subpath)) {
    throw new BuilderSkillError(`Invalid skill subpath '${subpath}'.`)
  }
  const resolved = path.resolve(root, subpath)
  const rel = path.relative(root, resolved)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new BuilderSkillError(`Invalid skill subpath '${subpath}'.`)
  }
  return resolved
}

function toPosixRelative(root: string, dir: string): string {
  const rel = path.relative(root, dir)
  if (!rel || rel === '.') return ''
  return rel.split(path.sep).join('/')
}

function walkSkillFiles(dir: string, out: string[]): void {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, {withFileTypes: true})
  } catch {
    return
  }
  const skillName = entries.some((entry) => entry.isFile() && entry.name === 'SKILL.md')
    ? 'SKILL.md'
    : entries.some((entry) => entry.isFile() && entry.name === 'skill.md')
      ? 'skill.md'
      : null
  if (skillName) out.push(path.join(dir, skillName))
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) walkSkillFiles(full, out)
  }
}

function discoverSkills(root: string): {found: DiscoveredSkill[]; sawFile: boolean} {
  const files: string[] = []
  walkSkillFiles(root, files)
  const found: DiscoveredSkill[] = []
  for (const filePath of files) {
    const doc = readSkillFile(filePath)
    if (!doc) continue
    const directory = path.dirname(filePath)
    found.push({
      name: doc.name,
      description: doc.description,
      subpath: toPosixRelative(root, directory),
      directory,
      doc,
    })
  }
  found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.subpath < b.subpath ? -1 : 1))
  return {found, sawFile: files.length > 0}
}

function skillDirectoryFromTarget(root: string, target: string): string {
  if (!fs.existsSync(target)) {
    throw new BuilderSkillError(`No SKILL.md found at ${path.relative(root, target) || '.'}`)
  }
  const stat = fs.statSync(target)
  if (stat.isFile()) {
    const base = path.basename(target)
    if (base !== 'SKILL.md' && base !== 'skill.md') {
      throw new BuilderSkillError(`No SKILL.md found at ${path.relative(root, target) || '.'}`)
    }
    return path.dirname(target)
  }
  if (stat.isDirectory() && skillMarkdownFile(target)) return target
  throw new BuilderSkillError(`No SKILL.md found at ${path.relative(root, target) || '.'}`)
}

export function resolveSkillsInTree(
  root: string,
  opts: {subpath?: string; skill?: string} = {},
): TreeSelection {
  if (opts.subpath !== undefined && opts.subpath !== '') {
    const rel = opts.subpath === '.' ? '' : opts.subpath
    const target = rel === '' ? root : resolveInside(root, rel)
    const directory = skillDirectoryFromTarget(root, target)
    const skillFile = skillMarkdownFile(directory)
    if (!skillFile) {
      throw new BuilderSkillError(`No SKILL.md found at ${path.relative(root, directory) || '.'}`)
    }
    const doc = readSkillFile(skillFile)
    if (!doc) {
      throw new BuilderSkillError(`Invalid skill frontmatter in ${skillFile}`)
    }
    return {kind: 'one', directory, doc}
  }

  const {found, sawFile} = discoverSkills(root)
  if (opts.skill) {
    const matches = found.filter((skill) => skill.name === opts.skill)
    if (matches.length === 0) {
      throw new BuilderSkillError(`Skill '${opts.skill}' was not found in the repository.`)
    }
    if (matches.length > 1) {
      throw new BuilderSkillError(`Skill name '${opts.skill}' matches more than one directory.`)
    }
    const match = matches[0]
    return {kind: 'one', directory: match.directory, doc: match.doc}
  }
  if (found.length === 0) {
    throw new BuilderSkillError(
      sawFile ? 'No valid SKILL.md found in the repository.' : 'No SKILL.md found in the repository.',
    )
  }
  if (found.length === 1) {
    const match = found[0]
    return {kind: 'one', directory: match.directory, doc: match.doc}
  }
  return {
    kind: 'multiple',
    candidates: found.map((skill) => ({name: skill.name, description: skill.description, subpath: skill.subpath})),
  }
}

function defaultClone(source: GithubSkillSource, dest: string): void {
  const url = `https://github.com/${source.owner}/${source.repo}.git`
  const args = ['clone', '--depth', '1']
  if (source.ref) args.push('--branch', source.ref)
  args.push('--', url, dest)
  try {
    execFileSync('git', args, {stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000})
  } catch (err: any) {
    const stderr = String(err?.stderr ?? err?.message ?? err).trim()
    throw new BuilderSkillError(`Failed to clone ${url}${source.ref ? ` @ ${source.ref}` : ''}: ${stderr}`)
  }
}

export function installFromGithub(
  opts: {
    repo: string
    ref?: string
    subpath?: string
    skill?: string
    home?: string
    clone?: (source: GithubSkillSource, dest: string) => void
  },
): InstallResult {
  const parsed = parseGithubSkillSource(opts.repo)
  if (!parsed) {
    throw new BuilderSkillError(`Not a GitHub repository: ${opts.repo}`)
  }
  const source: GithubSkillSource = {owner: parsed.owner, repo: parsed.repo}
  const ref = opts.ref || parsed.ref
  const subpath = opts.subpath !== undefined && opts.subpath !== '' ? opts.subpath : parsed.subpath
  if (ref) source.ref = ref
  if (subpath) source.subpath = subpath
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-builder-skill-'))
  try {
    ;(opts.clone ?? defaultClone)(source, tmp)
    const selection = resolveSkillsInTree(tmp, {subpath: source.subpath, skill: opts.skill})
    if (selection.kind === 'multiple') return selection
    const installed = placeSkillDirectory(selection.directory, selection.doc, builderSkillsRoot(opts.home ?? castHome()))
    return {kind: 'installed', skill: installed}
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true})
  }
}

export function listBuilderSkills(home = castHome()): {skills: ListedSkill[]; warnings: string[]} {
  const root = builderSkillsRoot(home)
  if (!fs.existsSync(root)) return {skills: [], warnings: []}
  const warnings: string[] = []
  const skills: ListedSkill[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, {withFileTypes: true})
  } catch (err: any) {
    throw new BuilderSkillError(`Could not read builder skills: ${err?.message ?? err}`)
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = path.join(root, entry.name)
    const skillFile = skillMarkdownFile(dir)
    if (!skillFile) {
      warnings.push(`Skipping builder skill '${entry.name}': SKILL.md is missing`)
      continue
    }
    const parsed = readSkillFile(skillFile)
    if (!parsed) {
      warnings.push(`Skipping builder skill '${entry.name}': invalid frontmatter`)
      continue
    }
    skills.push({name: parsed.name, description: parsed.description, path: dir})
  }
  skills.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {skills, warnings}
}

export function removeBuilderSkill(name: string, home = castHome()): void {
  if (!isValidSkillName(name)) {
    throw new BuilderSkillError(`Builder skill '${name}' is not installed.`)
  }
  const dest = path.join(builderSkillsRoot(home), name)
  if (!fs.existsSync(dest)) {
    throw new BuilderSkillError(`Builder skill '${name}' is not installed.`)
  }
  const stat = fs.lstatSync(dest)
  if (stat.isSymbolicLink()) {
    fs.unlinkSync(dest)
    return
  }
  if (!stat.isDirectory()) {
    throw new BuilderSkillError(`Builder skill '${name}' is not installed.`)
  }
  fs.rmSync(dest, {recursive: true, force: true})
}
