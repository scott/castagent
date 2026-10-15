import {Args, Command, Flags} from '@oclif/core'
import {execFileSync, spawn, type ChildProcess} from 'child_process'
import {createHash} from 'crypto'
import * as net from 'net'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import axios from 'axios'
import {
  generateAuthToken,
  getAgentPath,
  saveDeployment,
  inferenceEnv,
  getProviderToken,
  execCommand,
  execCommandIgnoreError,
  generateDeploymentId,
  prepareHostTuiBuildContext,
  prepareCastImageContext,
  installPin,
  checkCli,
  deploymentShaFromEnv,
  isShaPattern,
} from './deploy-utils'
import {containerHealthFailureMessage, waitForContainerHealth, type ContainerProbe} from './container-health'
import {buildCloudInitBaselineMotd, buildHostMotd, writeHostMotdOverSsh} from './motd'
import type {MotdContext} from './motd'
import {shellSingleQuote} from './sprites-service'
import {db} from '../sqlite'
import {keychain} from '../keychain'
import type {ProviderToolCheck} from './types'
import {
  assertOpenSshEd25519PrivateKey,
  assertPinnedHostKey,
  castDoKeyPath,
  castKnownHostsPath,
  digitalOceanSshBaseOptions,
  execDigitalOceanSsh,
  forgetDropletHostKey,
  generateEd25519HostKeyPair,
  normalizeEd25519PublicKey,
  recordPinnedHostKey,
  SshHostKeyError,
  syncDropletAddress,
} from './ssh-hostkey'

export const SSH_KEY_NAME = 'cast-do-key'

/** OpenSSH client tools. Deploy checks both before it stores an auth token. */
export const DIGITALOCEAN_SSH_TOOL_CHECKS: ProviderToolCheck[] = [
  {
    command: 'ssh',
    installUrl: 'https://www.openssh.com/',
    error: 'ssh is required for DigitalOcean deployment. Install the OpenSSH client.',
  },
  {
    command: 'ssh-keygen',
    installUrl: 'https://www.openssh.com/',
    error: 'ssh-keygen is required for DigitalOcean deployment. Install OpenSSH.',
  },
]

function sshLoginKeyPath(): string {
  return castDoKeyPath()
}

// Execute SSH command with shell: false to prevent shell from interfering with options.
// A 30s default timeout is applied so a hung SSH probe can't block
// callers (notably `waitForDocker`'s retry loop) for many minutes.
// Host key checking stays enabled. The pin is a Cast known_hosts file.
async function execSsh(
  ip: string,
  remoteCmd: string,
  silent = false,
  timeoutMs = 30_000,
  input?: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return execDigitalOceanSsh(ip, remoteCmd, {silent, timeoutMs, input})
}

function sshLoginHint(ip: string, remote?: string): string {
  const known = castKnownHostsPath()
  const home = os.homedir()
  const shown = known.startsWith(`${home}${path.sep}`)
    ? `~/${path.relative(home, known)}`
    : known
  const base = `ssh -i ~/.ssh/cast_do_key -o UserKnownHostsFile=${shown} -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 root@${ip}`
  return remote ? `${base} ${remote}` : base
}

function indentBlock(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces)
  return text
    .replace(/\s+$/, '')
    .split('\n')
    .map((line) => line.length > 0 ? pad + line : '')
    .join('\n')
}

/**
 * Cloud-config for a new droplet. The ed25519 host key is one Cast
 * generated locally. cloud-init writes it before sshd serves the
 * public address, and Cast pins the matching public key.
 * runcmd stays a flat list of single-line strings so the strict
 * cloud-init schema accepts the document.
 */
export function buildDropletCloudInit(input: {
  privateKey: string
  publicKey: string
  baselineMotd: string
  installScript: string
}): string {
  assertOpenSshEd25519PrivateKey(input.privateKey)
  const publicKey = normalizeEd25519PublicKey(input.publicKey)
  const privateIndented = indentBlock(input.privateKey, 4)
  const motdIndented = indentBlock(input.baselineMotd, 10)
  const scriptIndented = indentBlock(input.installScript, 10)
  return [
    '#cloud-config',
    'ssh_deletekeys: true',
    'ssh_genkeytypes:',
    '  - ed25519',
    'ssh_keys:',
    '  ed25519_private: |',
    privateIndented,
    `  ed25519_public: "${publicKey}\\n"`,
    'write_files:',
    '  - path: /etc/ssh/sshd_config.d/99-cast-host-key.conf',
    '    permissions: "0644"',
    '    owner: root',
    '    group: root',
    '    content: |',
    '          HostKey /etc/ssh/ssh_host_ed25519_key',
    '  - path: /etc/motd',
    '    permissions: "0644"',
    '    owner: root',
    '    group: root',
    '    content: |',
    motdIndented,
    '  - path: /etc/profile.d/cast.sh',
    '    permissions: "0755"',
    '    owner: root',
    '    group: root',
    '    content: |',
    '          #!/bin/bash',
    '          : # cast placeholder',
    '  - path: /usr/local/bin/cast-install-docker.sh',
    '    permissions: "0755"',
    '    owner: root',
    '    group: root',
    '    content: |',
    scriptIndented,
    'runcmd:',
    '  - systemctl restart ssh || systemctl restart sshd || true',
    '  - /usr/local/bin/cast-install-docker.sh',
    '  - mkdir -p /var/lib/cast',
    '  - touch /var/lib/cast/docker-ready',
    '',
  ].join('\n')
}

/**
 * Remote `docker run` argv, with every word single-quoted.
 * The publish address is loopback. Secrets stay in the env file, not here.
 */
export function remoteDockerRunCommand(input: {
  imageTag: string
  volumeId: string
}): string {
  const args = [
    'docker', 'run', '-d',
    '--name', 'cast-agent',
    '--restart', 'unless-stopped',
    '-p', '127.0.0.1:8080:8080',
    '-v', `/mnt/${input.volumeId}:/app/agent/memory`,
    '--env-file', DROPLET_ENV_FILE,
    input.imageTag,
  ]
  return args.map(shellSingleQuote).join(' ')
}

/** Registry URL for a droplet. The agent is not served on this URL. */
export function dropletDeploymentUrl(ip: string): string {
  if (!/^[A-Za-z0-9.-]+$/.test(ip)) {
    throw new Error('Refusing to record a deployment URL for an invalid droplet address')
  }
  return `https://${ip}`
}

/**
 * Droplet address from a stored deployment URL.
 * Accepts the current https URL and older http://ip:8080 rows.
 */
export function dropletHostFromUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new Error('DigitalOcean deployment URL is not valid')
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('DigitalOcean deployment URL must use https or http')
  }
  const host = parsed.hostname
  if (!/^[A-Za-z0-9.-]+$/.test(host) || host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') {
    throw new Error('DigitalOcean deployment URL is missing a droplet address')
  }
  return host
}

export function isLoopbackClientUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  } catch {
    return false
  }
}

/** Root-only env file. docker run reads it with --env-file. */
export const DROPLET_ENV_FILE = '/var/lib/cast/cast-agent.env'

/**
 * Remove a public 8080 allow left by an older deploy.
 * This does not add an allow rule.
 */
export const DROPLET_CLOSE_PUBLIC_PORT =
  'ufw --force delete allow 8080/tcp || true; ufw --force delete allow 8080/tcp || true'

/**
 * Install the env file from stdin. The secret values are not part of this command.
 * umask 077 keeps the file private while cat creates it, then chmod locks it to 0600.
 */
export const DROPLET_ENV_INSTALL_COMMAND =
  'install -d -m 0700 /var/lib/cast && chmod 0700 /var/lib/cast && umask 077 && cat > /var/lib/cast/cast-agent.env && chmod 0600 /var/lib/cast/cast-agent.env'

export const DROPLET_LOG_MARKER = '---CAST-LOGS---'

/** Status plus the tail of the container logs. No secrets are part of this command. */
export function dropletContainerProbeCommand(containerName = 'cast-agent'): string {
  return `sh -c 'status=$(docker inspect --format {{.State.Status}} ${containerName} 2>/dev/null || printf missing); printf "%s\\n${DROPLET_LOG_MARKER}\\n" "$status"; docker logs --tail 200 ${containerName} 2>&1 || true'`
}

export function parseDropletContainerProbe(stdout: string, stderr = ''): ContainerProbe {
  const combined = stderr ? `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}` : stdout
  const index = combined.indexOf(DROPLET_LOG_MARKER)
  if (index === -1) return {status: 'missing', logs: combined.trim()}
  const status = combined.slice(0, index).trim().split('\n').filter(line => line.length > 0).pop() || 'missing'
  const logs = combined.slice(index + DROPLET_LOG_MARKER.length).replace(/^\n/, '')
  return {status, logs: logs.trim()}
}

export const DROPLET_STOP_CRASH_LOOP =
  'docker update --restart=no cast-agent >/dev/null 2>&1 || true; docker stop cast-agent >/dev/null 2>&1 || true'

const SHELL_TOKEN = /^[A-Za-z0-9_.:-]+$/

function assertShellToken(value: string, label: string): void {
  if (!SHELL_TOKEN.test(value)) {
    throw new Error(`Refusing to place ${label} in the remote shell command`)
  }
}

