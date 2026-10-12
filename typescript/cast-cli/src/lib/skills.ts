import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'

/** Shown when `/skills add` is given something that is neither a repo nor a folder. */
export const GITHUB_SOURCE_HINT =
  'Give a GitHub repo (owner/name or https://github.com/owner/name) or a folder path. Run /skills to enter a skill in the modal.'

const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export class SkillError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(message: string, code = 'error', details?: unknown) {
    super(message)
    this.name = 'SkillError'
    this.code = code
    this.details = details
  }
}

export interface SkillSource {
  type: 'github' | 'folder' | 'modal'
  repo?: string
  ref?: string
  subpath?: string
  from?: string
}

export interface SkillEntry {
  name: string
  description: string
  path: string
  source: SkillSource
}

export interface GitHubSource {
  repo: string
  ref?: string
  subpath?: string
}

export interface SkillChoice {
  name: string
  description: string
  /** '.' means the repository root. */
  subpath: string
  ref?: string
}

export type CloneFn = (repoUrl: string, dest: string, ref?: string) => void

export interface SkillDocument {
  name: string
  description: string
  body: string
}

export function agentsRoot(): string {
  const override = process.env.CAST_AGENTS_DIR
  if (override && override.trim()) return override
  return path.join(os.homedir(), '.cast', 'agents')
}

export function duplicateSkillMessage(name: string, agentName: string): string {
  return `Skill '${name}' is already on '${agentName}'. Remove it with /skills first.`
}

export function missingInstalledSkillMessage(name: string, agentName: string): string {
  return `Skill '${name}' is not on '${agentName}'.`
}

export function addedMessage(agentName: string, entry: SkillEntry): string {
  return `Added skill '${entry.name}' to '${agentName}' (${sourcePhrase(entry)}).`
}

export function removedMessage(name: string, agentName: string): string {
  return `Removed skill '${name}' from '${agentName}'.`
}

export function formatSkillsText(agentName: string, skills: SkillEntry[]): string {
  if (skills.length === 0) return `No skills on '${agentName}'.`
  return skills.map((skill) => `${skill.name}  ${skill.description}  ${skill.source.type}`).join('\n')
}

function sourcePhrase(entry: SkillEntry): string {
  if (entry.source.type === 'github') return `github: ${entry.source.repo ?? ''}`
  if (entry.source.type === 'folder') return `folder: ${entry.source.from ?? ''}`
  return 'entered in the modal'
}

export function readSkillBody(body: string, readStdin: () => string): string {
  if (body === '-') return readStdin()
  return body
}

/**
 * Absolute path, or a path starting with `~`.
 * Relative paths are rejected so `..` cannot be interpreted against an unexpected cwd.
 */
export function resolveFolderInput(input: string): string {
  const trimmed = input.trim()
  if (!trimmed) throw new SkillError('Folder path is required.')
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  if (trimmed.startsWith('~')) {
    throw new SkillError('Give an absolute path or a path starting with ~.')
  }
  if (!path.isAbsolute(trimmed)) {
    throw new SkillError('Give an absolute path or a path starting with ~.')
  }
  return trimmed
}

