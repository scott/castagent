import {Args, Command} from '@oclif/core'
import * as path from 'path'
import * as fs from 'fs'
import {db} from '../sqlite'
import {keychain} from '../keychain'
import {runtimeConfigErrorIsCurrent, waitForContainerHealth} from './container-health'
import {
  assertSecretsNotInArgv,
  checkCli,
  deploymentShaFromEnv,
  execCommand,
  filterInferenceEnv,
  flySecretsImportArgs,
  formatFlySecretsImport,
  type InferenceCatalogEntry,
  generateAuthToken,
  getAgentPath,
  inferenceEnv,
  isShaPattern,
  readAgentModel,
  saveDeployment,
  secretValues,
  stageCastRuntime,
} from './deploy-utils'

/** Public A2A agent card. Fly's HTTP check and the post-deploy probe both GET this path. */
export const FLY_AGENT_CARD_PATH = '/.well-known/agent.json'
export const FLY_READY_TIMEOUT_MS = 120_000
export const FLY_READY_INTERVAL_MS = 2_000

/** `flyctl secrets import --stage` reads NAME=VALUE lines from stdin and does not restart the app. */
export async function importFlySecrets(
  cwd: string,
  appName: string,
  secrets: Record<string, string>,
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const args = flySecretsImportArgs(appName)
  const input = formatFlySecretsImport(secrets)
  assertSecretsNotInArgv('flyctl secrets import', args, secretValues(secrets))
  return execCommand('flyctl', args, {
    cwd,
    silent: true,
    shell: false,
    input,
  })
}

/** Fly volume names are lowercase letters, numbers, and underscores, at most 30 characters. */
export const FLY_VOLUME_NAME_MAX = 30
export const FLY_VOLUME_NAME_PATTERN = /^[a-z0-9_]{1,30}$/
export const FLY_REGION = 'iad'
export const FLY_MEMORY_MOUNT = '/app/agent/memory'

export function isFlyVolumeName(name: string): boolean {
  return FLY_VOLUME_NAME_PATTERN.test(name)
}

export function flyAppName(agentName: string): string {
  return `cast-${agentName}`
}

export function flyDeploymentUrl(agentName: string): string {
  return `https://${flyAppName(agentName)}.fly.dev`
}

/**
 * Stable Fly volume name for an agent.
 * Hyphens and other separators become underscores. The result always matches
 * Fly's volume name rules so create and destroy use the same name.
 */
export function flyVolumeName(agentName: string): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
  const prefix = 'cast_'
  const suffix = '_memory'
  const budget = FLY_VOLUME_NAME_MAX - prefix.length - suffix.length
  let body = slug.slice(0, budget).replace(/_+$/g, '')
  if (!body) body = 'agent'
  if (body.length > budget) body = body.slice(0, budget).replace(/_+$/g, '') || 'agent'
  const name = `${prefix}${body}${suffix}`
  if (!isFlyVolumeName(name)) {
    throw new Error(`Could not build a Fly volume name for '${agentName}'`)
  }
  return name
}

/** Computed name plus every recorded name that Fly will accept. */
export function flyVolumeNamesForDestroy(agentName: string, recorded: Array<string | null | undefined>): string[] {
  const names: string[] = []
  const add = (name: string | null | undefined) => {
    if (!name || !isFlyVolumeName(name) || names.includes(name)) return
    names.push(name)
  }
  add(flyVolumeName(agentName))
  for (const name of recorded) add(name)
  return names
}

export interface FlyBuilderOptions {
  localOnly?: boolean
  remoteOnly?: boolean
  /** true passes --depot. 'false' passes --depot=false. Omit to leave the builder alone. */
  depot?: boolean | 'false'
}

