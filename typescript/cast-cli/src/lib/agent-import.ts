import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit from 'simple-git'
import * as yaml from 'yaml'

/** Same rule as cast edit / cast rename. */
export const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

/** Passed to `git clone` so a GitHub import matches historical `cast clone`. */
export const GIT_CLONE_ARGS = ['--single-branch']

const HTTPS_GIT = /^https?:\/\/.+\/.+\/.+\.git$/
const HTTPS_REPO = /^https?:\/\/.+\/.+\/[^\/]+$/
const SSH_GIT = /^git@.+:.+\/.+\.git$/
const SSH_REPO = /^git@.+:.+\/.+$/
const SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/

export type AgentImportCode =
  | 'invalid-source'
  | 'invalid-name'
  | 'missing-path'
  | 'missing-agent-yaml'
  | 'name-collision'
  | 'auth'
  | 'other'

export class AgentImportError extends Error {
  readonly code: AgentImportCode
  readonly agentName?: string
  readonly sourceKind?: 'git' | 'local'
  readonly path?: string

  constructor(
    message: string,
    code: AgentImportCode,
    details: {agentName?: string; sourceKind?: 'git' | 'local'; path?: string} = {},
  ) {
    super(message)
    this.name = 'AgentImportError'
    this.code = code
    this.agentName = details.agentName
    this.sourceKind = details.sourceKind
    this.path = details.path
  }
}

export interface ResolvedAgentSource {
  kind: 'git' | 'local'
  /** Git URL passed to clone, or absolute local directory. */
  location: string
  /** Trimmed source string the user provided. */
  source: string
  defaultName: string
}

export interface PlannedImport extends ResolvedAgentSource {
  name: string
  agentsDir: string
  agentPath: string
}

export interface ImportAgentOptions {
  name?: string
  force?: boolean
  /** Override `~/.cast/agents` (or `CAST_AGENTS_DIR`). */
  agentsDir?: string
  /**
   * Test seam for git clones. Defaults to `git clone --single-branch`.
   * Local copies never call this.
   */
  cloneRepo?: (url: string, dest: string) => Promise<void>
}

export interface ImportAgentResult {
  name: string
  path: string
  source: string
  resolvedSource: string
  kind: 'git' | 'local'
  /** Up to 5 recent commits, matching `cast clone` output. 0 for filesystem copies. */
  commitCount: number
}

export function castAgentsDir(): string {
  const override = process.env.CAST_AGENTS_DIR
  if (override && override.trim()) return override
  return path.join(os.homedir(), '.cast', 'agents')
}

export function isGitUrl(source: string): boolean {
  return HTTPS_GIT.test(source) || HTTPS_REPO.test(source) || SSH_GIT.test(source) || SSH_REPO.test(source)
}

/** `user/repo` or `user/repo.git` → `https://github.com/user/repo.git`. */
export function resolveGitHubShorthand(source: string): {url: string; repo: string} | null {
  let raw = source.trim()
  if (!raw || raw.startsWith('.') || raw.startsWith('/') || raw.includes('://') || raw.startsWith('git@')) {
    return null
  }
  if (raw.endsWith('.git')) raw = raw.slice(0, -4)
  const match = raw.match(SHORTHAND)
  if (!match) return null
  const owner = match[1]
  const repo = match[2]
  if (!owner || !repo || owner === '.' || owner === '..' || repo === '.' || repo === '..') return null
  return {url: `https://github.com/${owner}/${repo}.git`, repo}
}

export function resolveAgentSource(input: string): ResolvedAgentSource {
  const source = input.trim()
  if (!source) {
    throw new AgentImportError('Agent source is required.', 'invalid-source')
  }

  if (isLocalSource(source)) {
    const location = path.resolve(source)
    return {
      kind: 'local',
      location,
      source,
      defaultName: path.basename(location),
    }
  }

  if (isGitUrl(source)) {
    return {
      kind: 'git',
      location: source,
      source,
      defaultName: repoNameFromUrl(source),
    }
  }

  const shorthand = resolveGitHubShorthand(source)
  if (shorthand) {
    return {
      kind: 'git',
      location: shorthand.url,
      source,
      defaultName: shorthand.repo,
    }
  }

  throw new AgentImportError(
    `Invalid agent source: ${source}\n` +
    'Expected a GitHub URL, git@ URL, user/repo, or a local path (./relative or /absolute).',
    'invalid-source',
  )
}

export function planAgentImport(
  source: string,
  options: {name?: string; agentsDir?: string} = {},
): PlannedImport {
  const resolved = resolveAgentSource(source)
  const requested = options.name?.trim()
  const name = requested || resolved.defaultName
  if (!AGENT_NAME_PATTERN.test(name)) {
    throw new AgentImportError(
      `Invalid agent name '${name}'. Names must start with a letter or number and contain only letters, numbers, and hyphens.`,
      'invalid-name',
      {agentName: name, sourceKind: resolved.kind},
    )
  }
  const agentsDir = options.agentsDir?.trim() || castAgentsDir()
  return {
    ...resolved,
    name,
    agentsDir,
    agentPath: path.join(agentsDir, name),
  }
}