export function parseGitHubSource(input: string): GitHubSource | null {
  let raw = input.trim()
  if (!raw) return null
  raw = raw.replace(/[?#].*$/, '')
  raw = raw.replace(/\/+$/, '')
  if (!raw) return null

  const url = raw.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/(.+)$/i)
  if (url) return parseGitHubTail(url[1], true)
  if (raw.startsWith('/') || raw.startsWith('~') || raw.startsWith('.') || raw.includes('://')) return null
  return parseGitHubTail(raw, false)
}

function parseGitHubTail(rest: string, fromUrl: boolean): GitHubSource | null {
  const parts = rest.split('/').filter(Boolean)
  if (parts.length < 2) return null

  let ref: string | undefined
  if (!fromUrl && parts.length === 2 && parts[1].includes('@')) {
    const at = parts[1].indexOf('@')
    const repoName = parts[1].slice(0, at)
    const refName = parts[1].slice(at + 1)
    if (!repoName || !refName || refName.includes('@')) return null
    parts[1] = repoName
    ref = refName
  }

  let repo = parts[1]
  if (repo.endsWith('.git')) repo = repo.slice(0, -4)
  const owner = parts[0]
  if (!isGitHubSegment(owner) || !isGitHubSegment(repo)) return null

  const after = parts.slice(2).join('/')
  const base: GitHubSource = {repo: `${owner}/${repo}`}
  if (ref) base.ref = ref

  if (!after) return base

  if (fromUrl) {
    const tree = after.match(/^tree\/([^/]+)(?:\/(.*))?$/)
    if (!tree) return null
    const treeRef = tree[1]
    const subpath = (tree[2] || '').replace(/\/+$/, '')
    if (!treeRef) return null
    return {
      repo: base.repo,
      ref: treeRef,
      ...(subpath ? {subpath} : {}),
    }
  }

  return {...base, subpath: after}
}

function isGitHubSegment(value: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
}

/** YAML `>` and `|` scalars keep newlines. Store the description as one line. */
function collapseSkillDescription(description: string): string {
  return description
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(' ')
}

export function assertSkillIdentity(name: string, description: string, body: string): SkillDocument {
  const skillName = name.trim()
  if (!SKILL_NAME.test(skillName)) {
    throw new SkillError(`Skill name '${skillName}' is invalid. Names must match [a-z0-9][a-z0-9-]*.`)
  }
  const skillDescription = collapseSkillDescription(description)
  if (!skillDescription) throw new SkillError('Skill description is required.')
  const skillBody = body.replace(/^\n+/, '').replace(/\s+$/, '')
  if (!skillBody.trim()) throw new SkillError('Skill body is required.')
  return {name: skillName, description: skillDescription, body: skillBody}
}

export function renderSkillMarkdown(name: string, description: string, body: string): string {
  const skill = assertSkillIdentity(name, description, body)
  const frontmatter = yaml.stringify(
    {name: skill.name, description: skill.description},
    {lineWidth: 0},
  ).trimEnd()
  return `---\n${frontmatter}\n---\n\n${skill.body}\n`
}

export function parseSkillMarkdown(content: string): SkillDocument {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new SkillError('SKILL.md is missing YAML frontmatter.')
  let data: unknown
  try {
    data = yaml.parse(match[1])
  } catch {
    throw new SkillError('SKILL.md frontmatter is not valid YAML.')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new SkillError('SKILL.md frontmatter must be a mapping.')
  }
  const record = data as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name : ''
  const description = typeof record.description === 'string' ? record.description : ''
  if (!name.trim()) throw new SkillError('SKILL.md is missing a name.')
  return assertSkillIdentity(name, description, match[2] ?? '')
}

export function listSkills(agentName: string, agentsDir?: string): SkillEntry[] {
  const agent = requireAgent(agentName, agentsDir)
  return normalizeSkills(readAgentConfig(agent).skills)
}

export function installFromFolder(options: {
  agentName: string
  folder: string
  agentsDir?: string
}): SkillEntry {
  const agent = requireAgent(options.agentName, options.agentsDir)
  const expanded = resolveFolderInput(options.folder)
  if (!fs.existsSync(expanded)) throw new SkillError(`No such directory: ${expanded}.`)
  let real: string
  try {
    real = fs.realpathSync(expanded)
  } catch {
    throw new SkillError(`No such directory: ${expanded}.`)
  }
  if (!fs.statSync(real).isDirectory()) throw new SkillError(`Not a directory: ${real}.`)
  if (isInsidePath(path.join(agent, 'skills'), real)) {
    throw new SkillError(`That path is inside '${options.agentName}' skills/ and cannot be installed onto itself.`)
  }
  const parsed = readSkillFile(path.join(real, 'SKILL.md'), real)
  return commitSkill(agent, options.agentName, {
    name: parsed.name,
    description: parsed.description,
    source: {type: 'folder', from: real},
    writeTo: (dir) => copySkillTree(real, dir),
  })
}

export function installFromModal(options: {
  agentName: string
  name: string
  description: string
  body: string
  agentsDir?: string
}): SkillEntry {
  const agent = requireAgent(options.agentName, options.agentsDir)
  const markdown = renderSkillMarkdown(options.name, options.description, options.body)
  const parsed = parseSkillMarkdown(markdown)
  return commitSkill(agent, options.agentName, {
    name: parsed.name,
    description: parsed.description,
    source: {type: 'modal'},
    writeTo: (dir) => {
      fs.writeFileSync(path.join(dir, 'SKILL.md'), markdown, 'utf8')
    },
  })
}

export function defaultClone(repoUrl: string, dest: string, ref?: string): void {
  const args = ['clone', '--depth', '1']
  if (ref) args.push('--branch', ref, '--single-branch')
  args.push(repoUrl, dest)
  try {
    execFileSync('git', args, {stdio: ['ignore', 'pipe', 'pipe']})
  } catch (err: any) {
    const stderr = err?.stderr?.toString?.() ?? ''
    const detail = stderr.trim().split('\n').filter(Boolean).pop() || 'git clone failed'
    throw new SkillError(`Failed to clone ${repoUrl}${ref ? ` at ${ref}` : ''}: ${detail}`)
  }
}

export function installFromGitHub(options: {
  agentName: string
  repo: string
  ref?: string
  subpath?: string
  sourceLabel: string
  agentsDir?: string
  clone?: CloneFn
}): SkillEntry {
  if (!GITHUB_REPO.test(options.repo)) throw new SkillError(GITHUB_SOURCE_HINT)
  const agent = requireAgent(options.agentName, options.agentsDir)
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-'))
  const cloneDest = path.join(parent, 'repo')
  try {
    const clone = options.clone ?? defaultClone
    clone(`https://github.com/${options.repo}.git`, cloneDest, options.ref)
    if (!fs.existsSync(cloneDest)) {
      throw new SkillError(`Failed to clone https://github.com/${options.repo}.git.`)
    }
    const located = locateSkill(cloneDest, options.subpath, options.sourceLabel, options.ref)
    const recordedSubpath = located.subpath === '.' ? undefined : located.subpath
    return commitSkill(agent, options.agentName, {
      name: located.name,
      description: located.description,
      source: githubSource(options.repo, options.ref, recordedSubpath),
      writeTo: (dir) => copySkillTree(located.dir, dir),
    })
  } finally {
    fs.rmSync(parent, {recursive: true, force: true})
  }
}

export function removeSkill(agentName: string, skillName: string, agentsDir?: string): void {
  const agent = requireAgent(agentName, agentsDir)
  const config = readAgentConfig(agent)
  const skills = normalizeSkills(config.skills)
  const entry = skills.find((skill) => skill.name === skillName)
  if (!entry) throw new SkillError(missingInstalledSkillMessage(skillName, agentName))

  const next = skills.filter((skill) => skill.name !== skillName)
  const target = resolveInstalledSkillDir(agent, entry)
  const yamlPath = path.join(agent, 'agent.yaml')
  const previous = fs.readFileSync(yamlPath, 'utf8')
  config.skills = next
  fs.writeFileSync(yamlPath, yaml.stringify(config, {lineWidth: 0}), 'utf8')
  try {
    if (fs.existsSync(target)) fs.rmSync(target, {recursive: true, force: true})
  } catch (err) {
    fs.writeFileSync(yamlPath, previous, 'utf8')
    throw err instanceof SkillError ? err : new SkillError(err instanceof Error ? err.message : String(err))
  }
}

interface LocatedSkill {
  name: string
  description: string
  subpath: string
  dir: string
}

function locateSkill(root: string, subpath: string | undefined, sourceLabel: string, ref?: string): LocatedSkill {
  if (subpath) {
    const dir = resolveSubpath(root, subpath)
    const parsed = readSkillFile(path.join(dir, 'SKILL.md'), sourceLabelFor(sourceLabel, subpath))
    return {name: parsed.name, description: parsed.description, subpath, dir}
  }

  const found = discoverSkills(root)
  if (found.length === 0) throw new SkillError(`No SKILL.md in ${sourceLabel}.`)
  if (found.length === 1) return found[0]
  const choices: SkillChoice[] = found.map((skill) => ({
    name: skill.name,
    description: skill.description,
    subpath: skill.subpath,
    ...(ref ? {ref} : {}),
  }))
  throw new SkillError(
    `Multiple SKILL.md files found in ${sourceLabel}. Re-run with --subpath.`,
    'multiple',
    choices,
  )
}

function sourceLabelFor(sourceLabel: string, subpath: string): string {
  if (subpath === '.' || sourceLabel.includes(subpath)) return sourceLabel
  return `${sourceLabel}/${subpath}`
}

function resolveSubpath(root: string, subpath: string): string {
  if (subpath === '.') return fs.realpathSync(root)
  if (path.isAbsolute(subpath) || subpath.split('/').includes('..') || subpath.split('/').includes('.')) {
    throw new SkillError('Invalid subpath.')
  }
  const rootReal = fs.realpathSync(root)
  const dir = path.resolve(rootReal, subpath)
  if (!isInsidePath(rootReal, dir)) throw new SkillError('Invalid subpath.')
  return dir
}

function discoverSkills(root: string): LocatedSkill[] {
  const rootReal = fs.realpathSync(root)
  const found: LocatedSkill[] = []
  const problems: string[] = []

  const walk = (dir: string): void => {
    const skillMd = path.join(dir, 'SKILL.md')
    if (fs.existsSync(skillMd) && fs.statSync(skillMd).isFile()) {
      try {
        const parsed = parseSkillMarkdown(fs.readFileSync(skillMd, 'utf8'))
        const rel = path.relative(rootReal, dir)
        const subpath = rel ? rel.split(path.sep).join('/') : '.'
        found.push({name: parsed.name, description: parsed.description, subpath, dir})
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err))
      }
    }
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue
      walk(path.join(dir, entry.name))
    }
  }

  walk(rootReal)
  if (found.length === 0 && problems.length > 0) throw new SkillError(problems[0])
  found.sort((a, b) => a.name.localeCompare(b.name) || a.subpath.localeCompare(b.subpath))
  return found
}