export function buildDropletEnvFile(env: Record<string, string>): string {
  const lines: string[] = []
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Refusing to write an env var named ${key}`)
    }
    if (/[\n\r\0']/.test(value)) {
      throw new Error(`Refusing to write ${key} because the value contains a newline or quote`)
    }
    const encoded = /[\s#]/.test(value) ? `'${value}'` : value
    lines.push(`${key}=${encoded}`)
  }
  return `${lines.join('\n')}\n`
}

export function buildDropletDockerRunCommand(volumeId: string, imageTag: string): string {
  assertShellToken(volumeId, 'volume id')
  assertShellToken(imageTag, 'image tag')
  return `docker run -d --name cast-agent --restart unless-stopped -p 127.0.0.1:8080:8080 -v /mnt/${volumeId}:/app/agent/memory --env-file ${DROPLET_ENV_FILE} ${imageTag}`
}

export function assertDropletDockerRunIsPrivate(command: string, secrets: string[]): void {
  const withoutLoopback = command.split('127.0.0.1:8080:8080').join('')
  if (withoutLoopback.includes('8080:8080') || command.includes('0.0.0.0:8080')) {
    throw new Error('Refusing to publish the droplet agent on a public port')
  }
  if (!command.includes('127.0.0.1:8080:8080')) {
    throw new Error('Droplet agent must bind to 127.0.0.1:8080')
  }
  assertCommandHasNoSecrets('docker run', command, secrets)
}

export function assertCommandHasNoSecrets(label: string, command: string, secrets: string[]): void {
  for (const secret of secrets) {
    if (secret && command.includes(secret)) {
      throw new Error(`Refusing to place a secret in ${label}`)
    }
  }
}

export function buildDropletTunnelArgs(ip: string, localPort: number): string[] {
  if (!/^[A-Za-z0-9.-]+$/.test(ip)) {
    throw new Error('Refusing to open an SSH tunnel to an invalid droplet address')
  }
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new Error('Invalid local tunnel port')
  }
  return [
    ...digitalOceanSshBaseOptions(),
    '-N',
    '-o', 'ExitOnForwardFailure=yes',
    '-L', `127.0.0.1:${localPort}:127.0.0.1:8080`,
    `root@${ip}`,
  ]
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const LEGACY_DO_VOLUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Droplet memory volume keyed by agent name (`cast-<name>`). */
export function digitalOceanMemoryVolumeName(agentName: string): string {
  return `cast-${agentName}`
}

/**
 * Pre-fix volumes were `cast-<agent>-<uuid>-memory`, one per deploy.
 * `cast-<agent>-latest-memory` is the name shutdown used to target. It was never created.
 */
export function isLegacyDigitalOceanMemoryVolume(volumeName: string, agentName: string): boolean {
  const prefix = `cast-${agentName}-`
  const suffix = '-memory'
  if (!volumeName.startsWith(prefix) || !volumeName.endsWith(suffix)) return false
  const deploymentId = volumeName.slice(prefix.length, volumeName.length - suffix.length)
  return LEGACY_DO_VOLUME_ID.test(deploymentId)
}

export function isAgentDigitalOceanMemoryVolume(volumeName: string, agentName: string): boolean {
  return volumeName === digitalOceanMemoryVolumeName(agentName) || isLegacyDigitalOceanMemoryVolume(volumeName, agentName)
}

export interface DigitalOceanMemoryPlan {
  volumeId: string
  action: 'create' | 'reuse'
}

/**
 * The documented Droplet volume is `cast-<agent>`. A later deploy reuses it.
 * When that volume is absent and an older uuid volume is still in the account,
 * the older volume is reused so this deploy does not allocate another one.
 * If the volume list cannot be read, a recorded volume is reused for the same reason.
 */
export function planDigitalOceanMemoryVolume(
  agentName: string,
  recordedVolumeId: string | null | undefined,
  listedVolumeNames: string[] | null,
): DigitalOceanMemoryPlan {
  const canonical = digitalOceanMemoryVolumeName(agentName)
  if (listedVolumeNames === null) {
    if (recordedVolumeId) return {volumeId: recordedVolumeId, action: 'reuse'}
    return {volumeId: canonical, action: 'create'}
  }
  if (listedVolumeNames.includes(canonical)) {
    return {volumeId: canonical, action: 'reuse'}
  }
  if (recordedVolumeId && listedVolumeNames.includes(recordedVolumeId)) {
    return {volumeId: recordedVolumeId, action: 'reuse'}
  }
  const legacy = listedVolumeNames.find(name => isLegacyDigitalOceanMemoryVolume(name, agentName))
  if (legacy) return {volumeId: legacy, action: 'reuse'}
  return {volumeId: canonical, action: 'create'}
}

export function digitalOceanMemoryVolumesToRemove(
  agentName: string,
  recordedVolumeIds: Array<string | null | undefined>,
  listedVolumeNames: string[] | null,
): string[] {
  const names = new Set<string>()
  for (const id of recordedVolumeIds) {
    if (id) names.add(id)
  }
  if (listedVolumeNames) {
    for (const name of listedVolumeNames) {
      if (isAgentDigitalOceanMemoryVolume(name, agentName)) names.add(name)
    }
  } else {
    names.add(digitalOceanMemoryVolumeName(agentName))
  }
  return [...names].sort()
}

/** Droplets and their block volumes are created in this region. */
export const DIGITALOCEAN_DROPLET_REGION = 'nyc3'

const DIGITALOCEAN_VOLUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DIGITALOCEAN_VOLUME_REGION = /^[a-z]{3}\d$/

export interface ListedDigitalOceanVolume {
  id: string
  name: string
  region: string
  /** Droplets that still have this volume attached. Empty once detach finishes. */
  dropletIds?: number[]
}

export interface DigitalOceanVolumeList {
  ok: boolean
  volumes: ListedDigitalOceanVolume[]
  error: string
}

export interface DigitalOceanVolumeDeleteTarget {
  name: string
  region: string
  /** DigitalOcean volume id. Null when this name is not listed in the region. */
  id: string | null
}

export type RecordedDigitalOceanVolume =
  | string
  | null
  | undefined
  | {name?: string | null; region?: string | null; volumeConfig?: string | null}

/**
 * Region stored on the deployment, or the droplet region when the
 * record does not name one. Volume names are unique per region.
 */
export function digitalOceanVolumeRegion(volumeConfig: string | null | undefined): string {
  if (volumeConfig) {
    try {
      const parsed = JSON.parse(volumeConfig) as {region?: unknown}
      if (typeof parsed.region === 'string' && DIGITALOCEAN_VOLUME_REGION.test(parsed.region)) {
        return parsed.region
      }
    } catch {
      // The stored config is not JSON. Droplets are created in nyc3.
    }
  }
  return DIGITALOCEAN_DROPLET_REGION
}

export function recordedDigitalOceanVolume(entry: RecordedDigitalOceanVolume): {name: string; region: string} | null {
  if (!entry) return null
  if (typeof entry === 'string') {
    const name = entry.trim()
    if (!name) return null
    return {name, region: DIGITALOCEAN_DROPLET_REGION}
  }
  const name = typeof entry.name === 'string' ? entry.name.trim() : ''
  if (!name) return null
  const region = typeof entry.region === 'string' && DIGITALOCEAN_VOLUME_REGION.test(entry.region)
    ? entry.region
    : digitalOceanVolumeRegion(entry.volumeConfig)
  return {name, region}
}

/** How long shutdown waits for a volume to finish detaching from its droplet. */
export const VOLUME_DETACH_TIMEOUT_MS = 120_000

const DETACH_INITIAL_DELAY_MS = 2_000
const DETACH_MAX_DELAY_MS = 15_000

/**
 * `doctl compute volume list --format ID,Name,Region,DropletIDs --no-header`.
 * A name or region with whitespace is rejected so a bad line is not
 * treated as an empty account. A missing droplet column means none are attached.
 */
export function parseDropletIdColumn(tokens: string[]): number[] | null {
  if (tokens.length === 0) return []
  const joined = tokens.join(' ')
  if (!/^[[\],0-9 ]*$/.test(joined)) return null
  const ids: number[] = []
  for (const match of joined.matchAll(/\d+/g)) ids.push(Number(match[0]))
  return ids
}

export function parseDigitalOceanVolumeList(stdout: string): DigitalOceanVolumeList {
  const volumes: ListedDigitalOceanVolume[] = []
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/\s+/)
    if (parts.length < 3) {
      return {ok: false, volumes: [], error: `Could not read volume list line: ${line}`}
    }
    const [id, name, region, ...rest] = parts
    const dropletIds = parseDropletIdColumn(rest)
    if (!DIGITALOCEAN_VOLUME_ID.test(id) || !name || !DIGITALOCEAN_VOLUME_REGION.test(region) || !dropletIds) {
      return {ok: false, volumes: [], error: `Could not read volume list line: ${line}`}
    }
    volumes.push({id, name, region, dropletIds})
  }
  return {ok: true, volumes, error: ''}
}

/** 409 while DigitalOcean is still detaching the volume from the droplet. */
export function isDigitalOceanVolumeAttachedError(detail: string): boolean {
  return /\b409\b/.test(detail)
    || /attached volume cannot be deleted/i.test(detail)
    || /volume is attached/i.test(detail)
}

export function findDigitalOceanVolumes(
  volumes: ListedDigitalOceanVolume[],
  name: string,
  region: string,
): ListedDigitalOceanVolume[] {
  return volumes.filter(volume => volume.name === name && volume.region === region)
}

/**
 * Volumes to delete for one agent. A recorded name that the list does
 * not contain in that region has a null id: the lookup found nothing.
 * Listed agent volumes are included only in the droplet region and in
 * regions named on a recorded deployment.
 */
export function planDigitalOceanVolumeDeletes(
  agentName: string,
  recorded: Array<{name: string; region: string}>,
  listed: ListedDigitalOceanVolume[],
): DigitalOceanVolumeDeleteTarget[] {
  const regions = new Set<string>([DIGITALOCEAN_DROPLET_REGION])
  for (const row of recorded) {
    if (row.region) regions.add(row.region)
  }

  const targets = new Map<string, DigitalOceanVolumeDeleteTarget>()
  for (const volume of listed) {
    if (!regions.has(volume.region)) continue
    if (!isAgentDigitalOceanMemoryVolume(volume.name, agentName)) continue
    targets.set(volume.id, {name: volume.name, region: volume.region, id: volume.id})
  }
  for (const row of recorded) {
    if (!row.name) continue
    const matches = findDigitalOceanVolumes(listed, row.name, row.region)
    if (matches.length === 0) {
      targets.set(`missing\0${row.region}\0${row.name}`, {name: row.name, region: row.region, id: null})
      continue
    }
    for (const match of matches) {
      targets.set(match.id, {name: match.name, region: match.region, id: match.id})
    }
  }

  return [...targets.values()].sort((a, b) => {
    const byName = a.name.localeCompare(b.name)
    if (byName !== 0) return byName
    return a.region.localeCompare(b.region)
  })
}

export interface DoctlCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function digitalOceanVolumeRemovalMessage(volumeName: string, result: DoctlCommandResult): string {
  if (result.exitCode === 0) return `Memory volume '${volumeName}' has been removed.`
  const detail = `${result.stderr}\n${result.stdout}`.trim()
  if (detail) return `Note: Memory volume '${volumeName}' could not be removed (${detail}).`
  return `Note: Memory volume '${volumeName}' could not be removed.`
}

export type DoctlRunner = (args: string[]) => Promise<DoctlCommandResult>

function defaultDoctlRunner(): DoctlRunner {
  return async (args) => {
    const result = await execCommand('doctl', args, {silent: true})
    return {exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr}
  }
}

export async function listDigitalOceanVolumeNames(run: DoctlRunner): Promise<string[] | null> {
  try {
    const result = await run(['compute', 'volume', 'list', '--format', 'Name', '--no-header'])
    if (result.exitCode !== 0) return null
    return result.stdout.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0)
  } catch {
    return null
  }
}

const VOLUME_LIST_ARGS = ['compute', 'volume', 'list', '--format', 'ID,Name,Region,DropletIDs', '--no-header']

/**
 * Clock for the detach wait. Tests replace `now` and `sleep` so a two minute
 * timeout does not block the suite. `sleep` must move `now` forward.
 */
export const volumeDetachClock = {
  now(): number {
    return Date.now()
  },
  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
  },
}

function nextDetachDelay(previous: number): number {
  if (previous <= 0) return DETACH_INITIAL_DELAY_MS
  return Math.min(previous * 2, DETACH_MAX_DELAY_MS)
}

/**
 * The deployment stays in the registry so a later `cast shutdown` can retry.
 * Shutdown must not mark the row deleted when this is thrown.
 */
export class DigitalOceanResourcesRemainError extends Error {
  readonly keepDeployment = true
  constructor(message: string) {
    super(message)
    this.name = 'DigitalOceanResourcesRemainError'
  }
}

export function volumeRemainsMessage(agentName: string, detail: string): string {
  return `${detail} The deployment is still recorded. Run cast shutdown ${agentName} again to retry.`
}

/** Look volumes up by id, name, and region. A failed list is an error, not an empty account. */
export async function readDigitalOceanVolumeList(run: DoctlRunner): Promise<DigitalOceanVolumeList> {
  try {
    const result = await run(VOLUME_LIST_ARGS)
    if (result.exitCode !== 0) {
      const detail = `${result.stderr}\n${result.stdout}`.trim() || 'volume list failed'
      return {ok: false, volumes: [], error: detail}
    }
    return parseDigitalOceanVolumeList(result.stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {ok: false, volumes: [], error: message}
  }
}

/**
 * Delete one volume after it has been resolved to an id.
 * A non-zero exit, including Not Found, is a real error.
 */
export async function deleteDigitalOceanVolumeById(
  run: DoctlRunner,
  volumeId: string,
): Promise<{deleted: boolean; error: string}> {
  try {
    const result = await run(['compute', 'volume', 'delete', volumeId, '--force'])
    if (result.exitCode === 0) return {deleted: true, error: ''}
    const detail = `${result.stderr}\n${result.stdout}`.trim() || 'volume delete failed'
    return {deleted: false, error: detail}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {deleted: false, error: message}
  }
}

/**
 * Delete a volume after its droplet_ids column is empty.
 * A 409 while the volume is still detaching is retried with backoff until
 * {@link VOLUME_DETACH_TIMEOUT_MS}. Any other delete error is returned at once.
 */
export async function deleteDigitalOceanVolumeAfterDetach(
  run: DoctlRunner,
  target: {id: string; name: string},
  log: (message: string) => void = () => {},
): Promise<{deleted: boolean; error: string}> {
  const deadline = volumeDetachClock.now() + VOLUME_DETACH_TIMEOUT_MS
  let delay = 0
  let lastError = ''
  let announced = false
  const announce = (detail: string) => {
    lastError = detail
    if (announced) return
    announced = true
    log(`Waiting for memory volume '${target.name}' to detach.`)
  }
  while (true) {
    const listed = await readDigitalOceanVolumeList(run)
    if (!listed.ok) {
      announce(listed.error)
    } else {
      const match = listed.volumes.find(volume => volume.id === target.id)
      if (!match) return {deleted: true, error: ''}
      const dropletIds = match.dropletIds ?? []
      if (dropletIds.length === 0) {
        const outcome = await deleteDigitalOceanVolumeById(run, target.id)
        if (outcome.deleted) return outcome
        if (!isDigitalOceanVolumeAttachedError(outcome.error)) return outcome
        announce(outcome.error)
      } else {
        announce(`attached to droplet ${dropletIds.join(', ')}`)
      }
    }
    const now = volumeDetachClock.now()
    if (now >= deadline) {
      const detail = lastError ? `${lastError}. The volume is still detaching` : 'the volume is still detaching'
      return {deleted: false, error: detail}
    }
    delay = nextDetachDelay(delay)
    const wait = Math.min(delay, deadline - now)
    if (wait <= 0) {
      return {deleted: false, error: `${lastError}. The volume is still detaching`}
    }
    await volumeDetachClock.sleep(wait)
  }
}

export async function removeDigitalOceanMemoryVolumes(
  agentName: string,
  recordedVolumeIds: RecordedDigitalOceanVolume[],
  run: DoctlRunner = defaultDoctlRunner(),
  log: (message: string) => void = console.log,
): Promise<void> {
  const listed = await readDigitalOceanVolumeList(run)
  if (!listed.ok) {
    throw new DigitalOceanResourcesRemainError(volumeRemainsMessage(
      agentName,
      `Memory volumes could not be looked up (${listed.error}).`,
    ))
  }
  const recorded = recordedVolumeIds
    .map(entry => recordedDigitalOceanVolume(entry))
    .filter((entry): entry is {name: string; region: string} => entry !== null)
  const targets = planDigitalOceanVolumeDeletes(agentName, recorded, listed.volumes)
  const failures: string[] = []
  for (const target of targets) {
    if (!target.id) continue
    const volumeId = target.id
    const outcome = await deleteDigitalOceanVolumeAfterDetach(run, {id: volumeId, name: target.name}, log)
    if (outcome.deleted) {
      log(`Memory volume '${target.name}' has been removed.`)
      continue
    }
    failures.push(`Memory volume '${target.name}' could not be removed (${outcome.error}).`)
  }
  if (failures.length > 0) {
    throw new DigitalOceanResourcesRemainError(volumeRemainsMessage(agentName, failures.join(' ')))
  }
}

function latestDigitalOceanVolumeId(agentName: string): string | null {
  const row = db.listDeployments(agentName).find((item: {provider?: string; volume_id?: string | null}) => item.provider === 'digitalocean')
  const volumeId = row?.volume_id
  return typeof volumeId === 'string' && volumeId.length > 0 ? volumeId : null
}

function findLoopbackPort(startPort: number, endPort: number): Promise<number> {
  const tryPort = (port: number): Promise<number> => {
    if (port > endPort) {
      return Promise.reject(new Error('No local port available for the droplet SSH tunnel'))
    }
    return new Promise((resolve, reject) => {
      const server = net.createServer()
      server.once('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          resolve(tryPort(port + 1))
          return
        }
        reject(err)
      })
      server.listen(port, '127.0.0.1', () => {
        server.close((closeErr) => {
          if (closeErr) reject(closeErr)
          else resolve(port)
        })
      })
    })
  }
  return tryPort(startPort)
}

function localPortAccepts(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port})
    const done = (open: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(200)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

/**
 * Forward a local loopback port to the agent on the droplet loopback.
 * The bearer token is not an argument and is not written to this process.
 */
export async function startDropletSshTunnel(
  ip: string,
  log: (message: string) => void,
): Promise<{url: string; process: ChildProcess}> {
  assertPinnedHostKey(ip)
  const localPort = await findLoopbackPort(18080, 18180)
  const args = buildDropletTunnelArgs(ip, localPort)
  log(`Opening an SSH tunnel to ${ip} on 127.0.0.1:${localPort}`)
  const child = spawn('ssh', args, {stdio: ['ignore', 'pipe', 'pipe']})
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-2000)
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) {
      try { child.kill() } catch { /* already gone */ }
      const detail = stderr.trim()
      throw new Error(detail
        ? `SSH tunnel to ${ip} exited before the forward was ready. ${detail}`
        : `SSH tunnel to ${ip} exited before the forward was ready`)
    }
    if (await localPortAccepts(localPort)) {
      return {url: `http://127.0.0.1:${localPort}`, process: child}
    }
    await delay(100)
  }
  try { child.kill() } catch { /* ignore */ }
  const detail = stderr.trim()
  throw new Error(detail
    ? `SSH tunnel to ${ip} did not open. ${detail}`
    : `SSH tunnel to ${ip} did not open`)
}

