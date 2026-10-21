import {Args, Command, Flags} from '@oclif/core'
import axios from 'axios'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {keychain} from '../keychain'
import {db} from '../sqlite'
import {
  assertSecretsNotInArgv,
  deploymentShaFromEnv,
  execCommand,
  generateAuthToken,
  generateDeploymentId,
  getAgentPath,
  inferenceEnv,
  filterInferenceEnv,
  readAgentModel,
  isShaPattern,
  prepareCastImageContext,
  prepareHostTuiBuildContext,
  appendCompilerHint,
  resolveDeploymentAuthToken,
  resolveDigitalOceanToken,
  saveDeployment,
} from './deploy-utils'
import {ollamaDeployRefusal} from './ollama'

const MIN_DOCTL: [number, number, number] = [1, 173, 0]
const REGION = 'mkc1'
const POLL_ATTEMPTS = 60
const POLL_DELAY_MS = 5000
const PROBE_ATTEMPTS = 6
const PROBE_DELAY_MS = 5000

export const MEMORY_EXPORT_LIMIT = 8 * 1024 * 1024
export const MEMORY_CHUNK_CHARS = 48000

export const MICROVM_SIZES = [
  {cpu: 1, memory: 2048},
  {cpu: 2, memory: 4096},
  {cpu: 8, memory: 16384},
  {cpu: 16, memory: 32768},
] as const

export interface MicrovmSize {
  cpu: number
  memory: number
}

export interface MicrovmRecord {
  id: string
  name?: string
  state?: string
  failureReason?: string
  endpoint?: string
  endpointStatus?: string
  region?: string
}

export interface MicrovmVolumeConfig {
  microvmId: string
  region: string
  ociRef: string
  authMode: 'dual' | 'edge-only'
  cpu: number
  memory: number
  idleTimeout: string
}

const SCOPE_HINT = 'A custom-scoped token needs microvm:create, microvm:read, microvm:update, microvm:delete, microvm:access, registry read/write, and registry:delete. A full-access token works.'

export function parseDoctlVersion(text: string): [number, number, number] | null {
  const match = text.match(/(\d+)\.(\d+)\.(\d+)/)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function doctlVersionAtLeast(text: string, min: [number, number, number] = MIN_DOCTL): boolean {
  const version = parseDoctlVersion(text)
  if (!version) return false
  for (let i = 0; i < 3; i++) {
    if (version[i] > min[i]) return true
    if (version[i] < min[i]) return false
  }
  return true
}

export function sanitizeMicrovmName(agentName: string, sha: string): string {
  const agentSlug = agentSlugOrThrow(agentName)
  return sanitizeName(`cast-${agentSlug}-${sha}`, agentName)
}

export function sanitizeRepoName(agentName: string): string {
  const agentSlug = agentSlugOrThrow(agentName)
  return sanitizeName(`cast-${agentSlug}`, agentName)
}

/** Repository Cast creates for this agent by pushing `cast-<agent>`. */
export function castAgentRepositoryName(agentName: string): string | undefined {
  try {
    return sanitizeRepoName(agentName)
  } catch {
    return undefined
  }
}

/** True only for the repository name Cast itself would create for this agent. */
export function isCastAgentRepository(agentName: string, repository: string): boolean {
  const expected = castAgentRepositoryName(agentName)
  return expected !== undefined && repository === expected
}

function agentSlugOrThrow(agentName: string): string {
  const slug = agentName.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (!slug) throw new Error(`Cannot build a MicroVM name from agent '${agentName}'.`)
  return slug
}

function sanitizeName(raw: string, agentName: string): string {
  let name = raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '')
  if (name.length > 63) name = name.slice(0, 63).replace(/-+$/g, '')
  if (!name || !/[a-z0-9]/.test(name)) {
    throw new Error(`Cannot build a MicroVM name from agent '${agentName}'.`)
  }
  return name
}

export function parseSize(input?: string): MicrovmSize {
  if (!input || input.trim() === '' || input.trim() === '1:2048') {
    return {cpu: 1, memory: 2048}
  }
  const match = /^(\d+):(\d+)$/.exec(input.trim())
  if (!match) {
    throw new Error(`Unknown MicroVM size '${input}'. Choose one of: 1:2048, 2:4096, 8:16384, 16:32768.`)
  }
  const cpu = Number(match[1])
  const memory = Number(match[2])
  const known = MICROVM_SIZES.some(size => size.cpu === cpu && size.memory === memory)
  if (!known) {
    throw new Error(`Unknown MicroVM size '${input}'. Choose one of: 1:2048, 2:4096, 8:16384, 16:32768.`)
  }
  return {cpu, memory}
}

export function parseIdleTimeout(input?: string): string {
  const raw = (input || '15m').trim()
  const match = /^(\d+)(s|m|h)$/.exec(raw)
  if (!match) {
    throw new Error(`Invalid idle timeout '${raw}'. Use a value like 30s, 15m, or 1h (maximum 4h).`)
  }
  const amount = Number(match[1])
  const unit = match[2]
  const seconds = unit === 's' ? amount : unit === 'm' ? amount * 60 : amount * 3600
  if (amount <= 0 || seconds > 4 * 60 * 60) {
    throw new Error(`Idle timeout '${raw}' is out of range. Maximum is 4h.`)
  }
  return raw
}

export function deploymentEnv(opts: {
  agentName: string
  authToken?: string
  inference?: Record<string, string>
  edgeAuthOnly: boolean
}): Record<string, string> {
  const env: Record<string, string> = {
    CAST_AGENT_NAME: opts.agentName,
    CAST_AGENT_PATH: '/app/agent',
    PYTHONPATH: '/app',
  }
  if (!opts.edgeAuthOnly && opts.authToken) {
    env.AUTH_TOKEN = opts.authToken
  }
  if (opts.inference) {
    Object.assign(env, opts.inference)
  }
  return env
}

export const MICROVM_CREATE_URL = 'https://api.digitalocean.com/v2/microvms'
const REGISTRY_SUBSCRIPTION_URL = 'https://api.digitalocean.com/v2/registry/subscription'
const MICROVM_LIST_URL = 'https://api.digitalocean.com/v2/microvms?per_page=200'

/**
 * Create body for POST /v2/microvms. Environment values travel in this
 * JSON body. doctl --env would place them on the local process argv.
 */
export function microvmCreatePayload(opts: {
  name: string
  ociRef: string
  cpu: number
  memory: number
  idleTimeout: string
  env: Record<string, string>
  agentName: string
}): Record<string, unknown> {
  return {
    name: opts.name,
    region: REGION,
    size: {cpu: opts.cpu, memory: opts.memory},
    source: {oci_ref: opts.ociRef},
    http_port: 8080,
    http_protocol: 'http',
    auto_pause: {idle_timeout: opts.idleTimeout},
    tags: ['cast', `agent:${opts.agentName}`],
    environment: opts.env,
  }
}

export function parseRegistryName(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw)
    // doctl 1.181 prints `registry get -o json` as an array. Older shapes
    // are a bare object or `{registry: {name}}`.
    const candidates = [
      parsed?.registry,
      Array.isArray(parsed) ? parsed[0] : undefined,
      Array.isArray(parsed?.registries) ? parsed.registries[0] : undefined,
      parsed,
    ]
    for (const registry of candidates) {
      if (typeof registry?.name === 'string' && registry.name.length > 0) return registry.name
    }
  } catch {
    return undefined
  }
  return undefined
}

export interface RegistryRepositoryRecord {
  name: string
  /** Undefined when the payload does not say whether the repository has tags. */
  tagCount: number | undefined
}

export interface RegistryRepositoryList {
  repositories: RegistryRepositoryRecord[]
  total?: number
}