function readSkillFile(skillMd: string, sourceLabel: string): SkillDocument {
  if (!fs.existsSync(skillMd) || !fs.statSync(skillMd).isFile()) {
    throw new SkillError(`No SKILL.md in ${sourceLabel}.`)
  }
  try {
    return parseSkillMarkdown(fs.readFileSync(skillMd, 'utf8'))
  } catch (err) {
    if (err instanceof SkillError && err.message.startsWith('No SKILL.md')) throw err
    const detail = err instanceof Error ? err.message : String(err)
    throw new SkillError(`${detail.replace(/\.$/, '')} (${sourceLabel}).`)
  }
}

function githubSource(repo: string, ref?: string, subpath?: string): SkillSource {
  const source: SkillSource = {type: 'github', repo}
  if (ref) source.ref = ref
  if (subpath) source.subpath = subpath
  return source
}

function requireAgent(agentName: string, agentsDir?: string): string {
  if (!agentName || agentName.includes('/') || agentName.includes('\\') || agentName.includes('..')) {
    throw new SkillError(`Agent '${agentName}' not found.`)
  }
  const dir = path.join(agentsDir ?? agentsRoot(), agentName)
  if (!fs.existsSync(path.join(dir, 'agent.yaml'))) {
    throw new SkillError(`Agent '${agentName}' not found.`)
  }
  return dir
}

