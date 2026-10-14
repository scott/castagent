import {execCommand} from './deploy/deploy-utils'
import {dockerContainerName} from './runtime-logs'
import {db} from './sqlite'

const DOCKER_RUNNING_STATUSES = new Set(['running', 'restarting', 'paused'])

export interface LocalAgentRecord {
  pid: number
  port: number
}

export interface DeploymentRecord {
  provider: string
}

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface StopAgentDeps {
  getLocalAgent: (name: string) => LocalAgentRecord | null | undefined
  listDeployments: (name: string) => DeploymentRecord[]
  runDocker: (args: string[]) => Promise<CommandResult>
  signal: (pid: number, signal: NodeJS.Signals | 0) => void
  removeLocalAgent: (name: string) => void
  sleep?: (ms: number) => Promise<void>
  /** Called as soon as a progress line is ready. Error lines stay in the result. */
  onLog?: (text: string) => void
  onWarn?: (text: string) => void
}

export type StopMessage =
  | {kind: 'log'; text: string}
  | {kind: 'warn'; text: string}
  | {kind: 'error'; text: string}

export interface StopAgentResult {
  status: 'not_running' | 'stopped' | 'cleaned' | 'timeout' | 'error'
  messages: StopMessage[]
}

export function isDockerContainerRunning(status: string): boolean {
  return DOCKER_RUNNING_STATUSES.has(status.trim().toLowerCase())
}

/** `docker stop` marks the container stopped, so `unless-stopped` does not bring it back. */
export function dockerStopArgs(containerName: string, force: boolean): string[] {
  if (force) return ['stop', '--time', '0', containerName]
  return ['stop', containerName]
}

export function dockerInspectStatusArgs(containerName: string): string[] {
  return ['inspect', '--format', '{{.State.Status}}', containerName]
}

function log(text: string): StopMessage {
  return {kind: 'log', text}
}

function warn(text: string): StopMessage {
  return {kind: 'warn', text}
}

function failure(text: string): StopAgentResult {
  return {status: 'error', messages: [{kind: 'error', text}]}
}

function push(bucket: StopMessage[], message: StopMessage, deps: StopAgentDeps): void {
  bucket.push(message)
  if (message.kind === 'warn') deps.onWarn?.(message.text)
  else if (message.kind === 'log') deps.onLog?.(message.text)
}

function commandDetail(result: CommandResult): string {
  return [result.stderr, result.stdout].map(part => part.trim()).filter(Boolean).join('\n')
}

function missingContainer(result: CommandResult): boolean {
  if (result.exitCode === 0) return false
  return /no such (container|object)/i.test(`${result.stderr}\n${result.stdout}`)
}

export function defaultStopAgentDeps(): StopAgentDeps {
  return {
    getLocalAgent: (name) => {
      const row = db.getLocalAgent(name)
      if (!row) return null
      return {pid: row.pid, port: row.port}
    },
    listDeployments: (name) => db.listDeployments(name),
    runDocker: (args) => execCommand('docker', args, {
      silent: true,
      shell: false,
      timeoutMs: 30_000,
    }),
    signal: (pid, signal) => {
      process.kill(pid, signal)
    },
    removeLocalAgent: (name) => {
      db.removeLocalAgent(name)
    },
  }
}