/**
 * `subscription.tier.included_repositories` from GET /v2/registry/subscription.
 * `doctl registry get` does not include the tier. Professional plans report 0,
 * which means the plan does not cap repositories.
 */
export function parseRegistryRepositoryLimit(raw: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const tier = (parsed as {subscription?: {tier?: {included_repositories?: unknown}}}).subscription?.tier
  const found = tier?.included_repositories
  if (typeof found !== 'number' || !Number.isInteger(found) || found <= 0) return undefined
  return found
}

/** Repositories from `doctl registry repository list-v2 -o json`, or the API list shape. */
export function parseRegistryRepositoryList(raw: string): RegistryRepositoryList | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  const wrapped = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as {repositories?: unknown; meta?: {total?: unknown}}
    : undefined
  const items = Array.isArray(parsed) ? parsed : Array.isArray(wrapped?.repositories) ? wrapped.repositories : undefined
  if (!items) return undefined
  const repositories: RegistryRepositoryRecord[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    if (typeof record.name !== 'string' || record.name.length === 0) continue
    repositories.push({name: record.name, tagCount: repositoryTagCount(record)})
  }
  const total = typeof wrapped?.meta?.total === 'number' && Number.isFinite(wrapped.meta.total)
    ? wrapped.meta.total
    : undefined
  return {repositories, total}
}

function repositoryTagCount(record: Record<string, unknown>): number | undefined {
  const tags = numericField(record.tag_count ?? record.TagCount)
  if (tags !== undefined) return tags
  // doctl omits tag_count when it is 0. Manifests with no tag count are untagged
  // and still occupy a repository slot.
  if (numericField(record.manifest_count ?? record.ManifestCount) !== undefined) return 0
  return undefined
}

function numericField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return undefined
}

export function registryLimitFromPushError(text: string): {count: number; limit: number} | undefined {
  const match = /registry contains (\d+) repositor(?:y|ies), limit is (\d+)/i.exec(text)
  if (!match) return undefined
  const count = Number(match[1])
  const limit = Number(match[2])
  if (!Number.isInteger(count) || !Number.isInteger(limit) || limit <= 0) return undefined
  return {count, limit}
}

export function registryFullMessage(opts: {
  registry: string
  limit: number
  count?: number
  repositories?: RegistryRepositoryRecord[]
  agentRepository: string
}): string {
  const heldText = opts.count === undefined
    ? `DigitalOcean Container Registry "${opts.registry}" is at its repository limit of ${opts.limit}.`
    : `DigitalOcean Container Registry "${opts.registry}" already holds ${opts.count} repositories, and its limit is ${opts.limit}.`
  const parts = [
    heldText,
    `Each MicroVM agent uses one repository. This deploy needs "${opts.agentRepository}", and that repository is not in the registry yet.`,
    'An empty repository still counts toward the limit.',
  ]
  if (opts.repositories) {
    const empty = opts.repositories
      .filter(repo => repo.tagCount === 0 && repo.name.startsWith('cast-') && repo.name !== opts.agentRepository)
      .map(repo => repo.name)
      .sort()
    if (empty.length > 0) parts.push(`Empty cast-* repositories: ${empty.join(', ')}.`)
  }
  parts.push('Free a repository slot, then deploy again.')
  return parts.join(' ')
}

// Keep only the registry auth entry. `doctl registry login` stores that
// auth through Docker's credsStore, and a `desktop` helper fails with
// `dial unix backend.sock` when Docker Desktop is not running.
export function parseRegistryDockerConfig(raw: string): string {
  const parsed = JSON.parse(raw)
  const auth = parsed?.auths?.['registry.digitalocean.com']?.auth
  if (typeof auth !== 'string' || auth.length === 0) {
    throw new Error('DigitalOcean did not return registry credentials.')
  }
  return JSON.stringify({
    auths: {
      'registry.digitalocean.com': {auth},
    },
  })
}

export function dockerHostFromInspect(raw: string): string | undefined {
  const host = raw.trim()
  if (!host || host === '<no value>') return undefined
  if (/^(unix|tcp|npipe|ssh):\/\//.test(host)) return host
  return undefined
}

export function parseMicrovmPayload(raw: string): MicrovmRecord {
  const parsed = JSON.parse(raw)
  // doctl 1.181 prints create/get/list as a JSON array. Older responses
  // are a bare object, `{microvm}`, or `{microvms}`.
  const vm = Array.isArray(parsed)
    ? parsed[0]
    : parsed.microvm ?? (Array.isArray(parsed.microvms) ? parsed.microvms[0] : parsed)
  if (!vm || (typeof vm.id !== 'string' && typeof vm.id !== 'number')) {
    throw new Error('MicroVM response did not include an id.')
  }
  const urls = Array.isArray(vm.urls) ? vm.urls : []
  const preferred = urls.find((entry: {default?: boolean}) => entry?.default) || urls[0]
  let endpoint: string | undefined
  if (preferred) {
    const host = preferred.endpoint || preferred.hostname || preferred.url
    if (typeof host === 'string' && host.length > 0) {
      endpoint = host.startsWith('http') ? host : `https://${host}`
    }
  }
  const region = typeof vm.region === 'string' ? vm.region : vm.region?.slug
  if (!endpoint && region) {
    endpoint = `https://${vm.id}.${region}.microvm.ondigitalocean.com`
  }
  return {
    id: String(vm.id),
    name: vm.name,
    state: vm.state || vm.status,
    failureReason: vm.failure_reason || vm.failureReason,
    endpoint,
    endpointStatus: preferred?.status,
    region,
  }
}

export function microvmReady(record: MicrovmRecord): 'ready' | 'failed' | 'pending' {
  const state = (record.state || '').toLowerCase()
  if (state === 'failed' || state === 'error') return 'failed'
  const status = (record.endpointStatus || '').toUpperCase()
  if (record.endpoint && status === 'ACTIVE') return 'ready'
  if (record.endpoint && !record.endpointStatus && (state === 'running' || state === 'active')) return 'ready'
  return 'pending'
}

export function assertUpgradeable(state?: string): void {
  const normalized = (state || '').toLowerCase()
  if (normalized !== 'running' && normalized !== 'paused' && normalized !== 'active') {
    throw new Error(`MicroVM state is '${state || 'unknown'}'. Upgrade requires a running or paused MicroVM.`)
  }
}

export function mkc1Available(raw: string): boolean | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  const regions = findRegionSlugs(parsed)
  if (!regions) return null
  return regions.includes(REGION)
}

function findRegionSlugs(node: unknown, depth = 0): string[] | null {
  if (depth > 6 || node == null) return null
  if (Array.isArray(node)) {
    const slugs = node.map(item => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object') {
        const record = item as {slug?: string; name?: string}
        return record.slug || record.name
      }
      return undefined
    }).filter((slug): slug is string => typeof slug === 'string')
    if (slugs.length > 0 && slugs.every(slug => /^[a-z]{2,6}\d$/.test(slug))) return slugs
    for (const item of node) {
      const found = findRegionSlugs(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof node === 'object') {
    const record = node as Record<string, unknown>
    for (const key of ['regions', 'available_regions']) {
      if (key in record) {
        const found = findRegionSlugs(record[key], depth + 1)
        if (found) return found
      }
    }
    for (const key of ['region', 'default_region']) {
      if (typeof record[key] === 'string' && /^[a-z]{2,6}\d$/.test(record[key] as string)) {
        return [record[key] as string]
      }
    }
  }
  return null
}

export function probeAuthResult(status: number): 'ok' | 'unauthorized' | 'retry' {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401) return 'unauthorized'
  return 'retry'
}

