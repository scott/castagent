import * as net from 'net'
import {keychain} from './keychain'
import {db, generateDeploymentSha} from './sqlite'

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const HOST_SUFFIX = '.microvm.ondigitalocean.com'

export class CastbotImportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CastbotImportError'
  }
}

export interface CastbotBlob {
  name: string
  agentId: string
  url: string
  token: string
}

/** True when this local row was written for a castbot-managed machine. */
export function isCastbotManaged(row: {managed_by?: string | null; volume_config?: string | null}): boolean {
  if (row.managed_by === 'castbot') return true
  if (!row.volume_config) return false
  try {
    const parsed = JSON.parse(row.volume_config) as {managedBy?: unknown}
    return parsed.managedBy === 'castbot'
  } catch {
    return false
  }
}

/** Shown by shutdown and upgrade. The machine stays up. */
export function castbotLifecycleMessage(name: string): string {
  return `castbot owns this machine. cast shutdown and cast upgrade are not available. Remove the local entry with \`cast import --remove ${name}\`.`
}

export function parseCastbotBlob(raw: string): CastbotBlob {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CastbotImportError('The import text is not JSON.')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new CastbotImportError('The import text is not a JSON object.')
  }
  const row = value as Record<string, unknown>
  const name = typeof row.name === 'string' ? row.name.trim() : ''
  const agentId = typeof row.agent_id === 'string' ? row.agent_id.trim() : ''
  const url = typeof row.url === 'string' ? row.url.trim() : ''
  const token = typeof row.token === 'string' ? row.token.trim() : ''
  const provider = typeof row.provider === 'string' ? row.provider.trim() : ''
  if (!AGENT_NAME.test(name)) {
    throw new CastbotImportError('The agent name must start with a letter or number and use only letters, numbers, and hyphens.')
  }
  if (!agentId) {
    throw new CastbotImportError('The import text needs an agent id.')
  }
  if (!token) {
    throw new CastbotImportError('The import text needs a token.')
  }
  if (provider !== 'microvm') {
    throw new CastbotImportError('The import text must name the microvm provider.')
  }
  return {name, agentId, url: canonicalMicrovmUrl(url), token}
}

/** Accept only an https host under the microvm suffix, on port 443. */
export function canonicalMicrovmUrl(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new CastbotImportError('The machine address is not a URL.')
  }
  if (parsed.username || parsed.password) {
    throw new CastbotImportError('The machine address must not include a username or password.')
  }
  if (parsed.protocol !== 'https:') {
    throw new CastbotImportError('The machine address must use https.')
  }
  if (parsed.port !== '' && parsed.port !== '443') {
    throw new CastbotImportError('The machine address must use port 443.')
  }
  const host = parsed.hostname.toLowerCase()
  if (host.endsWith('.')) {
    throw new CastbotImportError('The machine address must be a microvm host name.')
  }
  if (net.isIP(host) !== 0) {
    throw new CastbotImportError('The machine address must be a microvm host name.')
  }
  if (!host.endsWith(HOST_SUFFIX) || host === HOST_SUFFIX.slice(1)) {
    throw new CastbotImportError('The machine address must be a microvm host name.')
  }
  const label = host.slice(0, -HOST_SUFFIX.length)
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(label)) {
    throw new CastbotImportError('The machine address must be a microvm host name.')
  }
  return `https://${host}${parsed.pathname === '/' ? '' : parsed.pathname}`
}

async function dropCastbotRows(name: string): Promise<void> {
  const live = db.listDeployments(name)
  if (live.some((row: {managed_by?: string | null; volume_config?: string | null}) => !isCastbotManaged(row))) {
    throw new CastbotImportError(`'${name}' already has a deployment that castbot does not own.`)
  }
  for (const row of live) {
    if (row.id) await keychain.deleteDeploymentToken(row.id)
    db.removeDeploymentBySha(row.id)
  }
}

/** Write the local deployment and token. A later import of the same name replaces that local row. */
export async function importCastbotBlob(raw: string): Promise<{id: string; name: string}> {
  const blob = parseCastbotBlob(raw)
  await dropCastbotRows(blob.name)
  const id = generateDeploymentSha(blob.name)
  const volume = JSON.stringify({
    authMode: 'dual',
    managedBy: 'castbot',
    agentId: blob.agentId,
  })
  db.ensureAgent(blob.name)
  db.createDeployment(id, blob.name, 'microvm', blob.url, keychain.hashToken(blob.token), null, volume, null)
  db.markDeploymentManaged(id, 'castbot')
  await keychain.setDeploymentToken(id, blob.token)
  return {id, name: blob.name}
}

/** Delete the local row and token. The machine is left running. */
export async function removeCastbotImport(name: string): Promise<void> {
  const trimmed = name.trim()
  if (!AGENT_NAME.test(trimmed)) {
    throw new CastbotImportError('The agent name must start with a letter or number and use only letters, numbers, and hyphens.')
  }
  const live = db.listDeployments(trimmed)
  if (live.length === 0) {
    throw new CastbotImportError(`No castbot entry found for '${trimmed}'.`)
  }
  if (live.some((row: {managed_by?: string | null; volume_config?: string | null}) => !isCastbotManaged(row))) {
    throw new CastbotImportError(`'${trimmed}' is not a castbot entry. The local deployment was left in place.`)
  }
  for (const row of live) {
    if (row.id) await keychain.deleteDeploymentToken(row.id)
    db.removeDeploymentBySha(row.id)
  }
}