export function flyBuilderOptions(flags: Record<string, unknown>): FlyBuilderOptions {
  const localOnly = flags['local-only'] === true
  const remoteOnly = flags['remote-only'] === true
  const depot = flags.depot === true
  const noDepot = flags['no-depot'] === true
  if (localOnly && remoteOnly) {
    throw new Error('Pass only one of --local-only or --remote-only.')
  }
  if (depot && noDepot) {
    throw new Error('Pass only one of --depot or --no-depot.')
  }
  const options: FlyBuilderOptions = {}
  if (localOnly) options.localOnly = true
  if (remoteOnly) options.remoteOnly = true
  if (depot) options.depot = true
  if (noDepot) options.depot = 'false'
  return options
}

export function flyDeployArgs(appName: string, builder: FlyBuilderOptions = {}): string[] {
  const args = ['deploy', '--app', appName]
  if (builder.localOnly) args.push('--local-only')
  if (builder.remoteOnly) args.push('--remote-only')
  if (builder.depot === true) args.push('--depot')
  if (builder.depot === 'false') args.push('--depot=false')
  return args
}

export function flyAppsCreateArgs(appName: string): string[] {
  return ['apps', 'create', appName, '--yes']
}

export function flyStatusArgs(appName: string): string[] {
  return ['status', '--app', appName]
}

export function flyLogsArgs(appName: string): string[] {
  return ['logs', '--app', appName, '--no-tail']
}

export function flyMachinesListArgs(appName: string): string[] {
  return ['machines', 'list', '--app', appName, '--json']
}

export function flyMachineStopArgs(machineId: string, appName: string, force: boolean): string[] {
  const args = ['machine', 'stop', machineId, '--app', appName]
  if (force) args.push('--signal', 'SIGKILL')
  return args
}

/** Destroy the machine. Stop is not enough: a stopped machine still binds its volume. */
export function flyMachineDestroyArgs(machineId: string, appName: string): string[] {
  return ['machine', 'destroy', machineId, '--app', appName, '--force']
}

export function flyVolumeCreateArgs(volumeName: string, appName: string, region = FLY_REGION): string[] {
  return ['volumes', 'create', volumeName, '--size', '1', '--region', region, '--app', appName, '--yes']
}

export function flyVolumesListArgs(appName: string): string[] {
  return ['volumes', 'list', '--app', appName, '--json']
}

/** `flyctl volumes delete` takes a volume id (`vol_...`), not the volume name. */
export function flyVolumeDeleteArgs(volumeId: string, appName: string): string[] {
  return ['volumes', 'delete', volumeId, '--app', appName, '--yes']
}

function flyVolumeList(stdout: string): Array<{id?: unknown; name?: unknown}> {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || '[]')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`flyctl volumes list did not return JSON: ${message}`)
  }
  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as {volumes?: unknown}).volumes)
      ? (parsed as {volumes: unknown[]}).volumes
      : undefined
  if (!list) throw new Error('flyctl volumes list did not return a JSON array')
  return list.filter((item): item is {id?: unknown; name?: unknown} => Boolean(item) && typeof item === 'object')
}

/** Every volume id that uses this name. Fly allows more than one. */
export function flyVolumeIdsByName(stdout: string, volumeName: string): string[] {
  const ids: string[] = []
  for (const record of flyVolumeList(stdout)) {
    if (record.name === volumeName && typeof record.id === 'string' && record.id.length > 0 && !ids.includes(record.id)) {
      ids.push(record.id)
    }
  }
  return ids
}

export function flyVolumeIdByName(stdout: string, volumeName: string): string | undefined {
  return flyVolumeIdsByName(stdout, volumeName)[0]
}

/**
 * Machine state from `flyctl machines list --json`.
 * An empty list is still starting. Every machine stopped is `stopped`.
 */
export function flyMachineState(stdout: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout.trim() || '[]')
  } catch {
    return 'starting'
  }
  if (!Array.isArray(parsed)) return 'starting'
  const states = parsed
    .map(item => {
      if (!item || typeof item !== 'object') return ''
      const state = (item as {state?: unknown}).state
      return typeof state === 'string' ? state.toLowerCase() : ''
    })
    .filter(state => state.length > 0)
  if (states.includes('started')) return 'started'
  if (states.some(state => state === 'starting' || state === 'created' || state === 'replacing')) {
    return 'starting'
  }
  if (states.length === 0) return 'starting'
  if (states.every(state => state === 'stopped' || state === 'destroyed' || state === 'failed' || state === 'suspended')) {
    return 'stopped'
  }
  return 'starting'
}