export async function cloneGitRepo(url: string, dest: string): Promise<void> {
  const git = simpleGit()
  await git.clone(url, dest, GIT_CLONE_ARGS)
}

export function assertImportTargetAvailable(plan: PlannedImport, force = false): void {
  if (!fs.existsSync(plan.agentPath) || force) return
  throw new AgentImportError(collisionMessage(plan), 'name-collision', {
    agentName: plan.name,
    sourceKind: plan.kind,
    path: plan.agentPath,
  })
}

export async function importAgent(source: string, options: ImportAgentOptions = {}): Promise<ImportAgentResult> {
  const plan = planAgentImport(source, options)
  assertImportTargetAvailable(plan, Boolean(options.force))

  if (plan.kind === 'local') {
    assertLocalDirectory(plan)
  }

  const replacing = fs.existsSync(plan.agentPath)
  const staging = path.join(plan.agentsDir, `.${plan.name}.importing`)
  const backup = path.join(plan.agentsDir, `.${plan.name}.replacing`)
  const dest = replacing ? staging : plan.agentPath
  const cloneRepo = options.cloneRepo ?? cloneGitRepo
  let createdDest: string | null = null

  try {
    fs.mkdirSync(plan.agentsDir, {recursive: true})
    if (dest !== plan.agentPath) {
      fs.rmSync(dest, {recursive: true, force: true})
    }
    createdDest = dest
    if (plan.kind === 'local') {
      fs.cpSync(plan.location, dest, {recursive: true})
    } else {
      fs.mkdirSync(dest, {recursive: true})
      await cloneRepo(plan.location, dest)
    }

    if (!fs.existsSync(path.join(dest, 'agent.yaml'))) {
      throw new AgentImportError(missingYamlMessage(plan.kind), 'missing-agent-yaml', {
        agentName: plan.name,
        sourceKind: plan.kind,
      })
    }

    // A caller-supplied name is the agent's identity, not only its directory.
    // The runtime and A2A card read `name` from agent.yaml.
    if (options.name?.trim()) {
      writeImportedAgentName(dest, plan.name, plan.kind)
    }

    // git clone already created .git and origin. Filesystem copies init only when absent.
    await ensureLocalRepo(dest, plan.kind === 'git' ? plan.location : undefined)
    if (plan.kind === 'git') {
      writeRepositoryMetadata(dest, plan.location)
    }

    if (dest !== plan.agentPath) {
      commitStagedImport(dest, plan.agentPath, backup)
      createdDest = null
    }

    const commitCount = plan.kind === 'git' ? await recentCommitCount(plan.agentPath) : 0
    return {
      name: plan.name,
      path: plan.agentPath,
      source: plan.source,
      resolvedSource: plan.location,
      kind: plan.kind,
      commitCount,
    }
  } catch (error) {
    if (createdDest && createdDest !== plan.agentPath && fs.existsSync(createdDest)) {
      fs.rmSync(createdDest, {recursive: true, force: true})
    } else if (createdDest === plan.agentPath && fs.existsSync(plan.agentPath)) {
      fs.rmSync(plan.agentPath, {recursive: true, force: true})
    }
    throw normalizeImportError(error, plan.kind, plan.name)
  }
}

export function formatCloneError(error: unknown, opts: {agentPath: string; source: string}): string {
  if (error instanceof AgentImportError) {
    if (error.code === 'invalid-source') return invalidGitUrlMessage(opts.source)
    if (error.code === 'auth') return authCloneMessage()
    if (error.code === 'other' && error.sourceKind !== 'local') {
      return `Failed to clone: ${error.message}`
    }
    return error.message
  }

  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('Authentication failed') || message.includes('Permission denied')) {
    return authCloneMessage()
  }
  return `Failed to clone: ${message}`
}

export function invalidGitUrlMessage(url: string): string {
  return (
    `Invalid Git URL: ${url}\n` +
    `Expected formats:\n` +
    `  - https://github.com/user/repo.git\n` +
    `  - git@github.com:user/repo.git`
  )
}

export function authCloneMessage(): string {
  return (
    `Authentication failed.\n` +
    `Please ensure you have access to the repository and correct credentials.\n` +
    `You may need to:\n` +
    `  - Configure SSH keys for the Git host\n` +
    `  - Use a GitHub token for HTTPS URLs`
  )
}

function isLocalSource(source: string): boolean {
  return source === '.' ||
    source === '..' ||
    source.startsWith('./') ||
    source.startsWith('../') ||
    source.startsWith('/')
}

