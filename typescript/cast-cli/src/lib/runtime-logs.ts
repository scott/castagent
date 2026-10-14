import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execCommand, isShaPattern} from './deploy/deploy-utils'
import {db} from './sqlite'

const AGENT_NAME = /^[a-zA-Z0-9-]+$/

export function defaultLogsDir(): string {
  return path.join(os.homedir(), '.cast', 'logs')
}

export function localRuntimeLogPath(agentName: string, logsDir = defaultLogsDir()): string {
  return path.join(logsDir, `${agentName}.log`)
}

export function dockerContainerName(agentName: string): string {
  return `cast-${agentName}`
}

export function resetLocalRuntimeLog(agentName: string, logsDir = defaultLogsDir()): void {
  const file = localRuntimeLogPath(agentName, logsDir)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, '')
}

export function appendLocalRuntimeLog(
  agentName: string,
  chunk: Buffer | string,
  logsDir = defaultLogsDir(),
): void {
  const file = localRuntimeLogPath(agentName, logsDir)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.appendFileSync(file, chunk)
}

export function readLocalRuntimeLog(agentName: string, logsDir = defaultLogsDir()): string | null {
  const file = localRuntimeLogPath(agentName, logsDir)
  if (!fs.existsSync(file)) return null
  return fs.readFileSync(file, 'utf8')
}

export interface RuntimeLogStreams {
  stdout?: {on(event: 'data', listener: (chunk: Buffer | string) => void): unknown} | null
  stderr?: {on(event: 'data', listener: (chunk: Buffer | string) => void): unknown} | null
}

/**
 * Save a local runtime's stdout and stderr. stderr is also mirrored to the
 * terminal that started the process. `cast logs` reads the saved file.
 */
export function attachRuntimeLog(
  agentName: string,
  runtime: RuntimeLogStreams,
  options?: {
    logsDir?: string
    writeStderr?: (chunk: Buffer | string) => void
  },
): void {
  const logsDir = options?.logsDir
  const writeStderr = options?.writeStderr ?? ((chunk: Buffer | string) => {
    process.stderr.write(chunk)
  })
  resetLocalRuntimeLog(agentName, logsDir)
  runtime.stdout?.on('data', (chunk) => {
    appendLocalRuntimeLog(agentName, chunk, logsDir)
  })
  runtime.stderr?.on('data', (chunk) => {
    appendLocalRuntimeLog(agentName, chunk, logsDir)
    writeStderr(chunk)
  })
}

export function joinProcessOutput(stdout: string, stderr: string): string {
  if (!stdout) return stderr
  if (!stderr) return stdout
  return stdout.endsWith('\n') ? `${stdout}${stderr}` : `${stdout}\n${stderr}`
}

export interface RuntimeDeployment {
  id: string
  agent_name: string
  provider: string
  deployment_url: string
}

export interface RuntimeLogResult {
  status: 'ok' | 'error'
  text: string
}

export interface DockerLogResult {
  stdout: string
  stderr: string
  exitCode: number
}

export interface RuntimeLogDeps {
  getDeploymentBySha: (id: string) => RuntimeDeployment | undefined | null
  listDeployments: (agentName: string) => RuntimeDeployment[]
  readLocalLog: (agentName: string) => string | null
  dockerLogs: (containerName: string) => Promise<DockerLogResult>
}

export function defaultRuntimeLogDeps(): RuntimeLogDeps {
  return {
    getDeploymentBySha: (id) => db.getDeploymentBySha(id) ?? null,
    listDeployments: (agentName) => db.listDeployments(agentName),
    readLocalLog: (agentName) => readLocalRuntimeLog(agentName),
    dockerLogs: async (containerName) => execCommand('docker', ['logs', containerName], {
      silent: true,
      shell: false,
      timeoutMs: 30_000,
    }),
  }
}

function chooseDeployment(
  rows: RuntimeDeployment[],
  label: string,
): {kind: 'none'} | {kind: 'one'; row: RuntimeDeployment} | {kind: 'ambiguous'; text: string} {
  if (rows.length === 0) return {kind: 'none'}
  const unique = new Set(rows.map(row => `${row.provider}|${row.deployment_url}`))
  if (unique.size === 1) return {kind: 'one', row: rows[0]}
  const shaList = rows.map(row => row.id).join(', ')
  return {
    kind: 'ambiguous',
    text: `Multiple deployments found for '${label}'. Use SHA: ${shaList}`,
  }
}

async function readDockerLogs(container: string, deps: RuntimeLogDeps): Promise<RuntimeLogResult> {
  let result: DockerLogResult
  try {
    result = await deps.dockerLogs(container)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'error',
      text: `Could not read Docker logs for container '${container}'.\n${message}`,
    }
  }
  if (result.exitCode !== 0) {
    const detail = [result.stderr, result.stdout].map(part => part.trim()).filter(Boolean).join('\n')
    return {
      status: 'error',
      text: detail
        ? `Could not read Docker logs for container '${container}'.\n${detail}`
        : `Could not read Docker logs for container '${container}'.`,
    }
  }
  const body = joinProcessOutput(result.stdout, result.stderr)
  if (!body.trim()) {
    return {status: 'ok', text: `No log output for Docker container '${container}'.`}
  }
  return {status: 'ok', text: body}
}

function readLocalLogs(agentName: string, deps: RuntimeLogDeps): RuntimeLogResult {
  const text = deps.readLocalLog(agentName)
  if (text === null) {
    return {
      status: 'error',
      text: `No local runtime logs for '${agentName}'. Start it with cast dev so stdout and stderr are recorded.`,
    }
  }
  if (!text.trim()) {
    return {status: 'ok', text: `No log output for local agent '${agentName}'.`}
  }
  return {status: 'ok', text}
}

export async function collectRuntimeLogs(
  target: string,
  deps: RuntimeLogDeps = defaultRuntimeLogDeps(),
): Promise<RuntimeLogResult> {
  if (!AGENT_NAME.test(target)) {
    return {status: 'error', text: `Invalid agent name '${target}'.`}
  }

  let deployment: RuntimeDeployment | undefined
  if (isShaPattern(target)) {
    const bySha = deps.getDeploymentBySha(target)
    if (bySha) deployment = bySha
  }
  if (!deployment) {
    const chosen = chooseDeployment(deps.listDeployments(target), target)
    if (chosen.kind === 'ambiguous') return {status: 'error', text: chosen.text}
    if (chosen.kind === 'one') deployment = chosen.row
  }

  if (!deployment) return readLocalLogs(target, deps)

  if (!AGENT_NAME.test(deployment.agent_name)) {
    return {status: 'error', text: `Invalid agent name '${deployment.agent_name}'.`}
  }
  if (deployment.provider === 'docker') {
    return readDockerLogs(dockerContainerName(deployment.agent_name), deps)
  }
  return {
    status: 'error',
    text: `cast logs cannot read ${deployment.provider} logs for '${deployment.agent_name}'. It reads local runtime output and Docker container logs.`,
  }
}