export function flyAgentCardUrl(deploymentUrl: string): string {
  return `${deploymentUrl.replace(/\/$/, '')}${FLY_AGENT_CARD_PATH}`
}

export async function probeFlyAgentCard(deploymentUrl: string): Promise<boolean> {
  const url = flyAgentCardUrl(deploymentUrl)
  try {
    const response = await fetch(url, {signal: AbortSignal.timeout(5_000)})
    if (!response.ok) return false
    const body = await response.json()
    return Boolean(body && typeof body === 'object' && !Array.isArray(body))
  } catch {
    return false
  }
}

function tailText(text: string, maxLines = 80): string {
  const lines = text.trim().split('\n')
  if (lines.length <= maxLines) return text.trim()
  return lines.slice(-maxLines).join('\n').trim()
}

export function flyHealthFailureMessage(
  appName: string,
  deploymentUrl: string,
  result: {status: string; logs: string; reason: 'exited' | 'timeout'},
): string {
  const status = result.status || 'unknown'
  const summary = result.reason === 'timeout'
    ? `Fly machine for '${appName}' did not become ready (status: ${status}).`
    : status.toLowerCase() === 'running'
      ? `Fly machine for '${appName}' failed before the runtime was ready.`
      : `Fly machine for '${appName}' exited before the runtime was ready.`
  const logs = tailText(result.logs)
  const parts = [summary, `Status: ${status}`, `Expected: ${flyAgentCardUrl(deploymentUrl)}`]
  if (logs) parts.push(logs)
  parts.push(`Logs: cast logs ${appName}`)
  return parts.join('\n')
}

export function flyAppsDestroyArgs(appName: string): string[] {
  return ['apps', 'destroy', appName, '--yes']
}

export function flyAppMissing(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase()
  return text.includes('could not find app')
    || text.includes('app not found')
    || text.includes('no app found')
    || text.includes('does not exist')
}

export function flyAlreadyExists(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase()
  return text.includes('already exists')
    || text.includes('already been taken')
    || text.includes('name is taken')
}

/** "Already gone" from either stream. A generic "error" line is not enough. */
export function flyResourceGone(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase()
  return text.includes('not found')
    || text.includes('does not exist')
    || text.includes('could not find')
}

const RUNNING_MACHINE_STATES = new Set(['started', 'starting', 'replacing'])

/**
 * The app, machines, or volumes are still on Fly.
 * Shutdown must not mark the row deleted or drop the token when this is thrown.
 */
export class FlyResourcesRemainError extends Error {
  readonly keepDeployment = true
  constructor(message: string) {
    super(message)
    this.name = 'FlyResourcesRemainError'
  }
}

export function flyShutdownFailure(agentName: string, detail: string): FlyResourcesRemainError {
  return new FlyResourcesRemainError(
    `${detail} The deployment is still recorded. Run cast shutdown ${agentName} again to retry.`,
  )
}

/** Every machine still on the app. A stopped machine still holds its volume. */
export function flyMachineIds(stdout: string): string[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`flyctl machines list did not return JSON: ${message}`)
  }
  if (!Array.isArray(parsed)) throw new Error('flyctl machines list did not return a JSON array')
  const ids: string[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const id = typeof (item as {id?: unknown}).id === 'string' ? (item as {id: string}).id : ''
    const state = typeof (item as {state?: unknown}).state === 'string'
      ? (item as {state: string}).state.toLowerCase()
      : ''
    if (state === 'destroyed') continue
    if (!/^[a-zA-Z0-9]+$/.test(id)) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export function runningFlyMachineIds(stdout: string): string[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed)
  if (!Array.isArray(parsed)) return []
  const ids: string[] = []
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const id = typeof (item as {id?: unknown}).id === 'string' ? (item as {id: string}).id : ''
    const state = typeof (item as {state?: unknown}).state === 'string'
      ? (item as {state: string}).state.toLowerCase()
      : ''
    if (!RUNNING_MACHINE_STATES.has(state)) continue
    if (!/^[a-zA-Z0-9]+$/.test(id)) continue
    ids.push(id)
  }
  return ids
}

