import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execCommand} from './deploy-utils'

/**
 * DigitalOcean does not return a droplet SSH host key from its API.
 * Cast generates the key, installs it with cloud-init user-data (sent
 * over the authenticated API), and records only the public key here.
 * Every later SSH session requires that pin.
 */
const ED25519_PUBLIC = /^ssh-ed25519 [A-Za-z0-9+/]{68}$/
const OPENSSH_PRIVATE = /^-----BEGIN OPENSSH PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]+\n)+-----END OPENSSH PRIVATE KEY-----\n?$/

export class SshHostKeyError extends Error {
  readonly kind: 'unpinned' | 'mismatch'

  constructor(kind: 'unpinned' | 'mismatch', message: string) {
    super(message)
    this.name = 'SshHostKeyError'
    this.kind = kind
  }
}

interface DropletHostKeyRecord {
  ip: string
  publicKey: string
}

interface HostKeyStore {
  droplets: Record<string, DropletHostKeyRecord>
}

export function castSshDir(): string {
  const override = process.env.CAST_SSH_DIR
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error('CAST_SSH_DIR must be an absolute path')
    }
    return override
  }
  return path.join(os.homedir(), '.cast', 'ssh')
}

export function castKnownHostsPath(): string {
  return path.join(castSshDir(), 'known_hosts')
}

export function castDoKeyPath(): string {
  return path.join(os.homedir(), '.ssh', 'cast_do_key')
}

export function normalizeEd25519PublicKey(publicKey: string): string {
  const parts = publicKey.trim().split(/\s+/)
  if (parts.length < 2) {
    throw new Error('SSH host key must be a single ssh-ed25519 public key')
  }
  const normalized = `${parts[0]} ${parts[1]}`
  if (!ED25519_PUBLIC.test(normalized)) {
    throw new Error('SSH host key must be a single ssh-ed25519 public key')
  }
  return normalized
}

export function assertOpenSshEd25519PrivateKey(privateKey: string): void {
  if (!OPENSSH_PRIVATE.test(privateKey)) {
    throw new Error('Refusing to embed an unexpected SSH host private key')
  }
}

export function isIpv4Address(ip: string): boolean {
  if (typeof ip !== 'string' || ip.length > 15) return false
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

function assertIpv4(ip: string): string {
  if (!isIpv4Address(ip)) {
    throw new Error('Refusing SSH host key record for a non-IPv4 address')
  }
  return ip
}

function storePath(): string {
  return path.join(castSshDir(), 'droplet-hostkeys.json')
}

function ensureSshDir(): void {
  const dir = castSshDir()
  fs.mkdirSync(dir, {recursive: true, mode: 0o700})
  fs.chmodSync(dir, 0o700)
}

function writePrivateFile(filePath: string, content: string): void {
  ensureSshDir()
  const tmp = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, content, {mode: 0o600})
  fs.renameSync(tmp, filePath)
  fs.chmodSync(filePath, 0o600)
}

function readStore(): HostKeyStore {
  const file = storePath()
  if (!fs.existsSync(file)) return {droplets: {}}
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    throw new Error(`Invalid droplet host key store: ${file}`)
  }
  if (!parsed || typeof parsed !== 'object' || !('droplets' in parsed)) {
    throw new Error(`Invalid droplet host key store: ${file}`)
  }
  const droplets = (parsed as {droplets?: unknown}).droplets
  if (!droplets || typeof droplets !== 'object' || Array.isArray(droplets)) {
    throw new Error(`Invalid droplet host key store: ${file}`)
  }
  return {droplets: droplets as Record<string, DropletHostKeyRecord>}
}

function writeStore(store: HostKeyStore): void {
  writePrivateFile(storePath(), JSON.stringify(store))
}

function readKnownHostLines(): string[] {
  const file = castKnownHostsPath()
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '')
}

function lineMatchesHost(line: string, ip: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return false
  const hostField = trimmed.split(/\s+/)[0]
  if (!hostField || hostField.startsWith('|') || hostField.startsWith('@')) return false
  return hostField.split(',').some((host) => host === ip || host === `[${ip}]:22`)
}

function writeKnownHosts(lines: string[]): void {
  const body = lines.filter((line) => line.trim() !== '')
  const file = castKnownHostsPath()
  if (body.length === 0) {
    if (fs.existsSync(file)) fs.rmSync(file)
    return
  }
  writePrivateFile(file, `${body.join('\n')}\n`)
}

function ipStillUsed(store: HostKeyStore, ip: string): boolean {
  return Object.values(store.droplets).some((rec) => rec && rec.ip === ip)
}

export function pinnedPublicKey(ip: string): string | null {
  if (!isIpv4Address(ip)) return null
  for (const line of readKnownHostLines()) {
    if (!lineMatchesHost(line, ip)) continue
    const parts = line.trim().split(/\s+/)
    if (parts.length < 3) continue
    const candidate = `${parts[1]} ${parts[2]}`
    if (ED25519_PUBLIC.test(candidate)) return candidate
  }
  return null
}

export function hasPinnedHostKey(ip: string): boolean {
  return pinnedPublicKey(ip) !== null
}