function repoNameFromUrl(url: string): string {
  const match = url.match(/\/([^\/]+?)(?:\.git)?$/)
  const name = match ? match[1] : 'agent'
  return name.replace(/\.git$/, '')
}

function collisionMessage(plan: PlannedImport): string {
  if (plan.kind === 'local') {
    return `Agent '${plan.name}' already exists. Use --force to overwrite or pick a different name.`
  }
  return (
    `Agent '${plan.name}' already exists at ${plan.agentPath}.\n` +
    `Remove it first with: cast delete ${plan.name}\n` +
    `Or use a different name as the second argument.`
  )
}

function missingYamlMessage(kind: 'git' | 'local'): string {
  if (kind === 'local') {
    return 'Directory does not contain a Cast agent (missing agent.yaml).'
  }
  return (
    `Cloned repository does not contain a valid Cast agent.\n` +
    `Expected to find 'agent.yaml' in the root directory.`
  )
}

function assertLocalDirectory(plan: PlannedImport): void {
  if (!fs.existsSync(plan.location)) {
    throw new AgentImportError(`Path '${plan.source}' does not exist.`, 'missing-path', {
      sourceKind: 'local',
      path: plan.source,
      agentName: plan.name,
    })
  }
  const stat = fs.statSync(plan.location)
  if (!stat.isDirectory()) {
    throw new AgentImportError(`Path '${plan.source}' is not a directory.`, 'other', {
      sourceKind: 'local',
      path: plan.source,
      agentName: plan.name,
    })
  }
  if (isInside(plan.location, plan.agentPath)) {
    throw new AgentImportError(
      `Cannot import '${plan.source}' into a directory inside itself.`,
      'other',
      {sourceKind: 'local', agentName: plan.name},
    )
  }
  if (!fs.existsSync(path.join(plan.location, 'agent.yaml'))) {
    throw new AgentImportError(missingYamlMessage('local'), 'missing-agent-yaml', {
      agentName: plan.name,
      sourceKind: 'local',
    })
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

async function ensureLocalRepo(agentPath: string, remoteUrl?: string): Promise<void> {
  if (fs.existsSync(path.join(agentPath, '.git'))) return
  const git = simpleGit(agentPath)
  await git.init()
  if (remoteUrl) {
    await git.addRemote('origin', remoteUrl)
  }
}

function writeImportedAgentName(agentPath: string, name: string, sourceKind: 'git' | 'local'): void {
  const configPath = path.join(agentPath, 'agent.yaml')
  const content = fs.readFileSync(configPath, 'utf-8')
  const doc = yaml.parseDocument(content)
  if (doc.errors.length > 0) {
    throw new AgentImportError(
      `Failed to read agent.yaml: ${doc.errors[0].message}`,
      'other',
      {agentName: name, sourceKind},
    )
  }
  if (!yaml.isMap(doc.contents)) {
    throw new AgentImportError(
      'agent.yaml must be a mapping so the cloned agent name can be set.',
      'other',
      {agentName: name, sourceKind},
    )
  }
  if (doc.get('name') === name) return
  doc.set('name', name)
  fs.writeFileSync(configPath, doc.toString())
}

function writeRepositoryMetadata(agentPath: string, url: string): void {
  const configPath = path.join(agentPath, 'agent.yaml')
  if (!fs.existsSync(configPath)) return
  const content = fs.readFileSync(configPath, 'utf-8')
  const config = yaml.parse(content) || {}
  config.repository = {
    remote: 'origin',
    url,
    branch: 'main',
  }
  fs.writeFileSync(configPath, yaml.stringify(config))
}

async function recentCommitCount(agentPath: string): Promise<number> {
  try {
    const log = await simpleGit(agentPath).log({maxCount: 5})
    return log.all.length
  } catch {
    return 0
  }
}

/**
 * Move a finished staging directory over the existing agent.
 * The previous directory is restored if the final rename fails.
 */
function commitStagedImport(staging: string, finalPath: string, backup: string): void {
  fs.rmSync(backup, {recursive: true, force: true})
  fs.renameSync(finalPath, backup)
  try {
    fs.renameSync(staging, finalPath)
  } catch (error) {
    if (!fs.existsSync(finalPath) && fs.existsSync(backup)) {
      fs.renameSync(backup, finalPath)
    }
    throw error
  }
  fs.rmSync(backup, {recursive: true, force: true})
}

function isAuthFailure(message: string): boolean {
  return /authentication failed|permission denied|could not read username|terminal prompts disabled|publickey|invalid credentials/i.test(message)
}

function normalizeImportError(error: unknown, kind: 'git' | 'local', agentName: string): AgentImportError {
  if (error instanceof AgentImportError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (kind === 'git' && isAuthFailure(message)) {
    return new AgentImportError(message, 'auth', {agentName, sourceKind: kind})
  }
  return new AgentImportError(message || 'Import failed.', 'other', {agentName, sourceKind: kind})
}