async function stopLocalAgent(
  agentName: string,
  local: LocalAgentRecord,
  force: boolean,
  deps: StopAgentDeps,
): Promise<StopAgentResult> {
  const {pid, port} = local
  const messages: StopMessage[] = []
  push(messages, log(`Stopping agent '${agentName}' (PID: ${pid}, port: ${port})...`), deps)

  try {
    try {
      deps.signal(pid, 0)
    } catch {
      deps.removeLocalAgent(agentName)
      push(messages, log(`Process ${pid} is not running. Cleaning up database entry.`), deps)
      return {status: 'cleaned', messages}
    }

    deps.signal(pid, force ? 'SIGKILL' : 'SIGTERM')

    const sleep = deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    let stopped = false
    for (let i = 0; i < 50; i++) {
      try {
        deps.signal(pid, 0)
        await sleep(100)
      } catch {
        stopped = true
        break
      }
    }

    if (stopped) {
      deps.removeLocalAgent(agentName)
      push(messages, log(`✓ Agent '${agentName}' stopped successfully.`), deps)
      return {status: 'stopped', messages}
    }

    push(messages, warn(`Agent '${agentName}' did not stop gracefully.`), deps)
    if (!force) push(messages, log('Use --force to kill it immediately.'), deps)
    return {status: 'timeout', messages}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    messages.push({kind: 'error', text: `Failed to stop agent: ${message}`})
    return {status: 'error', messages}
  }
}

/**
 * Stop container `cast-<name>` when a live Docker deployment exists and the
 * container is running. Returns null when there is nothing to stop.
 */
async function stopDockerDeployment(
  agentName: string,
  force: boolean,
  deps: StopAgentDeps,
): Promise<StopAgentResult | null> {
  const dockerRows = deps.listDeployments(agentName).filter(row => row.provider === 'docker')
  if (dockerRows.length === 0) return null

  const container = dockerContainerName(agentName)
  let inspect: CommandResult
  try {
    inspect = await deps.runDocker(dockerInspectStatusArgs(container))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(`Failed to stop agent: ${message}`)
  }

  if (missingContainer(inspect) || (inspect.exitCode === 0 && !isDockerContainerRunning(inspect.stdout))) {
    return null
  }
  if (inspect.exitCode !== 0) {
    const detail = commandDetail(inspect)
    const text = detail
      ? `Failed to stop agent: ${detail}`
      : `Failed to stop agent: docker inspect exited ${inspect.exitCode}`
    return failure(text)
  }

  const messages: StopMessage[] = []
  push(messages, log(`Stopping agent '${agentName}' (Docker container: ${container})...`), deps)
  let stopped: CommandResult
  try {
    stopped = await deps.runDocker(dockerStopArgs(container, force))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    messages.push({kind: 'error', text: `Failed to stop agent: ${message}`})
    return {status: 'error', messages}
  }
  if (stopped.exitCode !== 0) {
    const detail = commandDetail(stopped)
    const text = detail
      ? `Failed to stop agent: ${detail}`
      : `Failed to stop agent: docker stop exited ${stopped.exitCode}`
    messages.push({kind: 'error', text})
    return {status: 'error', messages}
  }

  push(messages, log(`✓ Agent '${agentName}' stopped successfully.`), deps)
  return {status: 'stopped', messages}
}

/**
 * Stop the running agent on this machine.
 *
 * A local `cast dev` process is recorded by PID. A Docker deploy is recorded
 * as a deployment and runs as container `cast-<name>`, with no PID row. When
 * the PID is missing or already gone, stop that container if it is up.
 */
export async function stopAgent(
  agentName: string,
  options: {force?: boolean} = {},
  deps: StopAgentDeps = defaultStopAgentDeps(),
): Promise<StopAgentResult> {
  const force = options.force === true
  const local = deps.getLocalAgent(agentName)
  let cleaned: StopAgentResult | null = null
  if (local) {
    const localResult = await stopLocalAgent(agentName, local, force, deps)
    if (localResult.status !== 'cleaned') return localResult
    cleaned = localResult
  }

  const dockerResult = await stopDockerDeployment(agentName, force, deps)
  if (!dockerResult) {
    if (cleaned) return cleaned
    const messages: StopMessage[] = []
    push(messages, log(`Agent '${agentName}' is not currently running.`), deps)
    return {status: 'not_running', messages}
  }
  if (!cleaned) return dockerResult
  return {
    status: dockerResult.status,
    messages: [...cleaned.messages, ...dockerResult.messages],
  }
}