export function extractExecStdout(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed)
      const obj = parsed.exec ?? parsed.result ?? parsed
      const out = obj?.stdout ?? obj?.output ?? obj?.data
      if (typeof out === 'string') return out
    } catch {
      // Fall through to the raw payload.
    }
  }
  return raw
}

export function decodeMemoryExport(stdout: string): Buffer {
  const payload = extractExecStdout(stdout).replace(/[^A-Za-z0-9+/=]/g, '')
  if (!payload) return Buffer.alloc(0)
  const decoded = Buffer.from(payload, 'base64')
  if (decoded.length > MEMORY_EXPORT_LIMIT) {
    throw new Error(
      `Memory store is ${decoded.length} bytes, over the 8 MiB limit for MicroVM upgrades. The existing MicroVM was left in place.`,
    )
  }
  return decoded
}

export function memoryChunks(encoded: string, size = MEMORY_CHUNK_CHARS): string[] {
  if (!/^[A-Za-z0-9+/=]*$/.test(encoded)) {
    throw new Error('Memory export is not base64.')
  }
  const chunks: string[] = []
  for (let i = 0; i < encoded.length; i += size) {
    chunks.push(encoded.slice(i, i + size))
  }
  return chunks
}

export function parseVolumeConfig(raw: string | null | undefined): MicrovmVolumeConfig {
  if (!raw) throw new Error('MicroVM deployment is missing volume_config.')
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('MicroVM deployment volume_config is not valid JSON.')
  }
  if (!parsed.microvmId || !parsed.ociRef || (parsed.authMode !== 'dual' && parsed.authMode !== 'edge-only')) {
    throw new Error('MicroVM deployment volume_config is missing microvmId, ociRef, or authMode.')
  }
  if (typeof parsed.cpu !== 'number' || typeof parsed.memory !== 'number' || typeof parsed.idleTimeout !== 'string') {
    throw new Error('MicroVM deployment volume_config is missing size or idle timeout. Redeploy with cast deploy.')
  }
  return {
    microvmId: String(parsed.microvmId),
    region: parsed.region || REGION,
    ociRef: String(parsed.ociRef),
    authMode: parsed.authMode,
    cpu: parsed.cpu,
    memory: parsed.memory,
    idleTimeout: parsed.idleTimeout,
  }
}

export function isMissingMicrovm(output: string): boolean {
  return /not found|404|does not exist|could not find/i.test(output)
}

export function isScopeDenied(output: string): boolean {
  return /403|forbidden|unauthorized/i.test(output)
}

/** `registry.digitalocean.com/<registry>/<repository>:<tag>` for one deployment. */
export function shutdownRegistryDeleteArgs(ociRef: string): string[] | undefined {
  const match = /^registry\.digitalocean\.com\/([^/]+)\/([^/:@]+):([^/:@\s]+)$/.exec(ociRef.trim())
  if (!match) return undefined
  return [
    'registry', 'repository', 'delete-tag',
    match[2],
    match[3],
    '--registry', match[1],
    '--force',
  ]
}

const REGISTRY_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

/**
 * DELETE URL for the one repository Cast created for this agent.
 * doctl can delete a tag or the whole registry. It cannot delete one repository.
 * Returns undefined unless the repository name is exactly `cast-<agent>`.
 */