export function readFlyPrimaryRegion(toml: string | undefined): string {
  if (!toml) return FLY_REGION
  const match = /^primary_region\s*=\s*"([a-z0-9-]+)"/m.exec(toml)
  return match ? match[1] : FLY_REGION
}

export function readFlyMountSource(toml: string): string | undefined {
  let inMounts = false
  for (const line of toml.split('\n')) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (section) {
      inMounts = section[1].trim() === 'mounts'
      continue
    }
    if (!inMounts) continue
    const match = /^\s*source\s*=\s*"([^"]*)"\s*$/.exec(line)
    if (match) return match[1]
  }
  return undefined
}

export function renderFlyToml(agentName: string, volumeName: string): string {
  return `app = "${flyAppName(agentName)}"
primary_region = "${FLY_REGION}"

[build]
  dockerfile = "Dockerfile"

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = true
  auto_start_machines = true
  min_machines_running = 0
  processes = ["app"]

[mounts]
  source = "${volumeName}"
  destination = "${FLY_MEMORY_MOUNT}"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 512
`
}

export function rewriteFlyMountSource(toml: string, volumeName: string): string {
  const lines = toml.split('\n')
  let inMounts = false
  let replaced = false
  const next = lines.map(line => {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line)
    if (section) {
      inMounts = section[1].trim() === 'mounts'
      return line
    }
    if (inMounts && /^\s*source\s*=/.test(line)) {
      replaced = true
      return `  source = "${volumeName}"`
    }
    return line
  })
  if (replaced) return next.join('\n')
  const block = `[mounts]\n  source = "${volumeName}"\n  destination = "${FLY_MEMORY_MOUNT}"\n`
  if (toml.endsWith('\n')) return `${toml}${block}`
  return `${toml}\n${block}`
}

export function resolveFlyVolumeName(existingToml: string | undefined, agentName: string): {volumeName: string; toml: string} {
  const fallback = flyVolumeName(agentName)
  if (existingToml === undefined) {
    return {volumeName: fallback, toml: renderFlyToml(agentName, fallback)}
  }
  const current = readFlyMountSource(existingToml)
  if (current && isFlyVolumeName(current)) {
    return {volumeName: current, toml: existingToml}
  }
  const toml = rewriteFlyMountSource(existingToml, fallback)
  return {volumeName: fallback, toml}
}

export function ensureFlyToml(agentPath: string, agentName: string): string {
  const flyTomlPath = path.join(agentPath, 'fly.toml')
  const existing = fs.existsSync(flyTomlPath) ? fs.readFileSync(flyTomlPath, 'utf8') : undefined
  const resolved = resolveFlyVolumeName(existing, agentName)
  if (resolved.toml !== existing) {
    fs.writeFileSync(flyTomlPath, resolved.toml)
  }
  return resolved.volumeName
}

export interface FlyCommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface FlyHost {
  log(message: string): void
  warn(message: string): void
  error(message: string): never
}

export interface FlyDeployDeps {
  exec(args: string[], opts?: {cwd?: string; silent?: boolean; shell?: boolean}): Promise<FlyCommandResult>
  generateAuthToken(agentName: string): Promise<{authToken: string; tokenHash: string}>
  saveDeployment: typeof saveDeployment
  listDeployments(agentName: string): Array<{id?: string; provider?: string; volume_id?: string | null}>
  discardTokens(agentName: string, deploymentSha?: string, recordedId?: string): Promise<void>
  inferenceEnv(): Record<string, string>
  /** When set, secret filtering uses this catalog instead of the Python one. */
  inferenceCatalog?: InferenceCatalogEntry[]
  importSecrets(cwd: string, appName: string, secrets: Record<string, string>): Promise<FlyCommandResult>
  stageRuntime(agentPath: string): void
  confirmReady(input: {appName: string; deploymentUrl: string; exec: FlyDeployDeps['exec']}): Promise<void>
  checkCli(): Promise<void>
}