export interface AccountSshKey {
  id: number | string
  name: string
  /** MD5 fingerprint from the DigitalOcean account key, when the API sent one. */
  fingerprint?: string
}

export interface LoginKeySyncPlan {
  /** Account keys named cast-do-key whose fingerprint is not this machine's key. */
  deleteIds: Array<number | string>
  /** Upload the local public key. False when a matching account key is already present. */
  upload: boolean
}

/** OpenSSH `MD5:` prefix and letter case are not part of the fingerprint. */
export function normalizeSshFingerprint(value: string): string {
  return value.trim().replace(/^MD5:/i, '').toLowerCase()
}

/**
 * MD5 fingerprint of an OpenSSH public key, colon-separated.
 * This is the identifier `doctl` accepts for `--ssh-keys`.
 */
export function sshPublicKeyMd5Fingerprint(publicKey: string): string {
  const material = publicKey.trim().split(/\s+/)[1] || ''
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(material)) {
    throw new Error('SSH public key is missing its key material')
  }
  const blob = Buffer.from(material, 'base64')
  if (blob.length === 0) {
    throw new Error('SSH public key is missing its key material')
  }
  const hex = createHash('md5').update(blob).digest('hex')
  return (hex.match(/.{2}/g) || []).join(':')
}

/**
 * The droplet is logged into with the local `~/.ssh/cast_do_key`.
 * An account key that only shares the name `cast-do-key` is not that key.
 * A missing fingerprint is treated as stale so a later create does not
 * send an identifier DigitalOcean will reject.
 */
export function loginKeySyncPlan(keys: AccountSshKey[], localFingerprint: string): LoginKeySyncPlan {
  const local = normalizeSshFingerprint(localFingerprint)
  const named = keys.filter(key => key.name === SSH_KEY_NAME)
  const matches = named.filter(key =>
    typeof key.fingerprint === 'string' && key.fingerprint.length > 0 && normalizeSshFingerprint(key.fingerprint) === local,
  )
  const stale = named.filter(key => !matches.includes(key))
  return {
    deleteIds: stale.map(key => key.id),
    upload: matches.length === 0,
  }
}

/** doctl 1.181 prints API failures as JSON on stdout and leaves stderr empty. */
export function extractDigitalOceanErrorDetail(text: string): string {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return ''
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as {errors?: unknown}
    if (!parsed || !Array.isArray(parsed.errors)) return ''
    const details = parsed.errors
      .map(item => {
        if (!item || typeof item !== 'object') return ''
        const detail = (item as {detail?: unknown}).detail
        return typeof detail === 'string' ? detail.trim() : ''
      })
      .filter(detail => detail.length > 0)
    return details.join('\n')
  } catch {
    return ''
  }
}

export function digitalOceanCommandError(prefix: string, result: {stdout?: string; stderr?: string}): string {
  const stderr = (result.stderr || '').trim()
  const stdout = (result.stdout || '').trim()
  const parts: string[] = []
  if (stderr) parts.push(stderr)
  const detail = extractDigitalOceanErrorDetail(stdout)
  const extra = detail || (stdout && stdout !== stderr ? stdout : '')
  if (extra && !stderr.includes(extra)) parts.push(extra)
  const body = parts.join('\n')
  return body ? `${prefix}: ${body}` : prefix
}

