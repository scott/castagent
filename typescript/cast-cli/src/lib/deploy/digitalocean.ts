import {Args, Command, Flags} from '@oclif/core'
import {execSync, spawn, type ChildProcess} from 'child_process'
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
} from './deploy-utils'
import {containerHealthFailureMessage, waitForContainerHealth, type ContainerProbe} from './container-health'
import {buildCloudInitBaselineMotd, buildHostMotd, writeHostMotdOverSsh} from './motd'
import type {MotdContext} from './motd'
import {shellSingleQuote} from './sprites-service'
import {db} from '../sqlite'
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

const SSH_KEY_NAME = 'cast-do-key'
const SSH_KEY_PATH = castDoKeyPath()

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

export interface DoctlCommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export function digitalOceanVolumeRemovalMessage(volumeId: string, result: DoctlCommandResult): string | null {
  if (result.exitCode === 0) return `Memory volume '${volumeId}' has been removed.`
  const detail = `${result.stderr}\n${result.stdout}`
  if (/not found/i.test(detail) || /\b404\b/.test(detail)) return null
  return `Note: Memory volume '${volumeId}' could not be removed.`
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

export async function removeDigitalOceanMemoryVolumes(
  agentName: string,
  recordedVolumeIds: Array<string | null | undefined>,
  run: DoctlRunner = defaultDoctlRunner(),
  log: (message: string) => void = console.log,
): Promise<void> {
  const listed = await listDigitalOceanVolumeNames(run)
  const volumes = digitalOceanMemoryVolumesToRemove(agentName, recordedVolumeIds, listed)
  for (const volumeId of volumes) {
    let result: DoctlCommandResult
    try {
      result = await run(['compute', 'volume', 'delete', volumeId, '--force'])
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log(`Note: Memory volume '${volumeId}' could not be removed (${message}).`)
      continue
    }
    const line = digitalOceanVolumeRemovalMessage(volumeId, result)
    if (line) log(line)
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
      .map((row: {volume_id?: string | null}) => row.volume_id)
    await removeDigitalOceanMemoryVolumes(agentName, recorded)
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

    // Generate auth token and deployment ID.
    // The volume name is the agent name. A uuid is only kept when an older volume is still present.
    const { authToken, tokenHash } = await generateAuthToken(agentName)
    const deploymentId = generateDeploymentId()
    const memoryPlan = planDigitalOceanMemoryVolume(
      agentName,
      latestDigitalOceanVolumeId(agentName),
      await listDigitalOceanVolumeNames(defaultDoctlRunner()),
    )
    const volumeId = memoryPlan.volumeId

    // Get DO token
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      this.error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_API_TOKEN, or DIGITALOCEAN_API_KEY environment variable, or add providers.digitalocean.token to ~/.cast/config.yaml')
    }

    // Setup SSH key
    await this.ensureSshKey()

    // Prepare on-host TUI bundle (cast-tui command inside the container).
    // Skipped entirely when --with-tui is not set, which keeps the image
    // ~100MB smaller and substantially reduces streaming time.
    if (withTui) {
      this.log('Preparing on-host TUI bundle...')
    }
    await prepareHostTuiBuildContext(agentPath, projectRoot, { enabled: withTui })

    // Get or create droplet
    const droplet = await this.getOrCreateDroplet(agentName, agentPath, apiToken, dropletSize)

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
      // DB unavailable — MOTD will fall back to a placeholder
    }

    await this.deployOnDroplet(droplet.ip, agentName, authToken, imageTag, volumeId, deploymentUrl, deployedVersion, withTui)

    if (memoryPlan.action === 'create') {
      this.log(`Creating memory volume: ${volumeId}`)
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
    if (fs.existsSync(SSH_KEY_PATH)) {
      return
    }

    fs.mkdirSync(path.dirname(SSH_KEY_PATH), {recursive: true, mode: 0o700})

    // Generate SSH key (use execSync directly to handle empty passphrase properly)
    try {
      execSync(`ssh-keygen -t ed25519 -f "${SSH_KEY_PATH}" -N "" -C "cast@digitalocean"`, {
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (e: any) {
      throw new Error(`Failed to generate SSH key: ${e.stderr || e.message}`)
    }

    // Upload to DigitalOcean
    const apiToken = getProviderToken('digitalocean', ['DIGITALOCEAN_ACCESS_TOKEN', 'DIGITALOCEAN_API_TOKEN', 'DIGITALOCEAN_API_KEY'])
    if (!apiToken) {
      throw new Error('DigitalOcean API token not found')
    }

    const pubKeyPath = `${SSH_KEY_PATH}.pub`
    const pubKey = fs.readFileSync(pubKeyPath, 'utf8').trim()

    // Check if key already exists
    try {
      const keysResult = await axios.get('https://api.digitalocean.com/v2/account/keys', {
        headers: {Authorization: `Bearer ${apiToken}`},
      })
      const existingKey = keysResult.data.ssh_keys?.find((k: any) => k.name === SSH_KEY_NAME)
      if (existingKey) {
        return
      }
    } catch {
      // ignore, will try to create
    }

    await axios.post('https://api.digitalocean.com/v2/account/keys', {
      name: SSH_KEY_NAME,
      public_key: pubKey,
    }, {
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    })
  }

  private async getOrCreateDroplet(agentName: string, agentPath: string, apiToken?: string, size: string = 's-2vcpu-2gb'): Promise<{id: string; name: string; ip: string; region: string}> {
    const dropletName = `cast-${agentName}`
    const region = 'nyc3'

    // Check if droplet exists
    const listResult = await execCommand('doctl', ['compute', 'droplet', 'list', '--format', 'ID,Name,PublicIPv4', '--no-header'], {silent: true})
    const lines = listResult.stdout.trim().split('\n')

    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      if (parts.length >= 3 && parts[1] === dropletName) {
        syncDropletAddress(parts[0], parts[2])
        assertPinnedHostKey(parts[2])
        return {id: parts[0], name: dropletName, ip: parts[2], region}
      }
    }

    // Create droplet with cloud-init
    this.log(`Creating droplet '${dropletName}'...`)

    // Get SSH key fingerprint (MD5 format required by DO API)
    const keyResult = await execCommand('ssh-keygen', ['-l', '-E', 'md5', '-f', `${SSH_KEY_PATH}.pub`], {silent: true})
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
        throw new Error(`Failed to create droplet: ${createResult.stderr}`)
      }

      // Get IP, then pin the host key before any SSH session.
      const infoResult = await execCommand('doctl', ['compute', 'droplet', 'get', dropletName, '--format', 'ID,PublicIPv4', '--no-header'], {silent: true})
      const parts = infoResult.stdout.trim().split(/\s+/)
      const dropletId = parts[0]
      const ip = parts[1]
      if (!dropletId || !ip) {
        throw new Error('Droplet was created but doctl did not return an id and public IPv4 address')
      }
      recordPinnedHostKey(ip, hostKey.publicKey, dropletId)
      return {id: dropletId, name: dropletName, ip, region}
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