function readAgentConfig(agentDir: string): Record<string, any> {
  const raw = fs.readFileSync(path.join(agentDir, 'agent.yaml'), 'utf8')
  let parsed: unknown
  try {
    parsed = yaml.parse(raw)
  } catch {
    throw new SkillError(`agent.yaml for '${path.basename(agentDir)}' is not valid YAML.`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SkillError(`agent.yaml for '${path.basename(agentDir)}' is not a mapping.`)
  }
  return parsed as Record<string, any>
}

function normalizeSkills(raw: unknown): SkillEntry[] {
  if (!Array.isArray(raw)) return []
  const skills: SkillEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const record = item as Record<string, any>
    if (typeof record.name !== 'string' || !record.name) continue
    const sourceRaw = record.source && typeof record.source === 'object' ? record.source : {}
    const type = sourceRaw.type === 'github' || sourceRaw.type === 'modal' || sourceRaw.type === 'folder'
      ? sourceRaw.type
      : 'folder'
    const source: SkillSource = {type}
    if (typeof sourceRaw.repo === 'string' && sourceRaw.repo) source.repo = sourceRaw.repo
    if (typeof sourceRaw.ref === 'string' && sourceRaw.ref) source.ref = sourceRaw.ref
    if (typeof sourceRaw.subpath === 'string' && sourceRaw.subpath) source.subpath = sourceRaw.subpath
    if (typeof sourceRaw.from === 'string' && sourceRaw.from) source.from = sourceRaw.from
    skills.push({
      name: record.name,
      description: typeof record.description === 'string' ? record.description : '',
      path: typeof record.path === 'string' && record.path ? record.path : `skills/${record.name}`,
      source,
    })
  }
  return skills
}