export interface NamedDroplet {
  id: string
  name: string
}

export type AccountSshKeyCleanup =
  | {action: 'remove'; id: number | string}
  | {action: 'keep'}
  | {action: 'absent'}

export interface CastAccountKeyConsumer {
  id: string
  name: string
}

/**
 * The account key is shared. Remove it only when no other Cast droplet
 * and no Cast MicroVM (or other Cast resource that still references it)
 * remains. A droplet still listed under the id just deleted does not count.
 * Volumes and the container registry do not use this login key.
 */
export function accountSshKeyCleanup(
  droplets: NamedDroplet[],
  keys: AccountSshKey[],
  removedDropletId: string,
  stillUsing: CastAccountKeyConsumer[] = [],
): AccountSshKeyCleanup {
  const key = keys.find(item => item.name === SSH_KEY_NAME)
  const dropletRemains = droplets.some(droplet =>
    droplet.id !== removedDropletId && droplet.name.startsWith('cast-'),
  )
  const otherRemains = stillUsing.length > 0
  if (dropletRemains || otherRemains) return key ? {action: 'keep'} : {action: 'absent'}
  if (!key) return {action: 'absent'}
  return {action: 'remove', id: key.id}
}

/** True when a doctl argv would delete an account SSH key. */
export function isDigitalOceanSshKeyDelete(args: readonly string[]): boolean {
  return args.includes('ssh-key') && args.includes('delete')
}

function tagNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const names: string[] = []
  for (const tag of value) {
    if (typeof tag === 'string' && tag.length > 0) names.push(tag)
    else if (tag && typeof tag === 'object' && typeof (tag as {name?: unknown}).name === 'string') {
      names.push((tag as {name: string}).name)
    }
  }
  return names
}

function sshKeyEntryUsesAccountKey(entry: unknown): boolean {
  if (typeof entry === 'string') return entry === SSH_KEY_NAME
  if (!entry || typeof entry !== 'object') return false
  const name = (entry as {name?: unknown}).name
  return name === SSH_KEY_NAME
}

/**
 * Cast MicroVMs are named `cast-*` or tagged `cast`. A record that lists
 * SSH keys and does not include `cast-do-key` is not using it. A record
 * that does not say which keys it uses is treated as still using the key.
 */
export function castMicrovmsUsingAccountKey(stdout: string): CastAccountKeyConsumer[] {
  const trimmed = stdout.trim()
  if (!trimmed) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    throw new Error('Could not read the DigitalOcean MicroVM list')
  }
  const records = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as {microvms?: unknown}).microvms)
      ? (parsed as {microvms: unknown[]}).microvms
      : []
  const consumers: CastAccountKeyConsumer[] = []
  for (const record of records) {
    if (!record || typeof record !== 'object') continue
    const item = record as {id?: unknown; name?: unknown; tags?: unknown; ssh_keys?: unknown; sshKeys?: unknown}
    const id = item.id == null ? '' : String(item.id)
    const name = typeof item.name === 'string' ? item.name : ''
    if (!id) continue
    const createdByCast = name.startsWith('cast-') || tagNames(item.tags).includes('cast')
    if (!createdByCast) continue
    const listedKeys = Array.isArray(item.ssh_keys) ? item.ssh_keys : Array.isArray(item.sshKeys) ? item.sshKeys : null
    if (listedKeys && !listedKeys.some(sshKeyEntryUsesAccountKey)) continue
    consumers.push({id, name: name || id})
  }
  return consumers
}

/** Follow only the next page of this account's SSH keys. */
export function digitalOceanKeysPage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return null
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.digitalocean.com') return null
  if (parsed.port && parsed.port !== '443') return null
  if (parsed.username || parsed.password) return null
  if (parsed.pathname !== '/v2/account/keys') return null
  return parsed.toString()
}

async function listAccountSshKeys(apiToken: string): Promise<AccountSshKey[]> {
  const keys: AccountSshKey[] = []
  let url: string | null = 'https://api.digitalocean.com/v2/account/keys?per_page=200'
  for (let page = 0; page < 20 && url; page++) {
    const response = await axios.get(url, {
      headers: {Authorization: `Bearer ${apiToken}`},
    })
    const batch = response.data?.ssh_keys
    if (Array.isArray(batch)) {
      for (const item of batch) {
        if (!item || typeof item !== 'object') continue
        const id = (item as {id?: unknown}).id
        const name = (item as {name?: unknown}).name
        const fingerprint = (item as {fingerprint?: unknown}).fingerprint
        if ((typeof id === 'number' || typeof id === 'string') && typeof name === 'string') {
          keys.push({
            id,
            name,
            ...(typeof fingerprint === 'string' && fingerprint.length > 0 ? {fingerprint} : {}),
          })
        }
      }
    }
    url = digitalOceanKeysPage(response.data?.links?.pages?.next)
  }
  return keys
}

function axiosErrorDetail(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data
    const body = typeof data === 'string' ? data.trim() : data ? JSON.stringify(data) : ''
    return body ? `${error.message}: ${body}` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

function assertAccountSshKeyId(id: number | string): string {
  const text = String(id)
  if (!/^[0-9]+$/.test(text)) {
    throw new Error('Refusing to delete an SSH key with an unexpected id')
  }
  return text
}

async function listDropletRecords(): Promise<NamedDroplet[]> {
  const result = await execCommand(
    'doctl',
    ['compute', 'droplet', 'list', '--format', 'ID,Name', '--no-header'],
    {silent: true},
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || 'Failed to list DigitalOcean droplets')
  }
  const droplets: NamedDroplet[] = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2 || !parts[0] || !parts[1]) continue
    droplets.push({id: parts[0], name: parts[1]})
  }
  return droplets
}

async function listAccountSshKeysFromDoctl(): Promise<AccountSshKey[]> {
  const result = await execCommand(
    'doctl',
    ['compute', 'ssh-key', 'list', '--format', 'ID,Name', '--no-header'],
    {silent: true},
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to list DigitalOcean SSH keys')
  }
  const keys: AccountSshKey[] = []
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 2 || !parts[0] || !parts[1]) continue
    keys.push({id: parts[0], name: parts.slice(1).join(' ')})
  }
  return keys
}

async function listCastMicrovmsUsingAccountKey(): Promise<CastAccountKeyConsumer[]> {
  const result = await execCommand(
    'doctl',
    ['compute', 'microvm', 'list', '--output', 'json'],
    {silent: true},
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || 'Failed to list DigitalOcean MicroVMs')
  }
  return castMicrovmsUsingAccountKey(result.stdout)
}

/**
 * Delete `cast-do-key` only when no other Cast droplet, MicroVM, or
 * other Cast resource still uses it. Failures are logged. The droplet
 * delete has already finished. A failed deploy does not call this.
 */
export async function removeUnusedCastAccountSshKey(
  _apiToken: string,
  removedDropletId: string,
): Promise<'removed' | 'kept' | 'absent' | 'failed'> {
  try {
    const droplets = await listDropletRecords()
    const stillUsing = await listCastMicrovmsUsingAccountKey()
    const keys = await listAccountSshKeysFromDoctl()
    const decision = accountSshKeyCleanup(droplets, keys, removedDropletId, stillUsing)
    if (decision.action === 'keep') {
      console.log(`Left DigitalOcean account SSH key '${SSH_KEY_NAME}' in place. Another Cast droplet or MicroVM still uses it.`)
      return 'kept'
    }
    if (decision.action === 'absent') return 'absent'
    const id = assertAccountSshKeyId(decision.id)
    const deleted = await execCommand('doctl', ['compute', 'ssh-key', 'delete', id, '--force'], {silent: true})
    if (deleted.exitCode !== 0) {
      throw new Error(deleted.stderr || deleted.stdout || 'Failed to delete the account SSH key')
    }
    console.log(`Removed DigitalOcean account SSH key '${SSH_KEY_NAME}'.`)
    return 'removed'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`Note: DigitalOcean account SSH key '${SSH_KEY_NAME}' could not be removed. ${message}`)
    return 'failed'
  }
}

function resourceAlreadyGone(stdout: string, stderr: string): boolean {
  return /not found|could not be found|does not exist|\b404\b/i.test(`${stdout}\n${stderr}`)
}

async function runCleanupCommand(args: string[]): Promise<{exitCode: number; stdout: string; stderr: string}> {
  if (isDigitalOceanSshKeyDelete(args)) {
    throw new Error(`Refusing to delete the shared SSH key ${SSH_KEY_NAME}`)
  }
  try {
    return await execCommand('doctl', args, {silent: true})
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {exitCode: 1, stdout: '', stderr: message}
  }
}

async function findNamedDroplet(name: string): Promise<{id: string; ip: string} | null | 'unavailable'> {
  const listed = await runCleanupCommand(['compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'])
  if (listed.exitCode !== 0) return 'unavailable'
  for (const line of listed.stdout.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length >= 2 && parts[1] === name && /^[0-9]+$/.test(parts[0])) {
      return {id: parts[0], ip: parts[2] || ''}
    }
  }
  return null
}

export interface FailedDropletRelease {
  agentName: string
  dropletId?: string
  dropletIp?: string
  dropletName?: string
  /** Set when this attempt created a volume. A reused volume is left alone. */
  volumeName?: string
  deploymentUrl?: string
  tokenHash?: string
  volumeConfig?: string
  log?: (message: string) => void
}

export interface FailedDropletReleaseResult {
  dropletDeleted: boolean
  volumeDeleted: boolean
  hostKeyRemoved: boolean
  recorded: boolean
}

/**
 * After a droplet deploy fails, delete the droplet and any volume this
 * attempt created, and drop the known_hosts pin. If the droplet or volume
 * cannot be deleted, record the deployment so `cast shutdown` can finish
 * the cleanup. The shared account key `cast-do-key` is never deleted.
 */