export function registryRepositoryDeleteUrl(agentName: string, ociRef: string): string | undefined {
  const parsed = parsePushedRegistryTag(ociRef)
  if (!parsed) return undefined
  if (!isCastAgentRepository(agentName, parsed.repository)) return undefined
  if (!REGISTRY_NAME.test(parsed.registry)) return undefined
  const repository = castAgentRepositoryName(agentName)
  if (!repository || parsed.repository !== repository) return undefined
  return `https://api.digitalocean.com/v2/registries/${encodeURIComponent(parsed.registry)}/repositories/${encodeURIComponent(repository)}`
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * A MicroVM that did not become ready.
 * `microvmId` is set only when the VM is still on the account.
 */
export class MicrovmFailure extends Error {
  readonly microvmId?: string
  readonly endpoint?: string
  readonly region?: string

  constructor(message: string, microvmId?: string, endpoint?: string, region?: string) {
    super(message)
    this.name = 'MicrovmFailure'
    this.microvmId = microvmId
    this.endpoint = endpoint
    this.region = region
  }
}

export interface FailedMicrovmSettlement {
  id?: string
  endpoint?: string
  region?: string
  message: string
}

/** True when the MicroVM is gone (deleted, or already missing). */
export async function discardFailedMicrovm(
  id: string,
  remove: (id: string) => Promise<CommandResult | undefined>,
): Promise<boolean> {
  let result: CommandResult | undefined
  try {
    result = await remove(id)
  } catch {
    return false
  }
  if (!result) return false
  if (result.exitCode === 0) return true
  return isMissingMicrovm(`${result.stderr}\n${result.stdout}`)
}

function cleanupNote(message: string, deleted: boolean): string {
  const deletedNote = 'The MicroVM was deleted.'
  const remainNote = 'The MicroVM is still on the account.'
  const text = deleted ? message.replace(remainNote, deletedNote) : message.replace(deletedNote, remainNote)
  const note = deleted ? deletedNote : remainNote
  return text.includes(note) ? text : `${text} ${note}`
}

/**
 * Delete a MicroVM that failed during create. The returned error carries
 * the id only when the VM is still on the account.
 */
export async function settleFailedMicrovm(
  record: MicrovmRecord,
  detail: string,
  remove: (id: string) => Promise<CommandResult | undefined>,
): Promise<MicrovmFailure> {
  const deleted = await discardFailedMicrovm(record.id, remove)
  return new MicrovmFailure(
    cleanupNote(`MicroVM ${record.id} failed: ${detail}`, deleted),
    deleted ? undefined : record.id,
    deleted ? undefined : record.endpoint,
    deleted ? undefined : record.region,
  )
}

/**
 * After create or the endpoint probe fails, delete the MicroVM.
 * An id in the result means the VM is still on the account and should be recorded.
 */
export async function resolveFailedMicrovm(input: {
  error: unknown
  created?: {id?: string; endpoint?: string; region?: string}
  remove: (id: string) => Promise<CommandResult | undefined>
}): Promise<FailedMicrovmSettlement> {
  const message = input.error instanceof Error ? input.error.message : String(input.error)
  const failure = input.error instanceof MicrovmFailure ? input.error : undefined
  const id = input.created?.id || failure?.microvmId
  if (!id) return {message}
  const deleted = await discardFailedMicrovm(id, input.remove)
  if (deleted) return {message: cleanupNote(message, true)}
  return {
    id,
    endpoint: input.created?.endpoint || failure?.endpoint,
    region: input.created?.region || failure?.region,
    message: cleanupNote(message, false),
  }
}

/** `registry.digitalocean.com/<registry>/<repository>:<tag>` from a push this deploy made. */
export function parsePushedRegistryTag(ociRef: string): {registry: string; repository: string; tag: string} | undefined {
  const match = /^registry\.digitalocean\.com\/([^/]+)\/([^/:@]+):([^/:@\s]+)$/.exec(ociRef.trim())
  if (!match) return undefined
  return {registry: match[1], repository: match[2], tag: match[3]}
}

export function registryDeleteTagArgs(ociRef: string): string[] {
  const parsed = parsePushedRegistryTag(ociRef)
  if (!parsed) {
    throw new Error(`Cannot delete registry tag. Unrecognized image reference '${ociRef}'.`)
  }
  return [
    'registry', 'repository', 'delete-tag',
    parsed.repository,
    parsed.tag,
    '--registry', parsed.registry,
    '--force',
  ]
}

/**
 * Drop the bearer token written for a MicroVM deploy that did not finish.
 * A live deployment keeps the agent token. The per-deployment file for this attempt is always removed.
 */
export async function discardFailedMicrovmTokens(
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

/**
 * Delete the registry tag and token written for an attempt whose MicroVM is gone.
 * A MicroVM that is still on the account keeps both, because the recorded deployment uses them.
 * `deleteRepository` removes `cast-<agent>` only when no other MicroVM of this agent remains.
 */
export async function removeFailedMicrovmArtifacts(opts: {
  token: string
  ociRef?: string
  agentName: string
  deploymentSha?: string
  removeTokens: boolean
  deleteRepository?: boolean
  /** MicroVM ids this attempt already removed. They do not keep the repository. */
  ignoreMicrovmIds?: readonly string[]
  warn?: (message: string) => void
  log?: (message: string) => void
}): Promise<void> {
  const warn = opts.warn ?? ((message: string) => console.warn(message))
  const log = opts.log ?? ((message: string) => console.log(message))
  if (opts.ociRef) {
    const parsed = parsePushedRegistryTag(opts.ociRef)
    if (parsed && !isCastAgentRepository(opts.agentName, parsed.repository)) {
      log(`Note: Left registry repository '${parsed.repository}' in place. It does not belong to agent '${opts.agentName}'.`)
    } else {
      let tagGone = false
      try {
        const result = await doctl(opts.token, registryDeleteTagArgs(opts.ociRef))
        const text = `${result.stderr}\n${result.stdout}`
        tagGone = result.exitCode === 0 || isMissingMicrovm(text)
        if (!tagGone) {
          throw new Error(text.trim() || `Failed to delete registry tag ${opts.ociRef}`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        warn(`Failed to delete registry tag from the failed deploy: ${withoutSecret(message, opts.token)}`)
      }
      if (tagGone && opts.deleteRepository) {
        await deleteCastAgentRepository(opts.token, opts.agentName, opts.ociRef, {log, warn}, opts.ignoreMicrovmIds)
      }
    }
  }
  if (opts.removeTokens) {
    try {
      await discardFailedMicrovmTokens(opts.agentName, opts.deploymentSha)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      warn(`Failed to remove the auth token from the failed deploy: ${withoutSecret(message, opts.token)}`)
    }
  }
}

function volumeConfigJson(config: MicrovmVolumeConfig): string {
  return JSON.stringify(config)
}

async function run(command: string, args: string[], opts?: {silent?: boolean; timeoutMs?: number; env?: NodeJS.ProcessEnv}) {
  return execCommand(command, args, {
    shell: false,
    silent: opts?.silent ?? true,
    timeoutMs: opts?.timeoutMs,
    env: opts?.env,
  })
}

/**
 * Environment for a doctl child. doctl reads DIGITALOCEAN_ACCESS_TOKEN.
 * The token stays out of argv, where ps and command logs can read it.
 */
export function doctlChildEnv(token: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {...base, DIGITALOCEAN_ACCESS_TOKEN: token}
}

function doctl(token: string, args: string[], opts?: {silent?: boolean; timeoutMs?: number}) {
  assertSecretsNotInArgv('doctl', args, [token])
  return run('doctl', args, {
    silent: opts?.silent,
    timeoutMs: opts?.timeoutMs,
    env: doctlChildEnv(token),
  })
}

function withoutSecret(text: string, secret: string): string {
  if (!secret) return text
  return text.split(secret).join('[redacted]')
}

function registryErrorText(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const message = (data as {message?: unknown}).message
    if (typeof message === 'string' && message.trim()) return message.trim()
  }
  if (typeof data === 'string' && data.trim()) return data.trim()
  return `HTTP ${status}`
}

export interface RegistryTagCleanup {
  status: 'deleted' | 'missing' | 'failed' | 'skipped' | 'refused'
  ociRef?: string
  registry?: string
  repository?: string
}

interface RegistryCleanupOutput {
  log: (message: string) => void
  warn: (message: string) => void
}

/**
 * Delete `cast-<agent>` and nothing else. A failure is a warning that names
 * that repository. Callers keep going.
 * `ignoreMicrovmIds` are MicroVMs this shutdown already removed. Any other
 * live MicroVM whose image uses this repository keeps it.
 */
export async function deleteCastAgentRepository(
  token: string,
  agentName: string,
  ociRef: string,
  output: RegistryCleanupOutput = {
    log: message => console.log(message),
    warn: message => console.warn(message),
  },
  ignoreMicrovmIds: readonly string[] = [],
): Promise<void> {
  const repository = castAgentRepositoryName(agentName)
  const url = registryRepositoryDeleteUrl(agentName, ociRef)
  if (!repository || !url || !url.endsWith(`/repositories/${encodeURIComponent(repository)}`)) return
  if (!url.startsWith('https://api.digitalocean.com/v2/registries/')) return
  const parsed = parsePushedRegistryTag(ociRef)
  if (!parsed || parsed.repository !== repository) return
  try {
    const inUse = await anotherLiveMicrovmUsesRepository(token, parsed.registry, repository, new Set(ignoreMicrovmIds))
    if (inUse) {
      output.warn(`Left registry repository '${repository}' in place. Another MicroVM still uses an image from that repository.`)
      return
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.warn(`Left registry repository '${repository}' in place. Could not list live MicroVMs: ${withoutSecret(message, token)}`)
    return
  }
  try {
    const response = await axios.delete(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 60000,
      maxRedirects: 0,
      validateStatus: () => true,
    })
    if (response.status >= 200 && response.status < 300) {
      output.log(`Deleted registry repository '${repository}'.`)
      return
    }
    if (response.status === 404) return
    const detail = withoutSecret(registryErrorText(response.data, response.status), token)
    output.warn(`Failed to delete registry repository '${repository}'. The repository is still in the registry: ${detail}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.warn(`Failed to delete registry repository '${repository}'. The repository is still in the registry: ${withoutSecret(message, token)}`)
  }
}

/**
 * Delete the registry tag stored on a MicroVM deployment.
 * Called only after that MicroVM is gone. A missing tag is success.
 * A failed delete is a warning that names the leftover tag. Shutdown continues.
 * A repository Cast did not create for this agent is left untouched.
 */
export async function deleteShutdownRegistryTag(
  token: string,
  agentName: string,
  volumeConfig: string | null | undefined,
): Promise<RegistryTagCleanup> {
  if (!volumeConfig) return {status: 'skipped'}
  let ociRef: string
  try {
    ociRef = parseVolumeConfig(volumeConfig).ociRef
  } catch {
    return {status: 'skipped'}
  }
  const parsed = parsePushedRegistryTag(ociRef)
  if (!parsed) {
    console.log(`Note: Could not parse a registry tag from '${ociRef}'.`)
    return {status: 'skipped', ociRef}
  }
  if (!isCastAgentRepository(agentName, parsed.repository)) {
    console.log(`Note: Left registry repository '${parsed.repository}' in place. It does not belong to agent '${agentName}'.`)
    return {status: 'refused', ociRef, registry: parsed.registry, repository: parsed.repository}
  }
  const args = shutdownRegistryDeleteArgs(ociRef)
  if (!args || args[3] !== parsed.repository) {
    console.log(`Note: Could not parse a registry tag from '${ociRef}'.`)
    return {status: 'skipped', ociRef}
  }
  const tag = args[4]
  const label = `${parsed.repository}:${tag}`
  const cleaned = {ociRef, registry: parsed.registry, repository: parsed.repository}
  try {
    const result = await doctl(token, args)
    const text = `${result.stderr}\n${result.stdout}`
    if (result.exitCode === 0) {
      console.log(`Deleted registry tag '${label}'.`)
      return {status: 'deleted', ...cleaned}
    }
    if (isMissingMicrovm(text)) return {status: 'missing', ...cleaned}
    console.warn(`Failed to delete registry tag '${label}'. The tag is still in the registry: ${withoutSecret(text.trim() || 'doctl delete-tag failed', token)}`)
    return {status: 'failed', ...cleaned}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`Failed to delete registry tag '${label}'. The tag is still in the registry: ${withoutSecret(message, token)}`)
    return {status: 'failed', ...cleaned}
  }
}

interface MicrovmDeploymentRow {
  id?: string
  volume_id?: string | null
  volume_config?: string | null
}

function microvmListPage(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2000) return undefined
  const absolute = value.startsWith('/') ? `https://api.digitalocean.com${value}` : value
  let parsed: URL
  try {
    parsed = new URL(absolute)
  } catch {
    return undefined
  }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.digitalocean.com') return undefined
  if (parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return undefined
  if (parsed.pathname !== '/v2/microvms') return undefined
  return parsed.toString()
}

function microvmIdOf(vm: unknown): string | undefined {
  if (!vm || typeof vm !== 'object') return undefined
  const id = (vm as {id?: unknown}).id
  if (typeof id === 'string' && id.length > 0) return id
  if (typeof id === 'number') return String(id)
  return undefined
}

function microvmOciRef(vm: unknown): string | undefined {
  if (!vm || typeof vm !== 'object') return undefined
  const ref = (vm as {source?: {oci_ref?: unknown}}).source?.oci_ref
  return typeof ref === 'string' && ref.length > 0 ? ref : undefined
}

/**
 * True when the image is exactly this repository, or that name followed by
 * `:` or `@`. `cast-foo` does not match `cast-foobar`.
 * Undefined means the reference is not a DigitalOcean repository image.
 */
function ociRefUsesRepository(ref: string, registry: string, repository: string): boolean | undefined {
  const prefix = `registry.digitalocean.com/${registry}/${repository}`
  if (ref === prefix || ref.startsWith(`${prefix}:`) || ref.startsWith(`${prefix}@`)) return true
  const match = /^registry\.digitalocean\.com\/([^/]+)\/([^/:@]+)([:@].*)?$/.exec(ref)
  if (!match) return undefined
  return false
}

/** Follow GET /v2/microvms. A partial list is a failure so the repository stays. */
async function listAccountMicrovms(token: string): Promise<unknown[]> {
  const collected: unknown[] = []
  let url: string | undefined = MICROVM_LIST_URL
  for (let page = 0; page < 20 && url; page++) {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 60000,
      maxRedirects: 0,
      validateStatus: () => true,
    })
    if (response.status < 200 || response.status >= 300) {
      throw new Error(registryErrorText(response.data, response.status))
    }
    const data = response.data as {microvms?: unknown; links?: {pages?: {next?: unknown}}}
    if (!Array.isArray(data?.microvms)) throw new Error('MicroVM list did not include a microvms array.')
    collected.push(...data.microvms)
    const next = data.links?.pages?.next
    if (next == null || next === '') return collected
    const parsed = microvmListPage(next)
    if (!parsed) throw new Error('MicroVM list returned an unexpected next page.')
    url = parsed
  }
  throw new Error('MicroVM list did not finish within 20 pages.')
}

async function anotherLiveMicrovmUsesRepository(
  token: string,
  registry: string,
  repository: string,
  ignoreIds: ReadonlySet<string>,
): Promise<boolean> {
  const vms = await listAccountMicrovms(token)
  return vms.some(vm => {
    const id = microvmIdOf(vm)
    if (id && ignoreIds.has(id)) return false
    const image = microvmOciRef(vm)
    // A missing or unreadable image might still be this repository.
    if (!image) return true
    const uses = ociRefUsesRepository(image, registry, repository)
    return uses !== false
  })
}

function otherMicrovmRemains(recorded: MicrovmDeploymentRow[], destroyed: MicrovmDeploymentRow[]): boolean {
  const ids = new Set(destroyed.map(row => row.id).filter((id): id is string => typeof id === 'string' && id.length > 0))
  const volumes = new Set(destroyed.map(row => row.volume_id).filter((id): id is string => typeof id === 'string' && id.length > 0))
  return recorded.some(row => {
    const idDestroyed = typeof row.id === 'string' && ids.has(row.id)
    const volumeDestroyed = typeof row.volume_id === 'string' && volumes.has(row.volume_id)
    return !idDestroyed && !volumeDestroyed
  })
}

/**
 * After the last MicroVM for this agent is gone, delete the one repository
 * Cast created for it. Another local MicroVM keeps the repository, and so
 * does any other live MicroVM on the account whose image uses it. A failed
 * tag delete also keeps it: the tag is still in use. Other repository names
 * are never requested.
 */
async function deleteShutdownAgentRepository(
  token: string,
  agentName: string,
  recorded: MicrovmDeploymentRow[],
  destroyed: MicrovmDeploymentRow[],
  cleaned: RegistryTagCleanup[],
): Promise<void> {
  if (otherMicrovmRemains(recorded, destroyed)) return
  if (cleaned.some(item => item.status === 'failed')) return
  const ignoreMicrovmIds = destroyed
    .map(row => row.volume_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0)
  const seen = new Set<string>()
  for (const item of cleaned) {
    if ((item.status !== 'deleted' && item.status !== 'missing') || !item.ociRef || !item.repository) continue
    if (seen.has(item.repository)) continue
    seen.add(item.repository)
    await deleteCastAgentRepository(token, agentName, item.ociRef, undefined, ignoreMicrovmIds)
  }
}

export default class MicrovmDeploy extends Command {
  static description = 'Deploy agent to a DigitalOcean MicroVM'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    size: Flags.string({
      description: 'MicroVM size as cpu:memory-mib. One of 1:2048, 2:4096, 8:16384, 16:32768.',
      default: '1:2048',
    }),
    'idle-timeout': Flags.string({
      description: 'Idle time before auto-pause, for example 15m. Maximum 4h.',
      default: '15m',
    }),
    'edge-auth-only': Flags.boolean({
      description: 'Skip the per-agent AUTH_TOKEN. Access control is the team microvm:access token.',
      default: false,
    }),
  }

  static async destroy(agentName: string, deployment?: {
    id?: string
    volume_id?: string | null
    volume_config?: string | null
  }): Promise<void> {
    const token = resolveDigitalOceanToken()
    const recorded = db.listDeployments(agentName).filter(row => row.provider === 'microvm')
    let deployments = recorded
    if (deployment?.volume_id || deployment?.id) {
      const matched = deployments.filter(row =>
        (deployment.volume_id && row.volume_id === deployment.volume_id) ||
        (deployment.id && row.id === deployment.id)
      )
      if (deployment.volume_id) {
        deployments = matched.length > 0 ? matched : [{
          volume_id: deployment.volume_id,
          volume_config: deployment.volume_config,
        }]
      } else if (matched.length === 0) {
        console.log(`No MicroVM deployment recorded for '${agentName}' (${deployment.id}).`)
        return
      } else {
        deployments = matched
      }
    }
    if (deployments.length === 0) {
      console.log(`No MicroVM deployment recorded for '${agentName}'.`)
      return
    }
    if (!token) {
      throw new Error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN or run doctl auth init.')
    }
    const cleaned: RegistryTagCleanup[] = []
    const destroyed: MicrovmDeploymentRow[] = []
    for (const row of deployments) {
      const id = row.volume_id
      if (!id) continue
      const result = await doctl(token, ['compute', 'microvm', 'delete', id, '--force'])
      const combined = `${result.stderr}\n${result.stdout}`
      if (result.exitCode !== 0 && !isMissingMicrovm(combined)) {
        throw new Error(`Failed to destroy MicroVM '${id}': ${combined}`)
      }
      if (result.exitCode !== 0) {
        console.log(`MicroVM '${id}' does not exist (already deleted).`)
      } else {
        console.log(`MicroVM '${id}' has been destroyed.`)
      }
      destroyed.push(row)
      cleaned.push(await deleteShutdownRegistryTag(token, agentName, row.volume_config))
    }
    await deleteShutdownAgentRepository(token, agentName, recorded, destroyed, cleaned)
  }

  static async upgrade(agentName: string, deployment: any, log: (message: string) => void = console.log): Promise<void> {
    const agentPath = getAgentPath(agentName)
    const ollamaRefusal = ollamaDeployRefusal('microvm', readAgentModel(agentPath))
    if (ollamaRefusal) throw new Error(ollamaRefusal)

    const token = requireToken()
    const config = parseVolumeConfig(deployment.volume_config)
    const current = await getMicrovm(token, config.microvmId)
    assertUpgradeable(current.state)

    log('Exporting agent memory from the MicroVM...')
    const exported = await execOnMicrovm(
      token,
      config.microvmId,
      'if [ -d /app/agent/memory ]; then tar -C /app/agent -cz memory | base64 -w 0; fi',
    )
    const memory = decodeMemoryExport(exported)
    const encoded = memory.length > 0 ? memory.toString('base64') : ''

    // A previous deploy left .cast-runtime/cast in the agent directory.
    // Rebuild from that copy and the image keeps the old runtime, so a
    // quiet chat stream still dies on the MicroVM edge.
    const projectRoot = findProjectRoot()
    prepareCastImageContext(agentPath, projectRoot)
    if (!copyCastRuntime(agentPath, projectRoot)) {
      throw new Error(
        `Cast Python package not found under ${projectRoot}. Run cast upgrade from a Cast Agent checkout so the image includes the current runtime.`,
      )
    }

    const sha = deployment.id as string
    const stamp = Date.now().toString(36)
    const ociRef = await buildAndPushImage(agentName, `${sha}-${stamp}`, log)
    const name = sanitizeMicrovmName(agentName, `${sha}-${stamp}`)
    let authToken: string | undefined
    if (config.authMode === 'dual') {
      authToken = await currentAgentToken(deployment)
      if (!authToken) {
        throw new Error('No agent auth token in the keychain. Redeploy with cast deploy to generate one.')
      }
    }
    const env = deploymentEnv({
      agentName,
      authToken,
      inference: filterInferenceEnv(readAgentModel(agentPath), await inferenceEnv()),
      edgeAuthOnly: config.authMode === 'edge-only',
    })

    log('Creating a replacement MicroVM...')
    let created: MicrovmRecord | undefined
    try {
      created = await createAndWait(token, {
        name,
        ociRef,
        cpu: config.cpu,
        memory: config.memory,
        idleTimeout: config.idleTimeout,
        env,
        agentName,
      }, log)
      await probeEndpoint(token, created, config.authMode === 'edge-only', authToken)
      if (encoded) {
        log('Restoring agent memory...')
        await restoreMemory(token, created.id, encoded)
      }
    } catch (error) {
      const settled = await resolveFailedMicrovm({
        error,
        created,
        remove: (id) => doctl(token, ['compute', 'microvm', 'delete', id, '--force']).catch(() => undefined),
      })
      if (!settled.id) {
        await removeFailedMicrovmArtifacts({
          token,
          ociRef,
          agentName,
          removeTokens: false,
          deleteRepository: false,
          warn: message => log(message),
        })
      }
      if (settled.id) {
        throw new Error(`${settled.message} Delete it with doctl compute microvm delete ${settled.id} --force`)
      }
      throw new Error(settled.message)
    }

    const next: MicrovmVolumeConfig = {
      ...config,
      microvmId: created.id,
      region: created.region || config.region,
      ociRef,
    }
    db.updateDeploymentEndpoint(deployment.id, created.endpoint!, created.id, volumeConfigJson(next))
    const removed = await doctl(token, ['compute', 'microvm', 'delete', config.microvmId, '--force'])
    if (removed.exitCode !== 0 && !isMissingMicrovm(`${removed.stderr}\n${removed.stdout}`)) {
      log(`Replacement is live at ${created.endpoint}. The previous MicroVM ${config.microvmId} could not be deleted: ${removed.stderr || removed.stdout}`)
    }
    log(`Upgraded MicroVM: ${created.endpoint}`)
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(MicrovmDeploy)
    const agentName = args.agent
    const size = parseSize(flags.size)
    const idleTimeout = parseIdleTimeout(flags['idle-timeout'])
    const edgeAuthOnly = flags['edge-auth-only']

    this.log('DigitalOcean MicroVMs are in public preview (MKC1 only). Not recommended for production.')

    const token = requireToken()
    await this.ensureDoctl(token)
    await this.ensureDocker()

    const agentPath = getAgentPath(agentName)
    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}.`)
    }

    const projectRoot = findProjectRoot()
    prepareCastImageContext(agentPath, projectRoot)
    if (!copyCastRuntime(agentPath, projectRoot)) {
      this.error(`Cast Python package not found under ${projectRoot}. Run cast deploy from a Cast Agent checkout so the image includes the runtime.`)
    }
    await prepareHostTuiBuildContext(agentPath, projectRoot, {enabled: false})

    const deploymentId = generateDeploymentId()
    const sha = process.env.CAST_DEPLOYMENT_SHA || deploymentId
    const deploymentSha = deploymentShaFromEnv()
    let authToken: string | undefined
    let tokenHash = ''
    let ociRef: string | undefined
    let created: MicrovmRecord | undefined
    try {
      if (!edgeAuthOnly) {
        const generated = await generateAuthToken(agentName)
        authToken = generated.authToken
        tokenHash = generated.tokenHash
      }

      ociRef = await buildAndPushImage(agentName, sha, message => this.log(message))
      const name = sanitizeMicrovmName(agentName, sha)
      const env = deploymentEnv({
        agentName,
        authToken,
        inference: filterInferenceEnv(readAgentModel(agentPath), await inferenceEnv()),
        edgeAuthOnly,
      })
      created = await createAndWait(token, {
        name,
        ociRef,
        cpu: size.cpu,
        memory: size.memory,
        idleTimeout,
        env,
        agentName,
      }, message => this.log(message))
      await probeEndpoint(token, created, edgeAuthOnly, authToken)
    } catch (error: unknown) {
      const settled = await resolveFailedMicrovm({
        error,
        created,
        remove: (id) => doctl(token, ['compute', 'microvm', 'delete', id, '--force']).catch(() => undefined),
      })
      if (settled.id && ociRef) {
        const endpoint = settled.endpoint || `https://${settled.id}.${settled.region || REGION}.microvm.ondigitalocean.com`
        await saveDeployment(agentName, 'microvm', endpoint, tokenHash, settled.id, volumeConfigJson({
          microvmId: settled.id,
          region: settled.region || REGION,
          ociRef,
          authMode: edgeAuthOnly ? 'edge-only' : 'dual',
          cpu: size.cpu,
          memory: size.memory,
          idleTimeout,
        }))
        this.error(`${settled.message} The deployment was recorded so cast shutdown ${agentName} can remove it.`)
      }
      if (!settled.id) {
        const otherMicrovm = db.listDeployments(agentName).some(row => row.provider === 'microvm')
        await removeFailedMicrovmArtifacts({
          token,
          ociRef,
          agentName,
          deploymentSha,
          removeTokens: !edgeAuthOnly,
          deleteRepository: !otherMicrovm,
          ignoreMicrovmIds: created?.id ? [created.id] : undefined,
          warn: message => this.warn(message),
          log: message => this.log(message),
        })
      }
      this.error(settled.message)
    }

    if (!created || !created.endpoint || !ociRef) {
      this.error('MicroVM deploy finished without an endpoint.')
    }

    const config: MicrovmVolumeConfig = {
      microvmId: created.id,
      region: created.region || REGION,
      ociRef,
      authMode: edgeAuthOnly ? 'edge-only' : 'dual',
      cpu: size.cpu,
      memory: size.memory,
      idleTimeout,
    }
    await saveDeployment(agentName, 'microvm', created.endpoint!, tokenHash, created.id, volumeConfigJson(config))

    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`URL: ${created.endpoint}`)
    this.log(`MicroVM: ${created.id}`)
    this.log('Provider: microvm')
    if (edgeAuthOnly) {
      this.log('Auth: team microvm:access token only. Any token with that scope on this team can call the agent.')
    }
    this.log('')
    this.log('To view logs:')
    this.log(`  doctl compute microvm exec ${created.id} -- <log command>`)
    this.log('')
    this.log('To connect:')
    this.log(`  cast connect ${agentName}`)
    this.log('')
    this.log('To destroy:')
    this.log(`  cast shutdown ${agentName}`)
  }

  private async ensureDoctl(token: string): Promise<void> {
    const version = await run('doctl', ['version'])
    const versionText = `${version.stdout}\n${version.stderr}`
    if (version.exitCode !== 0 || !doctlVersionAtLeast(versionText)) {
      this.error(`doctl 1.173.0 or newer is required for MicroVMs. Install it from https://docs.digitalocean.com/reference/doctl/how-to/install/`)
    }
    const options = await doctl(token, ['compute', 'microvm', 'options', '--output', 'json'])
    const optionsText = `${options.stdout}\n${options.stderr}`
    if (options.exitCode !== 0) {
      if (isScopeDenied(optionsText)) {
        this.error(`DigitalOcean rejected the MicroVM options request. ${SCOPE_HINT}`)
      }
      this.error(`Could not read MicroVM options: ${optionsText}`)
    }
    const available = mkc1Available(options.stdout)
    if (available === false) {
      this.error('DigitalOcean MicroVMs are in public preview and are not available in MKC1 for this account.')
    }
  }

  private async ensureDocker(): Promise<void> {
    const docker = await run('docker', ['info'], {timeoutMs: 30000})
    if (docker.exitCode !== 0) {
      this.error('Docker is required to build the MicroVM image. Install it from https://docs.docker.com/get-docker/ and start the daemon.')
    }
  }

}