export function recordPinnedHostKey(ip: string, publicKey: string, dropletId?: string): void {
  const safeIp = assertIpv4(ip)
  const safeKey = normalizeEd25519PublicKey(publicKey)
  const store = readStore()
  const safeId = dropletId && /^[0-9]+$/.test(dropletId) ? dropletId : undefined
  const previousIp = safeId ? store.droplets[safeId]?.ip : undefined
  if (safeId) {
    store.droplets[safeId] = {ip: safeIp, publicKey: safeKey}
  }
  for (const [id, rec] of Object.entries(store.droplets)) {
    if (rec && rec.ip === safeIp && id !== safeId) {
      delete store.droplets[id]
    }
  }
  writeStore(store)

  let lines = readKnownHostLines().filter((line) => !lineMatchesHost(line, safeIp))
  if (previousIp && previousIp !== safeIp && !ipStillUsed(store, previousIp)) {
    lines = lines.filter((line) => !lineMatchesHost(line, previousIp))
  }
  lines.push(`${safeIp} ${safeKey}`)
  writeKnownHosts(lines)
}

export function syncDropletAddress(dropletId: string, ip: string): void {
  if (!/^[0-9]+$/.test(dropletId)) return
  const safeIp = assertIpv4(ip)
  const rec = readStore().droplets[dropletId]
  if (!rec || !ED25519_PUBLIC.test(rec.publicKey)) return
  if (rec.ip !== safeIp || pinnedPublicKey(safeIp) !== rec.publicKey) {
    recordPinnedHostKey(safeIp, rec.publicKey, dropletId)
  }
}

export function forgetDropletHostKey(dropletId: string, ip?: string): void {
  const store = readStore()
  const safeId = /^[0-9]+$/.test(dropletId) ? dropletId : ''
  const recordedIp = safeId ? store.droplets[safeId]?.ip : undefined
  if (safeId && store.droplets[safeId]) {
    delete store.droplets[safeId]
    writeStore(store)
  }
  const candidates = new Set<string>()
  for (const candidate of [recordedIp, ip]) {
    if (candidate && isIpv4Address(candidate)) candidates.add(candidate)
  }
  if (candidates.size === 0) return
  let lines = readKnownHostLines()
  let changed = false
  for (const candidate of candidates) {
    if (ipStillUsed(store, candidate)) continue
    const next = lines.filter((line) => !lineMatchesHost(line, candidate))
    if (next.length !== lines.length) {
      lines = next
      changed = true
    }
  }
  if (changed) writeKnownHosts(lines)
}

export function assertPinnedHostKey(ip: string): void {
  assertIpv4(ip)
  if (!hasPinnedHostKey(ip)) {
    throw new SshHostKeyError(
      'unpinned',
      `Refusing to connect to ${ip} because no pinned SSH host key is stored in ${castKnownHostsPath()}. ` +
      'Cast will not disable host key checking. Recreate the droplet, or add a line you verified from the DigitalOcean console.',
    )
  }
}

export function digitalOceanHostKeyOptions(): string[] {
  return [
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${castKnownHostsPath()}`,
    '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', 'UpdateHostKeys=no',
    '-o', 'HostKeyAlgorithms=ssh-ed25519',
  ]
}

export function digitalOceanSshBaseOptions(): string[] {
  return [
    '-i', castDoKeyPath(),
    ...digitalOceanHostKeyOptions(),
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=5',
    '-o', 'ServerAliveCountMax=1',
    '-o', 'LogLevel=ERROR',
  ]
}

export function generateEd25519HostKeyPair(): {privateKey: string; publicKey: string} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-hostkey-'))
  const keyPath = path.join(dir, 'ssh_host_ed25519_key')
  try {
    execFileSync('ssh-keygen', [
      '-q', '-t', 'ed25519', '-N', '', '-f', keyPath, '-C', 'cast-droplet-host',
    ], {stdio: 'pipe'})
    const privateKey = fs.readFileSync(keyPath, 'utf8')
    assertOpenSshEd25519PrivateKey(privateKey)
    const publicKey = normalizeEd25519PublicKey(fs.readFileSync(`${keyPath}.pub`, 'utf8'))
    return {privateKey, publicKey}
  } catch (err) {
    if (err instanceof Error && (
      err.message === 'Refusing to embed an unexpected SSH host private key' ||
      err.message === 'SSH host key must be a single ssh-ed25519 public key'
    )) {
      throw err
    }
    throw new Error('Failed to generate a droplet SSH host key')
  } finally {
    fs.rmSync(dir, {recursive: true, force: true})
  }
}

function hostKeyRejected(text: string): boolean {
  return /Host key verification failed/i.test(text)
    || /REMOTE HOST IDENTIFICATION HAS CHANGED/.test(text)
    || /you have requested strict checking/i.test(text)
}

export async function execDigitalOceanSsh(
  ip: string,
  remoteCmd: string,
  options?: {silent?: boolean; timeoutMs?: number},
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  assertPinnedHostKey(ip)
  const result = await execCommand(
    'ssh',
    [...digitalOceanSshBaseOptions(), `root@${ip}`, remoteCmd],
    {
      silent: options?.silent ?? true,
      shell: false,
      timeoutMs: options?.timeoutMs,
    },
  )
  if (result.exitCode !== 0 && hostKeyRejected(`${result.stdout}\n${result.stderr}`)) {
    throw new SshHostKeyError(
      'mismatch',
      `SSH host key verification failed for ${ip}. The server key does not match ${castKnownHostsPath()}. Cast closed the connection.`,
    )
  }
  return result
}