function defaultFlyDeployDeps(): FlyDeployDeps {
  return {
    exec: (args, opts) => execCommand('flyctl', args, {
      cwd: opts?.cwd,
      silent: opts?.silent,
      shell: opts?.shell,
    }),
    generateAuthToken: (agentName) => generateAuthToken(agentName),
    saveDeployment,
    listDeployments: (agentName) => db.listDeployments(agentName),
    discardTokens: discardFailedFlyTokens,
    inferenceEnv: () => inferenceEnv(),
    importSecrets: (cwd, appName, secrets) => importFlySecrets(cwd, appName, secrets),
    stageRuntime: agentPath => stageCastRuntime(agentPath),
    confirmReady: input => waitForFlyHealth(input),
    checkCli: () => checkCli('flyctl', 'https://fly.io/docs/hands-on/install-flyctl/'),
  }
}

/**
 * Drop the bearer token written for a Fly deploy that did not finish.
 * The per-deployment file for this attempt is always removed. The agent
 * token is removed when no other live deployment still needs it.
 */
export async function discardFailedFlyTokens(
  agentName: string,
  deploymentSha?: string,
  recordedId?: string,
): Promise<void> {
  const ids = new Set<string>()
  if (deploymentSha && isShaPattern(deploymentSha)) ids.add(deploymentSha)
  if (recordedId && isShaPattern(recordedId)) ids.add(recordedId)
  for (const id of ids) {
    await keychain.deleteDeploymentToken(id)
  }
  const others = db.listDeployments(agentName).filter((row: {id?: string}) => !row.id || !ids.has(row.id))
  if (others.length === 0) {
    await keychain.deleteToken(agentName)
  }
}

function commandDetail(result: FlyCommandResult): string {
  return (result.stderr || result.stdout || `exit ${result.exitCode}`).trim()
}

export async function deleteFlyVolumeByName(
  volumeName: string,
  appName: string,
  exec: FlyDeployDeps['exec'],
): Promise<'removed' | 'absent'> {
  const listed = await exec(flyVolumesListArgs(appName), {silent: true, shell: false})
  if (listed.exitCode !== 0) {
    if (flyResourceGone(listed.stdout, listed.stderr)) return 'absent'
    throw new Error(`Failed to list Fly volumes for '${appName}': ${commandDetail(listed)}`)
  }
  const volumeIds = flyVolumeIdsByName(listed.stdout, volumeName)
  if (volumeIds.length === 0) return 'absent'
  let removed = false
  for (const volumeId of volumeIds) {
    const deleted = await exec(flyVolumeDeleteArgs(volumeId, appName), {silent: true, shell: false})
    if (deleted.exitCode === 0) {
      removed = true
      continue
    }
    if (flyResourceGone(deleted.stdout, deleted.stderr)) continue
    throw new Error(`Failed to delete Fly volume '${volumeName}' (${volumeId}): ${commandDetail(deleted)}`)
  }
  return removed ? 'removed' : 'absent'
}

/**
 * Create the named memory volume only when the app does not already have one.
 * Fly allows several volumes to share a name, so a create that "succeeds"
 * would add another 1 GB volume instead of attaching the existing one.
 */