/**
 * Copy the current Cast runtime into the agent image context.
 * Returns false when this checkout has no python/cast package.
 * Replaces any runtime left behind by an earlier deploy.
 */
export function copyCastRuntime(agentPath: string, projectRoot: string = findProjectRoot()): boolean {
  const castRuntimeSrc = path.join(projectRoot, 'python', 'cast')
  if (!fs.existsSync(castRuntimeSrc)) return false
  const castRuntimeDir = path.join(agentPath, '.cast-runtime', 'cast')
  fs.mkdirSync(path.dirname(castRuntimeDir), {recursive: true})
  if (fs.existsSync(castRuntimeDir)) fs.rmSync(castRuntimeDir, {recursive: true})
  fs.cpSync(castRuntimeSrc, castRuntimeDir, {recursive: true})
  return true
}

function requireToken(): string {
  const token = resolveDigitalOceanToken()
  if (!token) {
    throw new Error('DigitalOcean API token not found. Set DIGITALOCEAN_ACCESS_TOKEN, DIGITALOCEAN_API_TOKEN, or DIGITALOCEAN_API_KEY, add providers.digitalocean.token to ~/.cast/config.yaml, or run doctl auth init.')
  }
  return token
}

async function currentAgentToken(deployment: {id: string, agent_name: string, auth_token_hash?: string | null}): Promise<string | undefined> {
  return (await resolveDeploymentAuthToken(deployment)) || undefined
}

