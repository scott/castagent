import {execCommand} from './deploy/deploy-utils'
import {dropletHostFromUrl} from './deploy/digitalocean'
import {
  flyAppName,
  flyMachineStopArgs,
  flyMachinesListArgs,
  flyResourceGone,
  runningFlyMachineIds,
} from './deploy/fly'
import {execDigitalOceanSsh, isIpv4Address} from './deploy/ssh-hostkey'
import {dockerContainerName} from './runtime-logs'
import {db} from './sqlite'

const DOCKER_RUNNING_STATUSES = new Set(['running', 'restarting', 'paused'])

export interface LocalAgentRecord {
  pid: number
  port: number
}

export interface DeploymentRecord {
  provider: string
  deployment_url?: string | null
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
  /** SSH to a droplet. The remote command is a fixed `docker` invocation. */
  runSsh: (ip: string, remoteCmd: string) => Promise<CommandResult>
  /** flyctl argv. The app name is cast-<agent>. Machine ids come from flyctl. */
  runFly: (args: string[]) => Promise<CommandResult>
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

/** Container name on a DigitalOcean droplet. Deploy always uses this name. */
export const DIGITALOCEAN_AGENT_CONTAINER = 'cast-agent'

/**
 * Droplet IPv4 from a deployment URL.
 * Current rows are `https://<ip>`. Older rows are `http://<ip>:8080`.
 */
export function digitalOceanDropletIp(url: string | null | undefined): string {
  if (typeof url !== 'string' || url.trim() === '') {
    throw new Error('DigitalOcean deployment has no droplet address')
  }
  const host = dropletHostFromUrl(url)
  if (!isIpv4Address(host)) {
    throw new Error('DigitalOcean deployment has no IPv4 droplet address')
  }
  return host
}

/** Fixed remote inspect. The agent name and deployment URL are not included. */
export function digitalOceanInspectCommand(): string {
  return `docker inspect --format '{{.State.Status}}' ${DIGITALOCEAN_AGENT_CONTAINER}`
}

/** Fixed remote stop. `--time 0` is the droplet form of `--force`. */
export function digitalOceanStopCommand(force: boolean): string {
  if (force) return `docker stop --time 0 ${DIGITALOCEAN_AGENT_CONTAINER}`
  return `docker stop ${DIGITALOCEAN_AGENT_CONTAINER}`
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
    runSsh: (ip, remoteCmd) => execDigitalOceanSsh(ip, remoteCmd, {
      silent: true,
      timeoutMs: 30_000,
    }),
    runFly: (args) => execCommand('flyctl', args, {
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
 * Stop container `cast-agent` on the newest DigitalOcean droplet deployment.
 * Returns null when there is no droplet deployment, or the container is not up.
 * A missing host key or a failed SSH session is an error, not "not running".
 */
async function stopDigitalOceanDeployment(
  agentName: string,
  force: boolean,
  deps: StopAgentDeps,
): Promise<StopAgentResult | null> {
  const row = deps.listDeployments(agentName).find(item => item.provider === 'digitalocean')
  if (!row) return null

  let ip: string
  try {
    ip = digitalOceanDropletIp(row.deployment_url)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(`Failed to stop agent: ${message}`)
  }

  let inspect: CommandResult
  try {
    inspect = await deps.runSsh(ip, digitalOceanInspectCommand())
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
      : `Failed to stop agent: ssh exited ${inspect.exitCode}`
    return failure(text)
  }

  const messages: StopMessage[] = []
  const container = DIGITALOCEAN_AGENT_CONTAINER
  push(messages, log(`Stopping agent '${agentName}' (DigitalOcean droplet ${ip}, container ${container})...`), deps)
  let stopped: CommandResult
  try {
    stopped = await deps.runSsh(ip, digitalOceanStopCommand(force))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    messages.push({kind: 'error', text: `Failed to stop agent: ${message}`})
    return {status: 'error', messages}
  }
  if (stopped.exitCode !== 0) {
    const detail = commandDetail(stopped)
    const text = detail
      ? `Failed to stop agent: ${detail}`
      : `Failed to stop agent: ssh exited ${stopped.exitCode}`
    messages.push({kind: 'error', text})
    return {status: 'error', messages}
  }

  push(messages, log(`✓ Agent '${agentName}' stopped successfully.`), deps)
  return {status: 'stopped', messages}
}

/**
 * Stop started Fly machines for `cast-<name>`.
 * Returns null when there is no Fly deployment, or no machine is running.
 */
async function stopFlyDeployment(
  agentName: string,
  force: boolean,
  deps: StopAgentDeps,
): Promise<StopAgentResult | null> {
  const row = deps.listDeployments(agentName).find(item => item.provider === 'fly')
  if (!row) return null

  const appName = flyAppName(agentName)
  let listed: CommandResult
  try {
    listed = await deps.runFly(flyMachinesListArgs(appName))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(`Failed to stop agent: ${message}`)
  }

  if (flyResourceGone(listed.stdout, listed.stderr)) return null
  if (listed.exitCode !== 0) {
    const detail = commandDetail(listed)
    const text = detail
      ? `Failed to stop agent: ${detail}`
      : `Failed to stop agent: flyctl exited ${listed.exitCode}`
    return failure(text)
  }

  let machineIds: string[]
  try {
    machineIds = runningFlyMachineIds(listed.stdout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return failure(`Failed to stop agent: ${message}`)
  }
  if (machineIds.length === 0) return null

  const messages: StopMessage[] = []
  push(messages, log(`Stopping agent '${agentName}' (Fly app ${appName})...`), deps)
  for (const machineId of machineIds) {
    let stopped: CommandResult
    try {
      stopped = await deps.runFly(flyMachineStopArgs(machineId, appName, force))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      messages.push({kind: 'error', text: `Failed to stop agent: ${message}`})
      return {status: 'error', messages}
    }
    if (stopped.exitCode !== 0 && !flyResourceGone(stopped.stdout, stopped.stderr)) {
      const detail = commandDetail(stopped)
      const text = detail
        ? `Failed to stop agent: ${detail}`
        : `Failed to stop agent: flyctl exited ${stopped.exitCode}`
      messages.push({kind: 'error', text})
      return {status: 'error', messages}
    }
  }

  push(messages, log(`✓ Agent '${agentName}' stopped successfully.`), deps)
  return {status: 'stopped', messages}
}

/**
 * Stop the running agent.
 *
 * A local `cast dev` process is recorded by PID. A Docker deploy runs as
 * container `cast-<name>` on this machine. A DigitalOcean droplet deploy
 * runs as container `cast-agent` on the droplet. A Fly deploy runs as
 * machines on `cast-<name>`. A live local process is stopped on its own.
 * When that process is missing or already gone, stop the local Docker
 * container if it is up. When that container is not running, stop the
 * droplet container if it is up. When that container is not running, stop
 * Fly machines that are started.
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
  const dropletResult = dockerResult ? null : await stopDigitalOceanDeployment(agentName, force, deps)
  const flyResult = dockerResult || dropletResult ? null : await stopFlyDeployment(agentName, force, deps)
  const remote = dockerResult ?? dropletResult ?? flyResult
  if (!remote) {
    if (cleaned) return cleaned
    const messages: StopMessage[] = []
    push(messages, log(`Agent '${agentName}' is not currently running.`), deps)
    return {status: 'not_running', messages}
  }
  if (!cleaned) return remote
  return {
    status: remote.status,
    messages: [...cleaned.messages, ...remote.messages],
  }
}