export async function ensureFlyMemoryVolume(input: {
  volumeName: string
  appName: string
  region?: string
  cwd?: string
  exec: FlyDeployDeps['exec']
  log?: (message: string) => void
}): Promise<void> {
  const listed = await input.exec(flyVolumesListArgs(input.appName), {
    cwd: input.cwd,
    silent: true,
    shell: false,
  })
  if (listed.exitCode !== 0) {
    throw new Error(`Failed to list Fly volumes for '${input.appName}': ${commandDetail(listed)}`)
  }
  if (flyVolumeIdsByName(listed.stdout, input.volumeName).length > 0) {
    input.log?.(`Reusing memory volume: ${input.volumeName}`)
    return
  }
  input.log?.(`Creating memory volume: ${input.volumeName}`)
  const created = await input.exec(
    flyVolumeCreateArgs(input.volumeName, input.appName, input.region ?? FLY_REGION),
    {cwd: input.cwd, silent: true, shell: false},
  )
  if (created.exitCode !== 0 && !flyAlreadyExists(created.stdout, created.stderr)) {
    throw new Error(`Failed to create volume: ${commandDetail(created)}`)
  }
}

export async function waitForFlyHealth(input: {
  appName: string
  deploymentUrl: string
  exec: FlyDeployDeps['exec']
  probeUrl?: (deploymentUrl: string) => Promise<boolean>
  timeoutMs?: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}): Promise<void> {
  const probeUrl = input.probeUrl ?? probeFlyAgentCard
  const health = await waitForContainerHealth(async () => {
    const machines = await input.exec(flyMachinesListArgs(input.appName), {silent: true, shell: false})
    const logs = await input.exec(flyLogsArgs(input.appName), {silent: true, shell: false})
    const logText = `${logs.stdout}\n${logs.stderr}`.trim()
    const state = machines.exitCode === 0 ? flyMachineState(machines.stdout) : 'starting'
    // A started machine is ready only when the public agent card answers.
    // Older crash lines stay in flyctl logs, so a missing module fails the
    // deploy only once every machine is stopped. A current
    // `Error loading agent config` is the runtime refusing agent.yaml, and
    // that fails the deploy while the machine is still started or starting.
    if (state !== 'stopped' && runtimeConfigErrorIsCurrent(logText)) {
      return {status: 'running', logs: logText}
    }
    if (state === 'started') {
      const ready = await probeUrl(input.deploymentUrl)
      if (ready) return {status: 'running', logs: 'Agent ready'}
      return {status: 'starting', logs: ''}
    }
    if (state === 'stopped') {
      return {status: 'exited', logs: logText || `${machines.stderr}\n${machines.stdout}`}
    }
    return {status: 'starting', logs: ''}
  }, {
    timeoutMs: input.timeoutMs ?? FLY_READY_TIMEOUT_MS,
    intervalMs: input.intervalMs ?? FLY_READY_INTERVAL_MS,
    sleep: input.sleep,
    now: input.now,
  })
  if (!health.ok) {
    throw new Error(flyHealthFailureMessage(input.appName, input.deploymentUrl, health))
  }
}

async function ensureFlyApp(
  appName: string,
  cwd: string,
  deps: FlyDeployDeps,
  host: FlyHost,
): Promise<void> {
  const status = await deps.exec(flyStatusArgs(appName), {cwd, silent: true})
  if (status.exitCode === 0) return

  const missing = flyAppMissing(status.stdout, status.stderr)
  if (missing) host.log('Creating Fly.io app...')
  const created = await deps.exec(flyAppsCreateArgs(appName), {cwd})
  if (created.exitCode === 0) return
  if (flyAlreadyExists(created.stdout, created.stderr)) return
  throw new Error(`Failed to create Fly.io app: ${commandDetail(created)}`)
}