function findProjectRoot(): string {
  const markers = ['python/cast', 'typescript/cast-tui']
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '..'),
    path.resolve(__dirname, '../..'),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
  ]
  for (const candidate of candidates) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(candidate, marker))) return candidate
    }
  }
  return process.cwd()
}

async function ensureRegistry(token: string, log: (message: string) => void): Promise<string> {
  const existing = await doctl(token, ['registry', 'get', '--output', 'json'])
  if (existing.exitCode === 0) {
    const name = parseRegistryName(existing.stdout)
    if (name) return name
  }
  log('Creating DigitalOcean Container Registry "cast"...')
  const created = await doctl(token, ['registry', 'create', 'cast', '--output', 'json'], {timeoutMs: 120000})
  if (created.exitCode !== 0) {
    const again = await doctl(token, ['registry', 'get', '--output', 'json'])
    throw new Error(
      `Could not create container registry "cast". ${created.stderr || created.stdout}\n` +
      `doctl registry get:\n${again.stdout || again.stderr}`,
    )
  }
  const name = parseRegistryName(created.stdout)
  if (!name) throw new Error(`Registry was created but its name was not in the response: ${created.stdout}`)
  return name
}

async function fetchRegistryDockerConfig(token: string, registry: string): Promise<string> {
  const result = await doctl(token, [
    'registry', 'docker-config', registry,
    '--read-write',
    '--expiry-seconds', '3600',
  ])
  if (result.exitCode !== 0) {
    throw new Error(`Could not get DigitalOcean registry credentials: ${result.stderr || 'doctl registry docker-config failed'}`)
  }
  try {
    return parseRegistryDockerConfig(result.stdout)
  } catch (error: any) {
    throw new Error(error?.message || 'DigitalOcean did not return registry credentials.')
  }
}