export async function releaseFailedDroplet(input: FailedDropletRelease): Promise<FailedDropletReleaseResult> {
  const log = input.log ?? console.log
  const dropletName = input.dropletName || `cast-${input.agentName}`
  let dropletId = input.dropletId && /^[0-9]+$/.test(input.dropletId) ? input.dropletId : ''
  let dropletIp = input.dropletIp || ''
  let dropletDeleted = false
  if (!dropletId) {
    const found = await findNamedDroplet(dropletName)
    if (found === 'unavailable') {
      dropletDeleted = false
    } else if (found) {
      dropletId = found.id
      if (!dropletIp) dropletIp = found.ip
    } else {
      dropletDeleted = true
    }
  }
  if (dropletId) {
    const deleted = await runCleanupCommand(['compute', 'droplet', 'delete', dropletId, '--force'])
    dropletDeleted = deleted.exitCode === 0 || resourceAlreadyGone(deleted.stdout, deleted.stderr)
  }

  let volumeDeleted = true
  let volumeError = ''
  if (input.volumeName) {
    const region = digitalOceanVolumeRegion(input.volumeConfig)
    const listed = await readDigitalOceanVolumeList(args => runCleanupCommand(args))
    if (!listed.ok) {
      volumeDeleted = false
      volumeError = listed.error
    } else {
      const matches = findDigitalOceanVolumes(listed.volumes, input.volumeName, region)
      if (matches.length === 0) {
        volumeDeleted = true
      } else {
        for (const match of matches) {
          const deleted = await deleteDigitalOceanVolumeAfterDetach(
            args => runCleanupCommand(args),
            match,
            log,
          )
          if (!deleted.deleted) {
            volumeDeleted = false
            volumeError = deleted.error
            break
          }
        }
      }
    }
  }

  if (dropletDeleted && (dropletId || dropletIp)) {
    forgetDropletHostKey(dropletId, dropletIp || undefined)
  }

  const recorded = (!dropletDeleted || !volumeDeleted)
    ? recordFailedDroplet(input, {
      dropletName,
      dropletId,
      dropletIp,
      dropletDeleted,
      volumeDeleted,
      volumeError,
      log,
    })
    : false
  if (dropletDeleted && volumeDeleted && dropletId) {
    log(`Removed droplet '${dropletName}' after the deploy failed.`)
  }
  return {
    dropletDeleted,
    volumeDeleted,
    hostKeyRemoved: dropletDeleted && Boolean(dropletId || dropletIp),
    recorded,
  }
}

function recordFailedDroplet(
  input: FailedDropletRelease,
  state: {
    dropletName: string
    dropletId: string
    dropletIp: string
    dropletDeleted: boolean
    volumeDeleted: boolean
    volumeError: string
    log: (message: string) => void
  },
): boolean {
  let url = input.deploymentUrl
  if (!url && state.dropletIp) {
    try {
      url = dropletDeploymentUrl(state.dropletIp)
    } catch {
      url = undefined
    }
  }
  if (!url && state.dropletId) url = `https://${state.dropletId}.droplet.invalid`
  if (!url) url = `https://${state.dropletName}.droplet.invalid`
  saveDeployment(
    input.agentName,
    'digitalocean',
    url,
    input.tokenHash ?? '',
    input.volumeName,
    input.volumeConfig,
  )
  const leftover = !state.dropletDeleted
    ? `droplet '${state.dropletName}'`
    : `memory volume '${input.volumeName}'`
  const volumeDetail = !state.volumeDeleted
    ? state.volumeError.trim().replace(/[.\s]+$/, '')
    : ''
  const extra = volumeDetail ? ` ${volumeDetail}.` : ''
  state.log(`Could not delete ${leftover}.${extra} Recorded the deployment so cast shutdown ${input.agentName} can clean it up.`)
  return true
}

/**
 * Drop the bearer token written for a deploy that did not finish.
 * A live deployment keeps the agent token. The per-deployment file
 * for this attempt is always removed.
 */
export async function discardFailedDigitalOceanTokens(
  agentName: string,
  deploymentSha: string | undefined,
): Promise<void> {
  if (deploymentSha && isShaPattern(deploymentSha)) {
    await keychain.deleteDeploymentToken(deploymentSha)
  }
  if (db.listDeployments(agentName).length === 0) {
    await keychain.deleteToken(agentName)
  }
}

