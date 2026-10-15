import {execCommand} from './deploy-utils'

export const CONTAINER_READY_TIMEOUT_MS = 60_000
export const CONTAINER_READY_INTERVAL_MS = 500

export interface ContainerProbe {
  status: string
  logs: string
}

export type ContainerHealthKind = 'ready' | 'failed' | 'pending'

export type ContainerHealthResult =
  | {ok: true}
  | {ok: false; status: string; logs: string; reason: 'exited' | 'timeout'}

/**
 * `docker run -d` returns as soon as the container is created. The runtime
 * is ready only after it is still running and has printed `Agent ready`.
 * An exited container (for example a missing import) is a failed deploy.
 */
export function classifyContainerHealth(probe: ContainerProbe): ContainerHealthKind {
  const status = probe.status.trim().toLowerCase()
  if (status === 'running' && probe.logs.includes('Agent ready')) return 'ready'
  if (
    status === 'exited' || status === 'dead' || status === 'removing' ||
    status === 'missing' || status === 'restarting'
  ) {
    return 'failed'
  }
  if (/ModuleNotFoundError|No module named ['"]cast['"]/.test(probe.logs)) return 'failed'
  return 'pending'
}

export async function waitForContainerHealth(
  probe: () => Promise<ContainerProbe>,
  options?: {
    timeoutMs?: number
    intervalMs?: number
    sleep?: (ms: number) => Promise<void>
    now?: () => number
  },
): Promise<ContainerHealthResult> {
  const timeoutMs = options?.timeoutMs ?? CONTAINER_READY_TIMEOUT_MS
  const intervalMs = options?.intervalMs ?? CONTAINER_READY_INTERVAL_MS
  const sleep = options?.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const now = options?.now ?? (() => Date.now())
  const deadline = now() + timeoutMs
  let last: ContainerProbe = {status: '', logs: ''}

  while (now() <= deadline) {
    last = await probe()
    const kind = classifyContainerHealth(last)
    if (kind === 'ready') return {ok: true}
    if (kind === 'failed') {
      return {ok: false, status: last.status.trim(), logs: last.logs, reason: 'exited'}
    }
    if (now() >= deadline) break
    await sleep(intervalMs)
  }

  return {ok: false, status: last.status.trim(), logs: last.logs, reason: 'timeout'}
}

export async function probeDockerContainer(containerName: string): Promise<ContainerProbe> {
  try {
    const inspect = await execCommand(
      'docker',
      ['inspect', '--format', '{{.State.Status}}', containerName],
      {silent: true, shell: false, timeoutMs: 15_000},
    )
    const logs = await execCommand(
      'docker',
      ['logs', containerName],
      {silent: true, shell: false, timeoutMs: 15_000},
    )
    if (inspect.exitCode !== 0) {
      return {status: 'missing', logs: `${inspect.stderr}${logs.stderr}`}
    }
    return {status: inspect.stdout.trim(), logs: `${logs.stdout}${logs.stderr}`}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {status: 'missing', logs: message}
  }
}

function tail(text: string, maxLines = 80): string {
  const lines = text.trim().split('\n')
  if (lines.length <= maxLines) return text.trim()
  return lines.slice(-maxLines).join('\n').trim()
}

export function containerHealthFailureMessage(
  containerName: string,
  result: {status: string; logs: string; reason: 'exited' | 'timeout'},
): string {
  const status = result.status || 'unknown'
  const normalized = status.toLowerCase()
  const summary = result.reason === 'timeout'
    ? `Docker container '${containerName}' did not become ready (status: ${status}).`
    : normalized === 'restarting'
      ? `Docker container '${containerName}' is restarting and never became ready.`
      : normalized === 'running'
        ? `Docker container '${containerName}' failed before the runtime was ready.`
        : `Docker container '${containerName}' exited before the runtime was ready.`
  const logs = tail(result.logs)
  const parts = [summary, `Status: ${status}`]
  if (logs) parts.push(logs)
  parts.push(`Logs: docker logs ${containerName}`)
  return parts.join('\n')
}