function writeRegistryDockerConfig(configJson: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-docr-'))
  fs.writeFileSync(path.join(dir, 'config.json'), configJson, {mode: 0o600})
  return dir
}

async function registryDockerEnv(configDir: string): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = {...process.env, DOCKER_CONFIG: configDir}
  if (env.DOCKER_HOST) return env
  const inspected = await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'])
  const host = inspected.exitCode === 0 ? dockerHostFromInspect(inspected.stdout) : undefined
  if (host) env.DOCKER_HOST = host
  return env
}

/**
 * Stop before the image build when this agent's repository is not in the
 * registry and the plan's repository limit is already reached.
 * A missing limit or a failed list leaves the push to report the same limit.
 */
async function assertRegistryRepositoryCapacity(token: string, registry: string, repository: string): Promise<void> {
  let limit: number | undefined
  try {
    const response = await axios.get(REGISTRY_SUBSCRIPTION_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      timeout: 60000,
      maxRedirects: 0,
      validateStatus: () => true,
    })
    if (response.status >= 200 && response.status < 300) {
      const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      limit = parseRegistryRepositoryLimit(body)
    }
  } catch {
    return
  }
  if (!limit) return
  let listed: RegistryRepositoryList | undefined
  try {
    const result = await doctl(token, ['registry', 'repository', 'list-v2', '--registry', registry, '--output', 'json'])
    if (result.exitCode !== 0) return
    listed = parseRegistryRepositoryList(result.stdout)
  } catch {
    return
  }
  if (!listed) return
  if (listed.repositories.some(item => item.name === repository)) return
  const count = listed.total ?? listed.repositories.length
  if (count < limit) return
  throw new Error(registryFullMessage({
    registry,
    limit,
    count,
    repositories: listed.repositories,
    agentRepository: repository,
  }))
}