export async function deployFlyAgent(input: {
  agentName: string
  agentPath: string
  builder?: FlyBuilderOptions
  host: FlyHost
}, deps: FlyDeployDeps = defaultFlyDeployDeps()): Promise<void> {
  const {agentName, agentPath, host} = input
  const builder = input.builder ?? {}
  if (!fs.existsSync(agentPath)) {
    host.error(`Agent '${agentName}' not found at ${agentPath}`)
  }

  host.log(`Deploying ${agentName} to Fly.io...`)

  try {
    await deps.checkCli()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    host.error(message)
  }

  deps.stageRuntime(agentPath)

  const appName = flyAppName(agentName)
  const deploymentUrl = flyDeploymentUrl(agentName)
  const deploymentSha = deploymentShaFromEnv()
  let recordedEarly = false
  let recordedId: string | undefined
  // True only after `flyctl deploy` exits 0. Staged secrets are live then,
  // so a later health failure must keep the new token.
  let released = false
  let tokenHash = ''
  let volumeName = ''
  let volumeConfig = ''

  try {
    const generated = await deps.generateAuthToken(agentName)
    const authToken = generated.authToken
    tokenHash = generated.tokenHash
    volumeName = ensureFlyToml(agentPath, agentName)
    const flyToml = fs.readFileSync(path.join(agentPath, 'fly.toml'), 'utf8')
    const region = readFlyPrimaryRegion(flyToml)
    volumeConfig = JSON.stringify({mountPath: FLY_MEMORY_MOUNT, region})

    await ensureFlyApp(appName, agentPath, deps, host)

    const alreadyRecorded = deps.listDeployments(agentName).some(row => row.provider === 'fly')
    if (!alreadyRecorded) {
      recordedId = deps.saveDeployment(agentName, 'fly', deploymentUrl, tokenHash, volumeName, volumeConfig)
      recordedEarly = true
    }

    await ensureFlyMemoryVolume({
      volumeName,
      appName,
      region,
      cwd: agentPath,
      exec: (args, opts) => deps.exec(args, opts),
      log: message => host.log(message),
    })

    host.log('Setting secrets...')
    const secrets: Record<string, string> = {
      CAST_AGENT_NAME: agentName,
      AUTH_TOKEN: authToken,
      ...filterInferenceEnv(readAgentModel(agentPath), deps.inferenceEnv(), deps.inferenceCatalog),
    }
    const secretResult = await deps.importSecrets(agentPath, appName, secrets)
    if (secretResult.exitCode !== 0) {
      throw new Error(`Failed to set secrets: ${commandDetail(secretResult)}`)
    }

    host.log('Deploying to Fly.io...')
    const deployResult = await deps.exec(flyDeployArgs(appName, builder), {
      cwd: agentPath,
    })
    if (deployResult.exitCode !== 0) {
      throw new Error(`Fly.io deployment failed: ${commandDetail(deployResult)}`)
    }
    released = true

    host.log('Waiting for the Fly machine to become ready...')
    await deps.confirmReady({
      appName,
      deploymentUrl,
      exec: (args, opts) => deps.exec(args, opts),
    })

    if (!recordedEarly) {
      deps.saveDeployment(agentName, 'fly', deploymentUrl, tokenHash, volumeName, volumeConfig)
    }

    host.log('')
    host.log('╔══════════════════════════════════════════════════════════════╗')
    host.log('║              Fly.io Deployment Successful!                   ║')
    host.log('╚══════════════════════════════════════════════════════════════╝')
    host.log('')
    host.log(`Agent: ${agentName}`)
    host.log(`URL: ${deploymentUrl}`)
    host.log('Provider: fly')
    host.log('')
    host.log('To view logs:')
    host.log(`  cast logs ${agentName}`)
    host.log('')
    host.log('To check status:')
    host.log(`  cast status ${agentName}`)
    host.log('')
    host.log('To connect:')
    host.log(`  cast connect ${agentName}`)
  } catch (error) {
    // A failed build never released the staged secrets, so the running
    // machine still has its previous token. Drop only this attempt.
    // Once deploy has exited 0 the new token is the live one: keep it,
    // and record the row when this was a redeploy.
    if (released && !recordedEarly && tokenHash) {
      try {
        recordedId = deps.saveDeployment(agentName, 'fly', deploymentUrl, tokenHash, volumeName, volumeConfig)
        recordedEarly = true
      } catch (saveError) {
        const message = saveError instanceof Error ? saveError.message : String(saveError)
        host.warn(`Failed to record the Fly deployment after the release: ${message}`)
      }
    }
    if (!released) {
      try {
        await deps.discardTokens(agentName, deploymentSha, recordedEarly ? recordedId : undefined)
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        host.warn(`Failed to remove the auth token from the failed deploy: ${message}`)
      }
    }
    if (recordedEarly) {
      host.log(`Recorded the Fly deployment so cast shutdown ${agentName} can remove the app.`)
    }
    throw error
  }
}