function commitSkill(
  agentDir: string,
  agentName: string,
  prepared: {name: string; description: string; source: SkillSource; writeTo: (dir: string) => void},
): SkillEntry {
  if (!SKILL_NAME.test(prepared.name)) {
    throw new SkillError(`Skill name '${prepared.name}' is invalid. Names must match [a-z0-9][a-z0-9-]*.`)
  }
  const config = readAgentConfig(agentDir)
  const existing = normalizeSkills(config.skills)
  const skillsRoot = path.join(agentDir, 'skills')
  const dest = path.resolve(skillsRoot, prepared.name)
  const rel = path.relative(path.resolve(skillsRoot), dest)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new SkillError(`Skill name '${prepared.name}' is invalid. Names must match [a-z0-9][a-z0-9-]*.`)
  }
  if (existing.some((skill) => skill.name === prepared.name) || fs.existsSync(dest)) {
    throw new SkillError(duplicateSkillMessage(prepared.name, agentName))
  }

  const skillsExisted = fs.existsSync(skillsRoot)
  const staging = path.join(skillsRoot, `.${prepared.name}.installing`)
  const yamlPath = path.join(agentDir, 'agent.yaml')
  const previousYaml = fs.readFileSync(yamlPath, 'utf8')
  let renamed = false
  let yamlWritten = false
  fs.mkdirSync(skillsRoot, {recursive: true})
  fs.rmSync(staging, {recursive: true, force: true})
  try {
    fs.mkdirSync(staging, {recursive: true})
    prepared.writeTo(staging)
    if (!fs.existsSync(path.join(staging, 'SKILL.md'))) {
      throw new SkillError(`No SKILL.md in ${prepared.name}.`)
    }
    if (fs.existsSync(dest)) throw new SkillError(duplicateSkillMessage(prepared.name, agentName))
    fs.renameSync(staging, dest)
    renamed = true
    const entry: SkillEntry = {
      name: prepared.name,
      description: prepared.description,
      path: `skills/${prepared.name}`,
      source: prepared.source,
    }
    config.skills = [...existing, entry]
    fs.writeFileSync(yamlPath, yaml.stringify(config, {lineWidth: 0}), 'utf8')
    yamlWritten = true
    return entry
  } catch (err) {
    if (yamlWritten) fs.writeFileSync(yamlPath, previousYaml, 'utf8')
    if (renamed && fs.existsSync(dest)) fs.rmSync(dest, {recursive: true, force: true})
    fs.rmSync(staging, {recursive: true, force: true})
    if (!skillsExisted && fs.existsSync(skillsRoot) && fs.readdirSync(skillsRoot).length === 0) {
      fs.rmdirSync(skillsRoot)
    }
    throw err instanceof SkillError ? err : new SkillError(err instanceof Error ? err.message : String(err))
  }
}

function resolveInstalledSkillDir(agentDir: string, entry: SkillEntry): string {
  const skillsRoot = path.resolve(agentDir, 'skills')
  const resolved = path.resolve(agentDir, entry.path)
  if (!isInsidePath(skillsRoot, resolved)) {
    throw new SkillError(`Refusing to delete '${entry.path}' because it is outside skills/.`)
  }
  return resolved
}

function isInsidePath(parent: string, candidate: string): boolean {
  const parentReal = fs.existsSync(parent) ? fs.realpathSync(parent) : path.resolve(parent)
  const candidateReal = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate)
  const rel = path.relative(parentReal, candidateReal)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Copy a skill directory. `.git` is skipped. Symlinks that leave the skill are skipped. */
function copySkillTree(src: string, dest: string): void {
  const root = fs.realpathSync(src)
  fs.mkdirSync(dest, {recursive: true})
  copyChildren(root, dest, root)
}

function copyChildren(current: string, dest: string, root: string): void {
  for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
    if (entry.name === '.git') continue
    const from = path.join(current, entry.name)
    const to = path.join(dest, entry.name)
    if (entry.isSymbolicLink()) {
      let real: string
      try {
        real = fs.realpathSync(from)
      } catch {
        continue
      }
      if (!isInsidePath(root, real)) continue
      const stat = fs.statSync(real)
      if (stat.isDirectory()) {
        fs.mkdirSync(to, {recursive: true})
        copyChildren(real, to, root)
      } else if (stat.isFile()) {
        fs.copyFileSync(real, to)
      }
      continue
    }
    if (entry.isDirectory()) {
      fs.mkdirSync(to, {recursive: true})
      copyChildren(from, to, root)
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
}