async function buildAndPushImage(agentName: string, tag: string, log: (message: string) => void): Promise<string> {
  const token = requireToken()
  const registry = await ensureRegistry(token, log)
  const repo = sanitizeRepoName(agentName)
  await assertRegistryRepositoryCapacity(token, registry, repo)
  const localTag = `cast-${agentName}:microvm`
  const agentPath = getAgentPath(agentName)
  const remote = `registry.digitalocean.com/${registry}/${repo}:${tag}`

  log('Building Docker image for linux/amd64...')
  const build = await run('docker', [
    'buildx', 'build',
    '--platform', 'linux/amd64',
    '--load',
    '-t', localTag,
    '-f', path.join(agentPath, 'Dockerfile'),
    agentPath,
  ], {silent: false, timeoutMs: 900000})
  if (build.exitCode !== 0) {
    throw new Error(appendCompilerHint(
      `Docker build failed: ${build.stderr || build.stdout}`,
      `${build.stdout}\n${build.stderr}`,
    ))
  }

  const inspect = await run('docker', ['image', 'inspect', '--format', '{{.Architecture}}', localTag])
  const arch = inspect.stdout.trim()
  if (inspect.exitCode !== 0 || arch !== 'amd64') {
    throw new Error(`MicroVMs run linux/amd64 images only. This image is '${arch || 'unknown'}'.`)
  }

  log('Authenticating to DigitalOcean Container Registry...')
  const configJson = await fetchRegistryDockerConfig(token, registry)
  const configDir = writeRegistryDockerConfig(configJson)
  try {
    const env = await registryDockerEnv(configDir)
    log(`Pushing ${remote}...`)
    const tagged = await run('docker', ['tag', localTag, remote], {env})
    if (tagged.exitCode !== 0) throw new Error(`docker tag failed: ${tagged.stderr}`)
    const pushed = await run('docker', ['push', remote], {silent: false, timeoutMs: 600000, env})
    if (pushed.exitCode !== 0) {
      const text = `${pushed.stderr || ''}\n${pushed.stdout || ''}`
      const limited = registryLimitFromPushError(text)
      if (limited) {
        let repositories: RegistryRepositoryRecord[] | undefined
        try {
          const listed = await doctl(token, ['registry', 'repository', 'list-v2', '--registry', registry, '--output', 'json'])
          if (listed.exitCode === 0) repositories = parseRegistryRepositoryList(listed.stdout)?.repositories
        } catch {
          repositories = undefined
        }
        throw new Error(registryFullMessage({
          registry,
          limit: limited.limit,
          count: limited.count,
          repositories,
          agentRepository: repo,
        }))
      }
      throw new Error(`docker push failed: ${pushed.stderr || pushed.stdout}`)
    }
  } finally {
    fs.rmSync(configDir, {recursive: true, force: true})
  }
  return remote
}

async function postMicrovmCreate(
  token: string,
  opts: {
    name: string
    ociRef: string
    cpu: number
    memory: number
    idleTimeout: string
    env: Record<string, string>
    agentName: string
  },
): Promise<string> {
  const payload = microvmCreatePayload(opts)
  let lastBody = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    let response: {status: number; data: unknown}
    try {
      response = await axios.post(MICROVM_CREATE_URL, payload, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 180000,
        validateStatus: () => true,
      })
    } catch (error) {
      lastBody = error instanceof Error ? error.message : String(error)
      if (attempt < 4) {
        await delay(1000 * (attempt + 1))
        continue
      }
      throw new Error(`MicroVM create failed: ${lastBody}`)
    }
    const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
    if (response.status >= 200 && response.status < 300) return body
    lastBody = body
    if ((response.status === 429 || response.status >= 500) && attempt < 4) {
      await delay(1000 * (attempt + 1))
      continue
    }
    if (isScopeDenied(body) || isScopeDenied(String(response.status))) {
      throw new Error(`DigitalOcean rejected MicroVM create. ${SCOPE_HINT}\n${body}`)
    }
    throw new Error(`MicroVM create failed: ${body}`)
  }
  throw new Error(`MicroVM create failed: ${lastBody}`)
}

async function createAndWait(
  token: string,
  opts: {
    name: string
    ociRef: string
    cpu: number
    memory: number
    idleTimeout: string
    env: Record<string, string>
    agentName: string
  },
  log: (message: string) => void,
): Promise<MicrovmRecord> {
  const created = await postMicrovmCreate(token, opts)
  const remove = (id: string) =>
    doctl(token, ['compute', 'microvm', 'delete', id, '--force']).catch(() => undefined)
  let record = parseMicrovmPayload(created)
  try {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      const readiness = microvmReady(record)
      if (readiness === 'ready' && record.endpoint) return record
      if (readiness === 'failed') {
        throw await settleFailedMicrovm(record, record.failureReason || record.state || 'failed', remove)
      }
      log(`Waiting for MicroVM ${record.id} (${record.state || 'provisioning'})...`)
      await delay(POLL_DELAY_MS)
      record = await getMicrovm(token, record.id)
    }
    throw await settleFailedMicrovm(record, 'did not become ready', remove)
  } catch (error) {
    if (error instanceof MicrovmFailure) throw error
    const detail = error instanceof Error ? error.message : String(error)
    throw await settleFailedMicrovm(record, detail, remove)
  }
}

async function getMicrovm(token: string, id: string): Promise<MicrovmRecord> {
  const result = await doctl(token, ['compute', 'microvm', 'get', id, '--output', 'json'], {timeoutMs: 30000})
  if (result.exitCode !== 0) {
    throw new Error(`Could not read MicroVM ${id}: ${result.stderr || result.stdout}`)
  }
  return parseMicrovmPayload(result.stdout)
}

async function probeEndpoint(token: string, record: MicrovmRecord, edgeAuthOnly: boolean, agentToken?: string): Promise<void> {
  if (!record.endpoint) throw new Error(`MicroVM ${record.id} has no endpoint.`)
  const target = record.endpoint.endsWith('/') ? record.endpoint : `${record.endpoint}/`
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
  if (!edgeAuthOnly && agentToken) headers['X-Cast-Authorization'] = `Bearer ${agentToken}`

  let lastStatus = 0
  let lastBody = ''
  for (let attempt = 0; attempt < PROBE_ATTEMPTS; attempt++) {
    try {
      const response = await axios.post(target, {
        jsonrpc: '2.0',
        id: '1',
        method: 'agent/card',
        params: {},
      }, {
        headers,
        timeout: 120000,
        validateStatus: () => true,
      })
      lastStatus = response.status
      lastBody = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
      const result = probeAuthResult(response.status)
      if (result === 'ok') return
      if (result === 'unauthorized') {
        if (edgeAuthOnly) {
          throw new Error('MicroVM endpoint returned 401. The DigitalOcean token needs the microvm:access scope. The MicroVM was deleted.')
        }
        throw new Error('MicroVM endpoint returned 401. The edge did not accept the agent header. Rerun with --edge-auth-only. The MicroVM was deleted.')
      }
    } catch (error: any) {
      if (error?.message?.includes('MicroVM endpoint returned 401')) throw error
      lastBody = error?.message || String(error)
    }
    await delay(PROBE_DELAY_MS)
  }
  throw new Error(`MicroVM endpoint probe failed (${lastStatus || 'no response'}): ${lastBody.slice(0, 300)}`)
}

async function execOnMicrovm(token: string, id: string, command: string): Promise<string> {
  const result = await doctl(token, ['compute', 'microvm', 'exec', id, '--', 'sh', '-c', command], {timeoutMs: 180000})
  if (result.exitCode !== 0) {
    throw new Error(`MicroVM exec failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

async function restoreMemory(token: string, id: string, encoded: string): Promise<void> {
  await execOnMicrovm(token, id, 'rm -f /tmp/cast-memory.b64')
  for (const chunk of memoryChunks(encoded)) {
    await execOnMicrovm(token, id, `printf '%s' '${chunk}' >> /tmp/cast-memory.b64`)
  }
  await execOnMicrovm(token, id, 'base64 -d /tmp/cast-memory.b64 | tar -C /app/agent -xz && rm -f /tmp/cast-memory.b64')
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
