/**
 * Ollama is local and keyless. A remote host cannot reach the builder's
 * localhost, and base URLs are not forwarded. Docker on this machine is
 * rewritten to host.docker.internal. The optional cloud key stays here.
 */
import {isLoopbackInferenceHost, resolvedBaseUrl} from '../inference-credentials'
import {loadConfig, loadInferenceCatalog} from './deploy-utils'

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1'
export const OLLAMA_DOCKER_HOST = 'host.docker.internal'

function lookupOllamaBaseUrl(): string {
  const entry = loadInferenceCatalog().find(item => item.key === 'ollama')
  if (!entry) return OLLAMA_DEFAULT_BASE_URL
  return resolvedBaseUrl(entry, loadConfig())
}

/**
 * Loopback Ollama, as seen from a container on this machine.
 * A non-loopback builder URL is refused: it is not copied into the container.
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
  if (!isLoopbackInferenceHost(url.hostname)) {
    throw new Error(
      `Refusing to deploy an ollama/ model to Docker. The builder Ollama URL ${raw} is not a loopback address ` +
      '(127.0.0.1, ::1, or localhost). Docker reaches Ollama through host.docker.internal, ' +
      'and a custom base URL is not copied into the container. ' +
      'Point OLLAMA_BASE_URL or providers.ollama.base_url at http://localhost:11434/v1.',
    )
  }
  const port = url.port ? `:${url.port}` : ''
  const pathname = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${OLLAMA_DOCKER_HOST}${port}${pathname}`
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

export function prepareOllamaDocker(
  model: string,
  inference: Record<string, string>,
): {inference: Record<string, string>; hostGateway: boolean} {
  if (!model.startsWith('ollama/')) return {inference, hostGateway: false}
  return ollamaDockerEnvFromBase(model, inference, lookupOllamaBaseUrl())
}