function machineAlreadyDestroyed(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase()
  return text.includes('already been destroyed') || text.includes('already destroyed')
}

/** A stopped machine still binds its volume, so destroy every machine before the app. */
async function destroyFlyMachines(
  agentName: string,
  appName: string,
  exec: FlyDeployDeps['exec'],
): Promise<void> {
  const listed = await exec(flyMachinesListArgs(appName), {silent: true, shell: false})
  if (listed.exitCode !== 0) {
    if (flyResourceGone(listed.stdout, listed.stderr)) return
    throw flyShutdownFailure(agentName, `Failed to list Fly machines for '${appName}': ${commandDetail(listed)}`)
  }
  let ids: string[]
  try {
    ids = flyMachineIds(listed.stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw flyShutdownFailure(agentName, message)
  }
  for (const id of ids) {
    const destroyed = await exec(flyMachineDestroyArgs(id, appName), {silent: true, shell: false})
    if (destroyed.exitCode === 0) continue
    if (flyResourceGone(destroyed.stdout, destroyed.stderr) || machineAlreadyDestroyed(destroyed.stdout, destroyed.stderr)) {
      continue
    }
    throw flyShutdownFailure(
      agentName,
      `Failed to destroy Fly machine '${id}' for '${appName}': ${commandDetail(destroyed)}`,
    )
  }
}

export async function destroyFlyDeployment(
  agentName: string,
  options: {
    volumeNames: string[]
    exec?: FlyDeployDeps['exec']
    log?: (message: string) => void
  },
): Promise<void> {
  const exec = options.exec ?? ((args, opts) => execCommand('flyctl', args, {silent: opts?.silent, shell: false}))
  const log = options.log ?? ((message: string) => console.log(message))
  const appName = flyAppName(agentName)

  // Machines first. Fly refuses to delete a volume that is bound to a
  // machine, and stopping the machine does not release that bind.
  await destroyFlyMachines(agentName, appName, exec)

  const result = await exec(flyAppsDestroyArgs(appName), {silent: true})
  let appError: string | undefined
  if (result.exitCode === 0) {
    log(`Fly app '${appName}' has been destroyed.`)
  } else if (flyResourceGone(result.stdout, result.stderr)) {
    log(`App '${appName}' does not exist (already deleted or never created).`)
  } else {
    appError = `Failed to destroy Fly app '${appName}': ${commandDetail(result)}`
  }

  for (const volumeName of options.volumeNames) {
    try {
      const outcome = await deleteFlyVolumeByName(volumeName, appName, exec)
      if (outcome === 'removed') {
        log(`Memory volume '${volumeName}' for '${appName}' has been removed.`)
      } else {
        log(`Memory volume '${volumeName}' for '${appName}' was not present.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw flyShutdownFailure(agentName, appError ? `${appError} ${message}` : message)
    }
  }

  if (appError) throw flyShutdownFailure(agentName, appError)
}

export default class FlyDeploy extends Command {
  static description = 'Deploy agent to Fly.io'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(FlyDeploy)
    const agentName = args.agent as string
    await deployFlyAgent({
      agentName,
      agentPath: getAgentPath(agentName),
      host: {
        log: message => this.log(message),
        warn: message => this.warn(message),
        error: message => this.error(message),
      },
    })
  }

  static async destroy(agentName: string, volumeId?: string | null): Promise<void> {
    const recorded = db.listDeployments(agentName)
      .filter((row: {provider?: string}) => row.provider === 'fly')
      .map((row: {volume_id?: string | null}) => row.volume_id)
    if (volumeId) recorded.push(volumeId)
    await destroyFlyDeployment(agentName, {
      volumeNames: flyVolumeNamesForDestroy(agentName, recorded),
    })
  }
}