export default class DigitalOceanDeploy extends Command {
  static description = 'Deploy agent to DigitalOcean Droplet with Docker'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    'with-tui': Flags.boolean({
      description:
        'Bundle the on-host TUI (cast-tui command) into the image. ' +
        'Off by default to keep images small and streaming fast; ' +
        'pass --with-tui if you want SSH-in chat via `cast-tui`.',
      default: false,
    }),
    size: Flags.string({
      description:
        'Droplet size slug. Default: s-2vcpu-2gb (bumped from s-1vcpu-1gb ' +
        'to give `docker load` more CPU headroom). Only affects new droplets; ' +
        'existing droplets keep their original size.',
      default: 's-2vcpu-2gb',
    }),
  }

  static async destroy(agentName: string): Promise<void> {
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      throw new Error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_API_TOKEN, or DIGITALOCEAN_API_KEY environment variable, or add providers.digitalocean.token to ~/.cast/config.yaml')
    }

    // Check doctl
    try {
      await execCommand('doctl', ['account', 'get'], {silent: true})
    } catch {
      throw new Error('doctl is not installed or not authenticated. Install from https://docs.digitalocean.com/reference/doctl/how-to/install/')
    }

    const dropletName = `cast-${agentName}`

    // Find droplet by name
    const dropletsResult = await execCommand('doctl', ['compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'], {silent: true})
    const lines = dropletsResult.stdout.trim().split('\n')
    let dropletId = ''
    let dropletIp = ''

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 2 && parts[1] === dropletName) {
        dropletId = parts[0]
        dropletIp = parts[2] || ''
        break
      }
    }

    if (!dropletId) {
      console.log(`Droplet '${dropletName}' not found.`)
    } else {
      // Stop container first
      if (dropletIp) {
        try {
          await execSsh(dropletIp, 'docker stop cast-agent && docker rm cast-agent', true)
        } catch {
          // ignore
        }
      }

      // Delete droplet
      const deleteResult = await execCommand('doctl', ['compute', 'droplet', 'delete', dropletId, '--force'], {silent: true})
      if (deleteResult.exitCode !== 0) {
        throw new Error(`Failed to delete droplet: ${deleteResult.stderr}`)
      }
      console.log(`Droplet '${dropletName}' deleted.`)
      forgetDropletHostKey(dropletId, dropletIp)
    }

    // Delete the volume this deploy created, plus any older uuid volume still billing.
    const recorded = db.listDeployments(agentName)
      .filter((row: {provider?: string}) => row.provider === 'digitalocean')
      .map((row: {volume_id?: string | null; volume_config?: string | null}) => ({
        name: row.volume_id,
        region: digitalOceanVolumeRegion(row.volume_config),
      }))
    await removeDigitalOceanMemoryVolumes(agentName, recorded)
    await removeUnusedCastAccountSshKey(apiToken, dropletId)
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DigitalOceanDeploy)
    const agentName = args.agent as string
    const withTui = flags['with-tui'] as boolean
    const dropletSize = flags.size as string
    const agentPath = getAgentPath(agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    this.log(`Deploying ${agentName} to DigitalOcean Droplet...`)
    this.log(`On-host TUI: ${withTui ? 'enabled (--with-tui)' : 'disabled (use --with-tui to enable)'}`)
    this.log(`Droplet size: ${dropletSize}${dropletSize === 's-1vcpu-1gb' ? ' (note: smaller than the new default — docker load may time out)' : ''}`)

    // Check doctl
    try {
      await execCommand('doctl', ['account', 'get'], {silent: true})
    } catch {
      this.error('doctl is not installed or not authenticated. Install from https://docs.digitalocean.com/reference/doctl/how-to/install/')
    }

    // Check Docker locally
    try {
      await execCommand('docker', ['--version'], {silent: true})
    } catch {
      this.error('Docker is required for DigitalOcean deployment. Install from https://docs.docker.com/get-docker/')
    }

    await this.requireSshTools()

    // Get DO token before any bearer token is stored. A missing
    // prerequisite must not leave a token file behind.
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      this.error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_API_TOKEN, or DIGITALOCEAN_API_KEY environment variable, or add providers.digitalocean.token to ~/.cast/config.yaml')
    }

    // Resolve project root for locating cast runtime
    const projectRoot = this.findProjectRoot()
    prepareCastImageContext(agentPath, projectRoot)

    // Copy the cast runtime into the agent's .cast-runtime/ directory.
    // The image Dockerfile copies that tree to /app/cast.
    const castRuntimeDir = path.join(agentPath, '.cast-runtime', 'cast')
    fs.mkdirSync(path.dirname(castRuntimeDir), { recursive: true })
    const castRuntimeSrc = path.join(projectRoot, 'python', 'cast')
    if (!fs.existsSync(castRuntimeSrc)) {
      this.error(`Cast Python package not found at ${castRuntimeSrc}. Run cast deploy from a Cast Agent checkout so the image includes the runtime.`)
    }
    if (fs.existsSync(castRuntimeDir)) {
      fs.rmSync(castRuntimeDir, { recursive: true })
    }
    fs.cpSync(castRuntimeSrc, castRuntimeDir, { recursive: true })

    // Generate auth token and deployment ID. Later failures delete it.
    // The volume name is the agent name. A uuid is only kept when an older volume is still present.
    const deploymentSha = deploymentShaFromEnv()
    const deploymentId = generateDeploymentId()
    let authToken = ''
    let tokenHash = ''
    let createdDroplet: {id: string; name: string; ip: string; region: string} | undefined
    let createdVolumeName: string | undefined
    try {
      const generated = await generateAuthToken(agentName)
      authToken = generated.authToken
      tokenHash = generated.tokenHash
      const memoryPlan = planDigitalOceanMemoryVolume(
        agentName,
        latestDigitalOceanVolumeId(agentName),
        await listDigitalOceanVolumeNames(defaultDoctlRunner()),
      )
      const volumeId = memoryPlan.volumeId

      // The account key must be this machine's ~/.ssh/cast_do_key.
      // A same-named key with a different fingerprint is replaced.
      await this.ensureSshKey()

      // Prepare on-host TUI bundle (cast-tui command inside the container).
      // Skipped entirely when --with-tui is not set, which keeps the image
      // ~100MB smaller and substantially reduces streaming time.
      if (withTui) {
        this.log('Preparing on-host TUI bundle...')
      }
      await prepareHostTuiBuildContext(agentPath, projectRoot, { enabled: withTui })

      // Get or create droplet
      const volumeConfigForCleanup = JSON.stringify({deploymentId, mountPath: '/app/agent/memory', region: DIGITALOCEAN_DROPLET_REGION})
      const droplet = await this.getOrCreateDroplet(agentName, agentPath, apiToken, dropletSize, {
        tokenHash,
        volumeConfig: volumeConfigForCleanup,
      })
      if (droplet.created) {
        createdDroplet = {id: droplet.id, name: droplet.name, ip: droplet.ip, region: droplet.region}
      }

      this.log(`Droplet IP: ${droplet.ip}`)
      this.log('Waiting for SSH to be available...')
      await this.waitForSsh(droplet.ip)

      // Cloud-init's runcmd (which installs Docker) runs asynchronously and
      // SSH comes up before that completes. If we try to `docker load` over
      // SSH right after `waitForSsh`, we'll hit "docker: command not found"
      // on fresh droplets. Poll for a working Docker daemon before
      // streaming the image.
      this.log('Waiting for Docker to be ready on droplet...')
      await this.waitForDocker(droplet.ip)

      // Build Docker image locally for AMD64 target (DO droplets are x86_64)
      const imageTag = `cast-${agentName}:latest`
      this.log('Building Docker image for linux/amd64...')
      const buildResult = await execCommand('docker', [
        'buildx', 'build',
        '--platform', 'linux/amd64',
        '--load',
        '-t', imageTag,
        '-f', path.join(agentPath, 'Dockerfile'),
        agentPath,
      ])
      if (buildResult.exitCode !== 0) {
        this.error(`Docker build failed: ${buildResult.stderr}`)
      }

      // Stream image directly to droplet (no intermediate disk write)
      this.log('Streaming Docker image to droplet...')
      await this.streamImageToDroplet(droplet.ip, imageTag)

      // Deploy on droplet. The recorded URL is the droplet address.
      // cast connect does not fetch it. It opens an SSH tunnel instead.
      this.log('Deploying on droplet...')
      const deploymentUrl = dropletDeploymentUrl(droplet.ip)

      // Look up the current agent release version so the SSH login MOTD
      // shows the semantic version (e.g. v1.2.3) instead of a placeholder.
      let deployedVersion: string | undefined
      try {
        const currentRelease = db.getCurrentRelease(agentName)
        if (currentRelease?.version) {
          deployedVersion = String(currentRelease.version)
        }
      } catch {
        // DB unavailable. MOTD will fall back to a placeholder.
      }

      await this.deployOnDroplet(droplet.ip, agentName, authToken, imageTag, volumeId, deploymentUrl, deployedVersion, withTui)

      if (memoryPlan.action === 'create') {
        this.log(`Creating memory volume: ${volumeId}`)
        if (droplet.created) createdVolumeName = volumeId
        const volumeResult = await this.createAndAttachVolume(apiToken, droplet.id, volumeId, droplet.region)
        if (volumeResult) {
          this.log(`Volume attached at ${volumeResult}`)
        }
      } else {
        this.log(`Reusing memory volume: ${volumeId}`)
      }

      // Save deployment
      const volumeConfig = JSON.stringify({ deploymentId, mountPath: '/app/agent/memory', region: droplet.region })
      saveDeployment(agentName, 'digitalocean', deploymentUrl, tokenHash, volumeId, volumeConfig)

      this.log('')
      this.log('╔══════════════════════════════════════════════════════════════╗')
      this.log('║         DigitalOcean Droplet Deployment Successful!          ║')
      this.log('╚══════════════════════════════════════════════════════════════╝')
      this.log('')
      this.log(`Agent: ${agentName}`)
      this.log(`URL: ${deploymentUrl}`)
      this.log(`Droplet: ${droplet.name}`)
      this.log(`Provider: digitalocean`)
      this.log('')
      this.log('The agent listens on 127.0.0.1:8080 inside the droplet.')
      this.log('Port 8080 is not open to the internet.')
      this.log('')
      this.log('To view logs:')
      this.log(`  ${sshLoginHint(droplet.ip, '"docker logs -f cast-agent"')}`)
      this.log('')
      this.log('To connect (from your machine):')
      this.log(`  cast connect ${agentName}`)
      this.log('cast connect opens an SSH tunnel. The bearer token stays inside SSH.')
      this.log('')
      if (withTui) {
        this.log('To chat on-host (SSH into droplet, then inside container):')
        this.log(`  ${sshLoginHint(droplet.ip)}`)
        this.log(`  docker exec -it cast-agent bash`)
        this.log(`  cast-tui`)
        this.log('')
      }
      this.log('To destroy:')
      this.log(`  cast shutdown ${agentName}`)
    } catch (error) {
      if (createdDroplet) {
        try {
          await releaseFailedDroplet({
            agentName,
            dropletId: createdDroplet.id,
            dropletIp: createdDroplet.ip,
            dropletName: createdDroplet.name,
            volumeName: createdVolumeName,
            deploymentUrl: dropletDeploymentUrl(createdDroplet.ip),
            tokenHash,
            volumeConfig: JSON.stringify({
              deploymentId,
              mountPath: '/app/agent/memory',
              region: createdDroplet.region,
            }),
            log: message => this.log(message),
          })
        } catch (cleanupError) {
          const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
          this.warn(`Failed to clean up droplet '${createdDroplet.name}': ${message}`)
        }
      }
      try {
        await discardFailedDigitalOceanTokens(agentName, deploymentSha)
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        this.warn(`Failed to remove the auth token from the failed deploy: ${message}`)
      }
      throw error
    }
  }

  private async requireSshTools(): Promise<void> {
    for (const check of DIGITALOCEAN_SSH_TOOL_CHECKS) {
      try {
        await checkCli(check.command, check.installUrl)
      } catch {
        this.error(check.error)
      }
    }
  }

  /**
   * Find the project root directory by looking for known marker paths.
   * Tries several relative paths from the current working directory and
   * the compiled output directory to locate the castagent project root.
   */
  private findProjectRoot(): string {
    const markers = ['python/cast', 'typescript/cast-tui']
    const candidates = [
      process.cwd(),
      // __dirname at runtime: typescript/cast-cli/dist/lib/deploy/
      path.resolve(__dirname, '..'),             // dist/lib
      path.resolve(__dirname, '../..'),           // dist
      path.resolve(__dirname, '../../..'),        // cast-cli
      path.resolve(__dirname, '../../../..'),     // typescript
      path.resolve(__dirname, '../../../../..'),  // project root
    ]
    for (const candidate of candidates) {
      for (const marker of markers) {
        if (fs.existsSync(path.join(candidate, marker))) {
          return candidate
        }
      }
    }
    return process.cwd()
  }

  private async ensureSshKey(): Promise<void> {
    const keyPath = sshLoginKeyPath()
    if (!fs.existsSync(keyPath)) {
      fs.mkdirSync(path.dirname(keyPath), {recursive: true, mode: 0o700})

      // ssh-keygen -N '' sets an empty passphrase without a shell.
      try {
        execFileSync('ssh-keygen', [
          '-t', 'ed25519',
          '-f', keyPath,
          '-N', '',
          '-C', 'cast@digitalocean',
        ], {
          encoding: 'utf8',
          stdio: 'pipe',
        })
      } catch (e: any) {
        const stderr = e?.stderr ? String(e.stderr) : ''
        throw new Error(`Failed to generate SSH key: ${stderr || e.message}`)
      }
    }

    // Upload when the account key is missing, including after shutdown
    // removed it and the local private key is still here. Replace a
    // cast-do-key whose fingerprint is not this file. Droplet create
    // sends that fingerprint, and DigitalOcean rejects one it does not have.
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      throw new Error('DigitalOcean API token not found')
    }

    const pubKey = fs.readFileSync(`${keyPath}.pub`, 'utf8').trim()
    const headers = {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    }

    let keys: AccountSshKey[] = []
    try {
      keys = await listAccountSshKeys(apiToken)
    } catch {
      // A failed list still tries the upload below.
    }

    const plan = loginKeySyncPlan(keys, sshPublicKeyMd5Fingerprint(pubKey))
    if (plan.deleteIds.length > 0) {
      this.log(`Replacing DigitalOcean SSH key '${SSH_KEY_NAME}' so it matches this machine.`)
    }
    for (const id of plan.deleteIds) {
      const keyId = assertAccountSshKeyId(id)
      try {
        await axios.delete(`https://api.digitalocean.com/v2/account/keys/${keyId}`, {headers})
      } catch (error) {
        throw new Error(`Failed to replace DigitalOcean SSH key '${SSH_KEY_NAME}': ${axiosErrorDetail(error)}`)
      }
    }
    if (!plan.upload) return

    await axios.post('https://api.digitalocean.com/v2/account/keys', {
      name: SSH_KEY_NAME,
      public_key: pubKey,
    }, {headers})
  }

  private async getOrCreateDroplet(
    agentName: string,
    agentPath: string,
    apiToken?: string,
    size: string = 's-2vcpu-2gb',
    rollback?: {tokenHash: string; volumeConfig: string},
  ): Promise<{id: string; name: string; ip: string; region: string; created: boolean}> {
    const dropletName = `cast-${agentName}`
    const region = DIGITALOCEAN_DROPLET_REGION

    // Check if droplet exists
    const listResult = await execCommand('doctl', ['compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'], {silent: true})
    const lines = listResult.stdout.trim().split('\n')

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3 && parts[1] === dropletName) {
        syncDropletAddress(parts[0], parts[2])
        assertPinnedHostKey(parts[2])
        return {id: parts[0], name: dropletName, ip: parts[2], region, created: false}
      }
    }

    // Create droplet with cloud-init
    this.log(`Creating droplet '${dropletName}'...`)

    // Get SSH key fingerprint (MD5 format required by DO API)
    const keyResult = await execCommand('ssh-keygen', ['-l', '-E', 'md5', '-f', `${sshLoginKeyPath()}.pub`], {silent: true})
    const fingerprint = keyResult.stdout.trim().split(/\s+/)[1].replace(/^MD5:/, '')

    // Write cloud-init to install Docker and seed a baseline MOTD.
    //
    // IMPORTANT: this cloud-init goes through DigitalOcean's user-data
    // pipeline, which is then validated by cloud-init's STRICT schema
    // validator. Anything that parses as YAML but doesn't match the
    // schema gets rejected with `SCHEMA_ERROR: part-001` and runcmd
    // silently never runs. We keep the cloud-config minimal:
    //   - ssh host key fields and write_files (no shell logic inside runcmd)
    //   - runcmd is a flat list of single-line strings
    //   - no comments between runcmd items (those have tripped the
    //     schema validator in past iterations)
    // The install script itself is written to disk by write_files and
    // invoked from runcmd — this also makes it inspectable in
    // /var/log/cast-docker-install.log after the fact.
    const cloudInitPath = path.join(agentPath, '.cloud-init.yml')
    const baselineMotd = buildCloudInitBaselineMotd()

    // Install Docker from the signed apt repository. The key file is
    // checked against the pin in install-checksums.txt before apt
    // trusts it. There is no unsigned installer fallback. The script
    // always exits 0 so cloud-init still reaches the sentinel below.
    const dockerKey = installPin('docker-apt-key', 'ubuntu')
    const installScript = [
      '#!/bin/bash',
      'set +e',
      'LOG=/var/log/cast-docker-install.log',
      'echo "[cast] docker install started at $(date -Iseconds)" > $LOG',
      'export DEBIAN_FRONTEND=noninteractive',
      'apt-get update >> $LOG 2>&1',
      'apt-get install -y ca-certificates curl >> $LOG 2>&1',
      'install -m 0755 -d /etc/apt/keyrings >> $LOG 2>&1',
      'key_ok=0',
      'if curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc >> $LOG 2>&1; then',
      `  echo "${dockerKey.sha256}  /etc/apt/keyrings/docker.asc" | sha256sum -c - >> $LOG 2>&1 && key_ok=1`,
      'fi',
      'if [ "$key_ok" -eq 1 ]; then',
      '  chmod a+r /etc/apt/keyrings/docker.asc >> $LOG 2>&1',
      '  ARCH=$(dpkg --print-architecture)',
      '  CODENAME=$(. /etc/os-release && echo $VERSION_CODENAME)',
      '  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" > /etc/apt/sources.list.d/docker.list',
      '  apt-get update >> $LOG 2>&1',
      '  apt-get install -y docker-ce docker-ce-cli containerd.io >> $LOG 2>&1',
      'else',
      '  echo "[cast] Docker apt key failed checksum or download. Refusing an unsigned installer." >> $LOG',
      '  rm -f /etc/apt/keyrings/docker.asc',
      'fi',
      'if command -v docker >/dev/null 2>&1; then',
      '  systemctl enable docker >> $LOG 2>&1',
      '  systemctl start docker >> $LOG 2>&1',
      '  echo "[cast] docker install finished: $(docker --version 2>&1)" >> $LOG',
      'else',
      '  echo "[cast] FAILED: docker not on PATH after install" >> $LOG',
      'fi',
      'exit 0',
      '',
    ].join('\n')

    const hostKey = generateEd25519HostKeyPair()
    const cloudInit = buildDropletCloudInit({
      privateKey: hostKey.privateKey,
      publicKey: hostKey.publicKey,
      baselineMotd,
      installScript,
    })
    fs.writeFileSync(cloudInitPath, cloudInit, {mode: 0o600})

    let createdId = ''
    let createdIp = ''
    try {
      const createResult = await execCommand('doctl', [
        'compute', 'droplet', 'create',
        dropletName,
        '--region', region,
        '--size', size,
        '--image', 'ubuntu-24-04-x64',
        '--ssh-keys', fingerprint,
        '--user-data-file', cloudInitPath,
        '--wait',
      ], {silent: true})

      if (createResult.exitCode !== 0) {
        throw new Error(digitalOceanCommandError('Failed to create droplet', createResult))
      }

      // Get IP, then pin the host key before any SSH session.
      const infoResult = await execCommand('doctl', ['compute', 'droplet', 'get', dropletName, '--format', 'ID,PublicIPv4', '--no-header'], {silent: true})
      const parts = infoResult.stdout.trim().split(/\s+/)
      createdId = parts[0] || ''
      createdIp = parts[1] || ''
      if (!createdId || !createdIp) {
        throw new Error('Droplet was created but doctl did not return an id and public IPv4 address')
      }
      recordPinnedHostKey(createdIp, hostKey.publicKey, createdId)
      return {id: createdId, name: dropletName, ip: createdIp, region, created: true}
    } catch (error) {
      try {
        await releaseFailedDroplet({
          agentName,
          dropletId: createdId || undefined,
          dropletIp: createdIp || undefined,
          dropletName,
          deploymentUrl: createdIp ? dropletDeploymentUrl(createdIp) : undefined,
          tokenHash: rollback?.tokenHash ?? '',
          volumeConfig: rollback?.volumeConfig,
          log: message => this.log(message),
        })
      } catch (cleanupError) {
        const message = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
        this.warn(`Failed to clean up droplet '${dropletName}': ${message}`)
      }
      throw error
    } finally {
      fs.rmSync(cloudInitPath, {force: true})
    }
  }

  private async waitForSsh(ip: string): Promise<void> {
    const maxAttempts = 30
    const delayMs = 5000
    assertPinnedHostKey(ip)

    for (let i = 0; i < maxAttempts; i++) {
      try {
        const result = await execSsh(ip, 'echo ok', true)
        if (result.exitCode === 0) {
          return
        }
      } catch (err) {
        if (err instanceof SshHostKeyError) throw err
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error('Timed out waiting for SSH on droplet')
  }

  /**
   * Wait until Docker is installed AND the daemon is responsive on the
   * droplet.
   *
   * Two signal sources are checked:
   *   1. Sentinel file at `/var/lib/cast/docker-ready`. New droplets
   *      write this in the LAST line of cloud-init's runcmd, so its
   *      presence means the install completed (successfully or not —
   *      see step 2 for the success check).
   *   2. `docker info`. Confirms the daemon is actually responsive.
   *      Required because `docker load` / `docker run` need the
   *      daemon, not just the CLI on PATH.
   *
   * For older droplets that pre-date the sentinel, the function falls
   * back to polling `docker info` directly, so it remains compatible.
   *
   * Background: cloud-init's `runcmd` runs asynchronously and the SSH
   * server comes up before it finishes. The very first deploy flow
   * only waited for SSH, so the first `docker load` over SSH would
   * fail with "bash: line 1: docker: command not found" (exit 127).
   */
  private async waitForDocker(ip: string): Promise<void> {
    const maxAttempts = 60    // 60 × 5s = 5 min between *attempts* (not wall-clock)
    const delayMs = 5000
    // 15s per-call SSH timeout — tight enough that a hung probe
    // can't make a single iteration last minutes. The cloud-init
    // install itself can run for several minutes, so the loop needs
    // many attempts; we just need each one to fail fast.
    const sshTimeoutMs = 15_000
    assertPinnedHostKey(ip)

    for (let i = 0; i < maxAttempts; i++) {
      // Heartbeat every ~30s so the user can see the loop is alive.
      // This is what the deploy log was missing before — without
      // it, a user can't tell "stuck" from "polling slowly".
      if (i > 0 && i % 6 === 0) {
        const elapsedSec = i * delayMs / 1000
        this.log(`  ...still waiting (${elapsedSec}s elapsed)`)
      }

      // Probe the sentinel written by cloud-init's last runcmd step.
      // If it exists, install is fully done and we just need to wait
      // for the daemon. If it doesn't, either install is still
      // running OR this is an older droplet without the sentinel —
      // either way, `docker info` is the source of truth.
      let sentinelExists = false
      try {
        const sentinel = await execSsh(ip, 'test -f /var/lib/cast/docker-ready', true, sshTimeoutMs)
        sentinelExists = sentinel.exitCode === 0
      } catch (err) {
        if (err instanceof SshHostKeyError) throw err
        // Transient SSH error or timeout, retry next iteration.
      }

      try {
        const info = await execSsh(ip, 'docker info >/dev/null 2>&1', true, sshTimeoutMs)
        if (info.exitCode === 0) {
          return
        }
        // Otherwise fall through and keep polling. If sentinelExists
        // is true the daemon is just slow to come up; if false, the
        // install is probably still in progress.
      } catch (err) {
        if (err instanceof SshHostKeyError) throw err
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    // Timed out — gather diagnostics from the droplet so the user has
    // something actionable in the error message. Use a longer
    // per-call timeout here so the diagnostic collection itself
    // doesn't time out on a sluggish SSH connection.
    const diagnostics = await this.collectDropletDiagnostics(ip)

    throw new Error(
      'Timed out waiting for Docker to become ready on droplet. ' +
      diagnostics +
      ' SSH in and run `journalctl -u cloud-init-main --no-pager` for full logs.',
    )
  }

  /**
   * Best-effort collection of cloud-init / docker state from the
   * droplet for inclusion in a timeout error message. Never throws.
   */
  private async collectDropletDiagnostics(ip: string): Promise<string> {
    const parts: string[] = []

    const probe = async (label: string, cmd: string): Promise<void> => {
      try {
        const r = await execSsh(ip, cmd, true)
        const out = (r.stdout || r.stderr || '').trim()
        if (out) {
          parts.push(`${label}: ${out.split('\n').slice(0, 5).join(' | ')}`)
        }
      } catch (err) {
        if (err instanceof SshHostKeyError) throw err
      }
    }

    await probe('cloud-init', 'cloud-init status 2>&1')
    await probe('sentinel', 'ls -la /var/lib/cast/docker-ready 2>&1')
    await probe('docker', 'docker info 2>&1 | head -20')

    return parts.length > 0 ? parts.join('; ') + '.' : ''
  }

  private async deployOnDroplet(
    ip: string,
    agentName: string,
    authToken: string,
    imageTag: string,
    volumeId: string,
    deploymentUrl: string,
    deployedVersion?: string,
    withTui: boolean = false,
  ): Promise<void> {
    // Image is already loaded via streamImageToDroplet; stop old container.
    // Stopping the old container also drops a previous public 8080 publish.
    await execSsh(ip, 'docker stop cast-agent && docker rm cast-agent', true)

    const inferred = inferenceEnv()
    const secrets = [authToken, ...Object.values(inferred)].filter(value => value.length > 0)

    // Drop a public allow rule left by an older deploy. Do not add one.
    assertCommandHasNoSecrets('ufw', DROPLET_CLOSE_PUBLIC_PORT, secrets)
    await execSsh(ip, DROPLET_CLOSE_PUBLIC_PORT, true)

    // CAST_MOTD is base64 so it can live in the env file. The banner
    // tells the operator to use cast connect or the on-host TUI.
    const recordedUrl = deploymentUrl.startsWith('https://') ? deploymentUrl : dropletDeploymentUrl(ip)
    const motdCtx: MotdContext = {
      agentName,
      dropletIp: ip,
      a2aUrl: recordedUrl,
      deployedVersion,
      onHostTui: withTui,
      privateSsh: true,
    }
    const hostMotd = buildHostMotd(motdCtx)
    const motdB64 = Buffer.from(hostMotd, 'utf8').toString('base64')

    // Secrets go to a mode 0600 file over stdin. They are not shell words.
    // The docker argv is single-quoted and only names the env file.
    const envFile = buildDropletEnvFile({
      CAST_AGENT_NAME: agentName,
      CAST_AGENT_PATH: '/app/agent',
      PYTHONPATH: '/app',
      ...inferred,
      AUTH_TOKEN: authToken,
      CAST_MOTD: motdB64,
    })
    assertCommandHasNoSecrets('env file install', DROPLET_ENV_INSTALL_COMMAND, secrets)
    const writeResult = await execSsh(ip, DROPLET_ENV_INSTALL_COMMAND, true, 30_000, envFile)
    if (writeResult.exitCode !== 0) {
      throw new Error(`Failed to write the agent env file on the droplet: ${writeResult.stderr}`)
    }

    const runCommand = remoteDockerRunCommand({volumeId, imageTag})
    assertDropletDockerRunIsPrivate(runCommand, secrets)
    const runResult = await execSsh(ip, runCommand, true)

    if (runResult.exitCode !== 0) {
      throw new Error(`Failed to start container on droplet: ${runResult.stderr}`)
    }

    this.log('Waiting for the container to become ready...')
    const health = await waitForContainerHealth(async () => {
      const probed = await execSsh(ip, dropletContainerProbeCommand(), true, 20_000)
      return parseDropletContainerProbe(probed.stdout, probed.stderr)
    }, {intervalMs: 2_000})
    if (!health.ok) {
      await execSsh(ip, DROPLET_STOP_CRASH_LOOP, true).catch(() => undefined)
      throw new Error(containerHealthFailureMessage('cast-agent', health))
    }

    // Write the host MOTD and login-shell snippet. This is independent
    // of the container — the files live on the host and are shown by
    // pam_motd (and sourced by login shells) on every subsequent SSH.
    const {motdStderr, profileStderr} = await writeHostMotdOverSsh(ip, motdCtx)
    if (motdStderr) {
      this.warn(`Failed to write /etc/motd on droplet: ${motdStderr}`)
    }
    if (profileStderr) {
      this.warn(`Failed to write /etc/profile.d/cast.sh on droplet: ${profileStderr}`)
    }

  }

  /**
   * Stream a Docker image directly to the droplet via SSH pipe,
   * avoiding any intermediate disk write on the local machine.
   *
   * Runs: docker save <imageTag> | gzip -6 | ssh <options> root@<ip> 'gunzip | docker load'
   *
   * The gzip wrapper is the key throughput win. `docker save` emits
   * an uncompressed tar, so a 400MB compressed image becomes a
   * ~1.2-1.5GB on-the-wire tar. Compressing in the middle:
   *   1. Shifts the CPU cost of decompression from the 1-vCPU
   *      droplet (s-1vcpu-1gb / s-2vcpu-2gb) to the build host
   *      (a multi-core Mac/Linux laptop), which is much faster.
   *   2. Cuts network payload to roughly ⅓ of the raw tar size.
   *   3. Reduces disk I/O on both ends (less to write to overlay2
   *      on the droplet, less to read from /var/lib/docker on
   *      the host).
   *
   * Safeguards (matching every other SSH call in this file):
   *   - SSH keepalive (`ServerAliveInterval=5`, `ServerAliveCountMax=1`)
   *     so a half-open TCP connection eventually exits instead of
   *     hanging the deploy forever.
   *   - Wall-clock timeout (default 15 min) that SIGKILLs all three
   *     children. Mirrors the pattern in `execCommand` in
   *     deploy-utils.ts.
   *   - `save.on('close')` / `gzip.on('close')` handlers: if either
   *     upstream child exits non-zero, error out immediately rather
   *     than waiting for `docker load` to time out waiting for bytes
   *     that will never come.
   *   - Pipe error handlers on every writable side so EPIPE is not
   *     silently swallowed.
   *   - Progress logging every ~10 MB of *compressed* bytes so
   *     future hangs are diagnosable from the deploy log alone
   *     (you can see "stuck at N MB after T minutes").
   *
   * @param ip - The droplet's public IPv4 address.
   * @param imageTag - The local Docker image tag to stream.
   * @param timeoutMs - Wall-clock timeout in ms (default 900_000 = 15 min).
   */
  private async streamImageToDroplet(
    ip: string,
    imageTag: string,
    timeoutMs = 900_000,
  ): Promise<void> {
    assertPinnedHostKey(ip)
    return new Promise<void>((resolve, reject) => {
      // Reuse the shared SSH base options so the streaming SSH gets
      // ServerAliveInterval / ServerAliveCountMax / ConnectTimeout / etc.
      // exactly like every other SSH call in this file. Without
      // keepalive, a half-open TCP connection (e.g. NAT timeout, droplet
      // suspend) would make this hang indefinitely, which is the bug
      // that motivated this rewrite.
      // Host key checking stays enabled against the Cast known_hosts file.
      //
      // The remote command is `gunzip | docker load` so the
      // receiving end (the droplet's docker daemon) doesn't have to
      // decompress layers — that's gzip's job, which now runs on
      // the build host. `gunzip` is provided by the `gzip` package,
      // which is a hard dep of `apt` on Ubuntu and present in the
      // base image.
      const sshArgs = [...digitalOceanSshBaseOptions(), `root@${ip}`, 'gunzip | docker load']

      const save = spawn('docker', ['save', imageTag], {
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      // `-6` is a good speed/ratio balance for layer content
      // (mostly already-compressible JSON and binary blobs).
      const gzip = spawn('gzip', ['-6', '-c'], {
        stdio: ['pipe', 'pipe', 'inherit'],
      })
      const load = spawn('ssh', sshArgs, {
        stdio: ['pipe', 'inherit', 'inherit'],
      })

      save.stdout.pipe(gzip.stdin)
      gzip.stdout.pipe(load.stdin)

      let done = false
      let timeoutHandle: NodeJS.Timeout | undefined

      const finish = (err?: Error) => {
        if (done) return
        done = true
        if (timeoutHandle) clearTimeout(timeoutHandle)
        // SIGKILL is the only reliable way to stop children that are
        // blocked on I/O (a stuck `ssh` won't respond to SIGTERM).
        // Wrap in try/catch — the process may have exited between
        // the timeout firing and the kill() call.
        try { save.kill('SIGKILL') } catch { /* may already be dead */ }
        try { gzip.kill('SIGKILL') } catch { /* may already be dead */ }
        try { load.kill('SIGKILL') } catch { /* may already be dead */ }
        if (err) reject(err)
        else resolve()
      }

      // Hard wall-clock timeout. Bumped from 10 to 15 min to give
      // first-deploy headroom (the first deploy is the slowest since
      // the droplet's overlay2 cache is cold). With gzip in place,
      // typical deploys finish in 1-2 min.
      timeoutHandle = setTimeout(() => {
        finish(new Error(`Image streaming timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      // EPIPE on any writable side must not be silently swallowed.
      // `docker load` dying mid-stream → EPIPE on load.stdin
      // `gzip` dying mid-stream → EPIPE on gzip.stdin
      // The close handlers will report the real exit codes.
      load.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          finish(err)
        }
      })
      gzip.stdin.on('error', (err) => {
        if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
          finish(err)
        }
      })
      save.stdout.on('error', (err) => finish(err))
      gzip.stdout.on('error', (err) => finish(err))

      // Progress logging — every ~10 MB of *compressed* bytes, log
      // how much has been streamed to the droplet. Reading from
      // gzip.stdout (not save.stdout) gives us the network-visible
      // throughput, which is what we care about for hang diagnosis
      // (not the uncompressed docker-save rate).
      let bytes = 0
      let lastLoggedMb = 0
      gzip.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        const mb = Math.floor(bytes / (10 * 1024 * 1024))
        if (mb > lastLoggedMb) {
          lastLoggedMb = mb
          this.log(`Streamed ${mb * 10} MB (compressed) to droplet...`)
        }
      })

      // Track exit codes from all three children. We need all three
      // to close before we can declare success — but if any fails,
      // we should error out as soon as we know.
      let saveCode: number | null = null
      let gzipCode: number | null = null
      let loadCode: number | null = null

      const tryFinishFromCodes = (): void => {
        if (saveCode === null || gzipCode === null || loadCode === null) return
        if (saveCode === 0 && gzipCode === 0 && loadCode === 0) {
          finish()
        } else {
          finish(new Error(
            `Image streaming failed: docker save exited ${saveCode}, ` +
            `gzip exited ${gzipCode}, docker load (ssh) exited ${loadCode}`,
          ))
        }
      }

      // `docker save` exiting early is a failure mode the original
      // code missed: if save dies but load is still running, we'd
      // wait for load's close event with no way to know save had
      // failed.
      save.on('close', (code) => {
        saveCode = code ?? 0
        // If save died non-zero, error out immediately — don't wait
        // for load, which may be blocked on a read for bytes that
        // will never arrive.
        if (saveCode !== 0) {
          finish(new Error(`docker save exited with code ${saveCode}`))
          return
        }
        // Save exited cleanly — end gzip.stdin so gzip gets EOF and
        // can flush its final compressed bytes to load.
        if (gzip.exitCode === null && gzip.killed === false) {
          try { gzip.stdin.end() } catch { /* ignore */ }
        }
        tryFinishFromCodes()
      })

      // gzip exiting: if it dies (e.g. SIGPIPE because load closed
      // early), the pipeline is broken. Treat non-zero as fatal.
      gzip.on('close', (code) => {
        gzipCode = code ?? 0
        if (gzipCode !== 0) {
          finish(new Error(`gzip exited with code ${gzipCode}`))
          return
        }
        // gzip exited cleanly — end load.stdin so load gets EOF
        // and can finish consuming whatever's already in the pipe.
        if (load.exitCode === null && load.killed === false) {
          try { load.stdin.end() } catch { /* ignore */ }
        }
        tryFinishFromCodes()
      })

      load.on('close', (code) => {
        loadCode = code ?? 0
        // Symmetric: if load dies first, unpipe save.stdout so save
        // and gzip can exit cleanly instead of getting EPIPE.
        if (save.exitCode === null && save.killed === false) {
          try { save.stdout.unpipe(gzip.stdin) } catch { /* ignore */ }
        }
        tryFinishFromCodes()
      })

      save.on('error', (err) => {
        // If save fails before it's written any data, gzip and load
        // will be waiting for input that never arrives. Make sure
        // they get EOF on stdin so they don't hang on a read.
        try { gzip.stdin.end() } catch { /* ignore */ }
        try { load.stdin.end() } catch { /* ignore */ }
        finish(err)
      })
      gzip.on('error', (err) => {
        try { load.stdin.end() } catch { /* ignore */ }
        finish(err)
      })
      load.on('error', (err) => finish(err))
    })
  }

  private async createAndAttachVolume(apiToken: string, dropletId: string, volumeName: string, region: string): Promise<string | null> {
    try {
      // Create volume
      const createResult = await axios.post('https://api.digitalocean.com/v2/volumes', {
        name: volumeName,
        size_gigabytes: 1,
        region: region,
      }, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      })

      const volumeId = createResult.data.volume.id

      // Attach volume to droplet
      await axios.post(`https://api.digitalocean.com/v2/volumes/${volumeId}/actions`, {
        type: 'attach',
        droplet_id: parseInt(dropletId, 10),
      }, {
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
      })

      // Format and mount volume on droplet
      const mountPath = `/mnt/${volumeName}`
      return mountPath
    } catch (error: any) {
      if (error.response?.data?.id === 'invalid') {
        // Volume might already exist
        return `/mnt/${volumeName}`
      }
      this.warn(`Failed to create volume: ${error.message}`)
      return null
    }
  }

}
