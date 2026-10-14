import * as fs from 'fs'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'

export type ResumeUiMode = 'dev' | 'production' | 'on-host'

export interface ResumeSessionRef {
  id: string
  agent_name: string
  ui_mode: string | null
}

export interface ResumePlanInput {
  session: ResumeSessionRef
  agentExists: boolean
  agentPath: string
  /** Set when a local dev agent is accepting connections. */
  localUrl: string | null
  deploymentUrl: string | null
  /** Ambiguous or missing deployment message. Used when a deployment URL is required. */
  deploymentError: string | null
  deploymentProvider: string | null
  token: string | null
  /** CAST_A2A_URL, set when resume runs where the on-host agent is listening. */
  onHostUrl: string | null
}

export type ResumePlan =
  | {
      action: 'launch'
      agentName: string
      sessionId: string
      url: string
      mode: ResumeUiMode
      token: string | null
      /** Run the deployment provider connect hook (sprite proxy, MicroVM edge token). */
      connectProvider: boolean
    }
  | {
      action: 'start-dev'
      agentName: string
      sessionId: string
      agentPath: string
    }
  | {
      action: 'error'
      message: string
    }

/**
 * Decide how `cast session resume` reaches the agent.
 *
 * Dev sessions use a local runtime. Production sessions use the
 * deployment. On-host sessions prefer CAST_A2A_URL, then the deployment.
 */
export function planSessionResume(input: ResumePlanInput): ResumePlan {
  const session = input.session
  const mode = normalizeResumeUiMode(session.ui_mode)
  const base = {
    agentName: session.agent_name,
    sessionId: session.id,
  }

  if (mode === 'dev' && !input.agentExists) {
    return {
      action: 'error',
      message: `Agent '${session.agent_name}' not found at ${input.agentPath}.`,
    }
  }

  if (mode === 'production') {
    return planDeploymentLaunch(input, 'production')
  }

  if (mode === 'on-host') {
    const onHostUrl = input.onHostUrl?.trim()
    if (onHostUrl) {
      return {
        action: 'launch',
        ...base,
        url: onHostUrl,
        mode: 'on-host',
        token: null,
        connectProvider: false,
      }
    }
    if (input.deploymentUrl?.trim()) {
      return planDeploymentLaunch(input, 'production')
    }
    if (input.deploymentError) {
      return {action: 'error', message: input.deploymentError}
    }
    return {
      action: 'error',
      message:
        `Session '${session.id}' was started on-host, but no agent URL is available. ` +
        `Set CAST_A2A_URL or deploy '${session.agent_name}'.`,
    }
  }

  if (input.localUrl) {
    return {
      action: 'launch',
      ...base,
      url: input.localUrl,
      mode: 'dev',
      token: null,
      connectProvider: false,
    }
  }

  return {
    action: 'start-dev',
    ...base,
    agentPath: input.agentPath,
  }
}

function planDeploymentLaunch(input: ResumePlanInput, mode: 'production'): ResumePlan {
  const session = input.session
  const url = input.deploymentUrl?.trim()
  if (!url) {
    if (input.deploymentError) {
      return {action: 'error', message: input.deploymentError}
    }
    return {
      action: 'error',
      message:
        `No deployment URL found for '${session.agent_name}'.\n\n` +
        `The deployment may be corrupted. Try redeploying with:\n` +
        `  cast deploy ${session.agent_name}`,
    }
  }
  return {
    action: 'launch',
    agentName: session.agent_name,
    sessionId: session.id,
    url,
    mode,
    token: input.token,
    connectProvider: true,
  }
}

export function normalizeResumeUiMode(uiMode: string | null | undefined): ResumeUiMode {
  if (uiMode === 'production' || uiMode === 'on-host') return uiMode
  return 'dev'
}

/**
 * Arguments after the bun executable. The first entry is the TUI script.
 * The TUI reads flags from process.argv.slice(2), so --session is a flag
 * on cast-tui, paired with the session id.
 */
export function buildTuiArgs(opts: {
  tuiPath: string
  agentName: string
  url: string
  mode: ResumeUiMode
  sessionId: string
  token?: string | null
  edgeToken?: string | null
}): string[] {
  const args = [
    opts.tuiPath,
    '--agent', opts.agentName,
    '--url', opts.url,
    '--mode', opts.mode,
    '--session', opts.sessionId,
  ]
  if (opts.token) {
    args.push('--token', opts.token)
  }
  if (opts.edgeToken) {
    args.push('--edge-token', opts.edgeToken)
  }
  return args
}

export function devRuntimeArgs(agentPath: string, port: number): string[] {
  return ['-m', 'cast.runtime', '--agent-path', agentPath, '--port', String(port)]
}

/**
 * Pull "Agent ready on port N" out of a stdout buffer. Incomplete trailing
 * text stays in leftover so a port split across reads is still recognized.
 */
export function takeAgentReadyPort(buffer: string): {port: number | null; leftover: string; logs: string} {
  let port: number | null = null
  let leftover = buffer
  let logs = ''
  while (true) {
    const newline = leftover.indexOf('\n')
    if (newline === -1) break
    const line = leftover.slice(0, newline).replace(/\r$/, '')
    leftover = leftover.slice(newline + 1)
    const match = line.match(/Agent ready on port (\d+)/)
    if (match) {
      port = parseInt(match[1], 10)
    } else if (line.trim()) {
      logs += `${line}\n`
    }
  }
  return {port, leftover, logs}
}

export function resolveBun(homeDir: string = os.homedir(), exists: (candidate: string) => boolean = fs.existsSync): string {
  const candidates = [
    path.join(homeDir, '.bun', 'bin', 'bun'),
    path.join(homeDir, '.local', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return 'bun'
}

/**
 * cast-tui dist next to this checkout. `commandDir` is the session
 * command directory (src or dist), one level below commands/.
 */
export function resolveTuiEntry(commandDir: string, exists: (candidate: string) => boolean = fs.existsSync): string | null {
  for (const candidate of tuiEntryCandidates(commandDir)) {
    if (exists(candidate)) return candidate
  }
  return null
}

export function tuiEntryCandidates(commandDir: string): string[] {
  return [
    path.resolve(commandDir, '../../../../cast-tui/dist/index.js'),
    path.resolve(commandDir, '../../../cast-tui/dist/index.js'),
  ]
}

/** Directory at the same depth as cast-cli src/lib, for resolveCastPythonRuntime. */
export function pythonModuleDirForCommand(commandDir: string): string {
  return path.resolve(commandDir, '../../lib')
}

export function isTcpPortOpen(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({port, host: '127.0.0.1'})
    let settled = false
    const finish = (open: boolean) => {
      if (settled) return
      settled = true
      socket.removeAllListeners()
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}
