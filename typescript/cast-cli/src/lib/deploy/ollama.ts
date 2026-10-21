/**
 * Ollama is local and keyless. A remote host cannot reach the builder's
 * localhost, and base URLs are not forwarded. Docker on this machine is
 * rewritten to host.docker.internal. The optional cloud key stays here.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {resolvedBaseUrl} from '../inference-credentials'
import {loadConfig, loadInferenceCatalog, readAgentModel} from './deploy-utils'

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'
export const OLLAMA_DOCKER_HOST = 'host.docker.internal'

function lookupOllamaBaseUrl(): string {
  const entry = loadInferenceCatalog().find(item => item.key === 'ollama')
  if (!entry) return OLLAMA_DEFAULT_BASE_URL
  return resolvedBaseUrl(entry, loadConfig())
}

function ipv4Octets(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    octets.push(value)
  }
  return octets
}

/**
 * Node's URL parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1].
 * Accept both that form and a dotted mapped address.
 */
function ipv4FromMapped(host: string): number[] | null {
  const dotted = host.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/)
  if (dotted) return ipv4Octets(dotted[1])
  const hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const hi = Number.parseInt(hex[1], 16)
  const lo = Number.parseInt(hex[2], 16)
  if (!Number.isInteger(hi) || !Number.isInteger(lo) || hi > 0xffff || lo > 0xffff) return null
  const value = (hi << 16) | lo
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

/** Loopback for a container on this machine: 127.0.0.0/8, localhost, localhost., ::1, and IPv4-mapped forms. */
export function ollamaDockerHostKind(hostname: string): 'loopback' | 'unspecified' | 'other' {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host === 'localhost.') return 'loopback'
  if (host === '::1') return 'loopback'
  if (host === '0.0.0.0' || host === '::' || host === '::0') return 'unspecified'
  const octets = ipv4Octets(host) ?? ipv4FromMapped(host)
  if (!octets) return 'other'
  if (octets.every(octet => octet === 0)) return 'unspecified'
  if (octets[0] === 127) return 'loopback'
  return 'other'
}

/**
 * Loopback Ollama, as seen from a container on this machine.
 * A non-loopback builder URL is refused: it is not copied into the container.
 * https on loopback is refused so the container does not fail TLS against plain http.
 */
export function ollamaContainerBaseUrl(builderBaseUrl: string): string {
  const raw = (builderBaseUrl || OLLAMA_DEFAULT_BASE_URL).trim()
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(
      `Refusing to deploy an ollama/ model to Docker. The builder Ollama URL ${JSON.stringify(raw)} is not a URL. ` +
      'Use http://localhost:11434/v1.',
    )
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Refusing to deploy an ollama/ model to Docker. The builder Ollama URL must not include userinfo, a query, or a fragment.',
    )
  }
  const kind = ollamaDockerHostKind(url.hostname)
  if (kind === 'unspecified') {
    throw new Error(
      `Refusing to deploy an ollama/ model to Docker. The builder Ollama URL ${raw} uses ${url.hostname}, ` +
      'which is every interface, not a loopback address. Docker rewrites only loopback to host.docker.internal. ' +
      'Point OLLAMA_BASE_URL or providers.ollama.base_url at http://127.0.0.1:11434/v1 or http://localhost:11434/v1.',
    )
  }
  if (kind !== 'loopback') {
    throw new Error(
      `Refusing to deploy an ollama/ model to Docker. The builder Ollama URL ${raw} is not a loopback address ` +
      '(127.0.0.0/8, ::1, localhost, or localhost.). Docker reaches Ollama through host.docker.internal, ' +
      'and a custom base URL is not copied into the container. ' +
      'Point OLLAMA_BASE_URL or providers.ollama.base_url at http://localhost:11434/v1.',
    )
  }
  if (url.protocol !== 'http:') {
    throw new Error(
      `Refusing to deploy an ollama/ model to Docker. Local Ollama speaks plain http, and ${raw} would make the container fail TLS. ` +
      'Use http://localhost:11434/v1.',
    )
  }
  const port = url.port ? `:${url.port}` : ''
  const pathname = url.pathname.replace(/\/+$/, '')
  return `http://${OLLAMA_DOCKER_HOST}${port}${pathname}`
}

/**
 * Linux Docker routes host.docker.internal to the bridge, and Ollama binds
 * 127.0.0.1 unless OLLAMA_HOST says otherwise. Returns null off Linux.
 */
export function ollamaLinuxDockerHint(platform: NodeJS.Platform = process.platform): string | null {
  if (platform !== 'linux') return null
  return (
    'Linux Docker reaches host.docker.internal through the bridge, and Ollama listens on 127.0.0.1 by default, so this container cannot connect. ' +
    'On the host, start Ollama with OLLAMA_HOST=0.0.0.0. That listens on every interface: keep port 11434 off untrusted networks with a firewall. ' +
    'Alternatively set OLLAMA_HOST to the docker0 bridge IP (often 172.17.0.1) so only the bridge can connect.'
  )
}

export function remoteOllamaMessage(providerKey: string, model: string): string {
  return (
    `Refusing to deploy ${model} to ${providerKey}. ` +
    'A remote host cannot reach Ollama on this machine at http://localhost:11434, ' +
    'and Cast does not forward OLLAMA_BASE_URL or OLLAMA_API_KEY. ' +
    'Deploy with --provider docker so the container uses http://host.docker.internal and the host\'s Ollama. ' +
    'The local provider runs on this machine and can use loopback Ollama directly. ' +
    'https://ollama.com is a builder base URL and stays on this machine.'
  )
}

/** Null when this target may run an ollama/ model. Otherwise the refusal text. */
export function ollamaDeployRefusal(
  providerKey: string,
  model: string,
  builderBaseUrl?: string,
): string | null {
  if (!model.startsWith('ollama/')) return null
  if (providerKey === 'local') return null
  if (providerKey === 'docker') {
    try {
      ollamaContainerBaseUrl(builderBaseUrl === undefined ? lookupOllamaBaseUrl() : builderBaseUrl)
      return null
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
  return remoteOllamaMessage(providerKey, model)
}

/**
 * Env for a Docker agent. Drops the cloud key and any builder base URL.
 * Loopback is rewritten to host.docker.internal. Other models are unchanged.
 */
export function ollamaDockerEnvFromBase(
  model: string,
  inference: Record<string, string>,
  builderBaseUrl: string,
): {inference: Record<string, string>; hostGateway: boolean} {
  if (!model.startsWith('ollama/')) return {inference, hostGateway: false}
  const baseUrl = ollamaContainerBaseUrl(builderBaseUrl)
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(inference)) {
    if (key === 'OLLAMA_API_KEY' || key.includes('BASE_URL')) continue
    next[key] = value
  }
  next.OLLAMA_BASE_URL = baseUrl
  return {inference: next, hostGateway: true}
}

function findAgentYaml(root: string): string | null {
  const direct = path.join(root, 'agent.yaml')
  if (fs.existsSync(direct)) return direct
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, {withFileTypes: true})
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) queue.push(full)
      else if (entry.name === 'agent.yaml') return full
    }
  }
  return null
}

/** Read brain.model from a release tarball without writing the agent directory. */
export async function readAgentModelFromTarball(tarballPath: string): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-ollama-model-'))
  try {
    const tar = await import('tar')
    await tar.extract({
      file: tarballPath,
      cwd: tmp,
      filter: (entryPath: string) => {
        const normalized = entryPath.replace(/\\/g, '/').replace(/^\.\//, '')
        return normalized === 'agent.yaml' || normalized.endsWith('/agent.yaml')
      },
    })
    const yamlPath = findAgentYaml(tmp)
    if (!yamlPath) return readAgentModel(tmp)
    return readAgentModel(path.dirname(yamlPath))
  } finally {
    fs.rmSync(tmp, {recursive: true, force: true})
  }
}

/**
 * Model that an upgrade would run, taken from the release tarball when
 * one is present. The agent directory is not modified.
 */
export async function ollamaUpgradeDecision(
  providerKey: string,
  agentPath: string,
  versionTarballPath: string | null,
): Promise<{model: string; refusal: string | null}> {
  const model = versionTarballPath && fs.existsSync(versionTarballPath)
    ? await readAgentModelFromTarball(versionTarballPath)
    : readAgentModel(agentPath)
  return {model, refusal: ollamaDeployRefusal(providerKey, model)}
}

export function prepareOllamaDocker(
  model: string,
  inference: Record<string, string>,
): {inference: Record<string, string>; hostGateway: boolean} {
  if (!model.startsWith('ollama/')) return {inference, hostGateway: false}
  return ollamaDockerEnvFromBase(model, inference, lookupOllamaBaseUrl())
}
