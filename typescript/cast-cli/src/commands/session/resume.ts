import {Command, Args} from '@oclif/core'
import {spawn, type ChildProcess} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {getSession} from '../../lib/sessions'
import {db} from '../../lib/sqlite'
import {resolveCastPythonRuntime} from '../../lib/cast-python'
import {deploymentAuthFailureReason, missingDeploymentAuthMessage, resolveDeploymentAuthToken, resolveDeploymentTarget} from '../../lib/deploy/deploy-utils'
import {deploymentProviderLoadErrors, getDeploymentProvider} from '../../lib/deploy/registry'
import type {DeploymentRow} from '../../lib/deploy/types'
import {
  buildTuiArgs,
  devRuntimeArgs,
  tuiAuthEnv,
  isTcpPortOpen,
  normalizeResumeUiMode,
  planSessionResume,
  pythonModuleDirForCommand,
  resolveBun,
  resolveTuiEntry,
  takeAgentReadyPort,
  tuiEntryCandidates,
  type ResumeUiMode,
} from '../../lib/session-resume'
import {attachRuntimeLog} from '../../lib/runtime-logs'

/**
 * Open the TUI on a saved session.
 *
 * Launches cast-tui through bun, with --agent, --url, --mode, and
 * --session, the same way `cast dev` and `cast connect` start a chat.
 */
export default class SessionResume extends Command {
  static description = 'Resume a session in the TUI'

  static examples = [
    '<%= config.bin %> <%= command.id %> 01JABC…',
    '<%= config.bin %> <%= command.id %> my-session',
  ]

  static args = {
    identifier: Args.string({
      description: 'Session id (or name)',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(SessionResume)
    const sess = await getSession(args.identifier)
    if (!sess) {
      this.error(`Session not found: ${args.identifier}`)
    }

    const agentPath = path.join(os.homedir(), '.cast', 'agents', sess.agent_name)
    const mode = normalizeResumeUiMode(sess.ui_mode)
    const localUrl = mode === 'dev' && fs.existsSync(agentPath)
      ? await this.runningLocalUrl(sess.agent_name)
      : null
    const deployment = await this.lookupDeployment(sess.agent_name, mode)

    const plan = planSessionResume({
      session: {
        id: sess.id,
        agent_name: sess.agent_name,
        ui_mode: sess.ui_mode,
      },
      agentExists: fs.existsSync(agentPath),
      agentPath,
      localUrl,
      deploymentUrl: deployment?.deployment_url ?? null,
      deploymentError: deployment?.error ?? null,
      deploymentProvider: deployment?.row?.provider ?? null,
      token: deployment?.token ?? null,
      onHostUrl: process.env.CAST_A2A_URL ?? null,
    })

    if (plan.action === 'error') {
      this.error(plan.message)
    }

    const tuiPath = resolveTuiEntry(__dirname)
    if (!tuiPath) {
      const expected = tuiEntryCandidates(__dirname)[0]
      this.error(`Could not locate the cast TUI at ${expected}. Build it with: npm run build:tui`)
    }

    this.log(`Resuming session ${sess.id} for agent '${sess.agent_name}'...`)

    if (plan.action === 'start-dev') {
      await this.startDevAndLaunch(plan.agentName, plan.agentPath, plan.sessionId, tuiPath)
      return
    }

    let url = plan.url
    let token = plan.token
    let edgeToken: string | undefined
    let proxy: ChildProcess | undefined
    if (plan.connectProvider && deployment?.row) {
      const connected = await this.applyDeploymentConnect(deployment.row, url, token)
      url = connected.url
      token = connected.token
      edgeToken = connected.edgeToken
      proxy = connected.proxy
    }

    await this.launchTui({
      tuiPath,
      agentName: plan.agentName,
      sessionId: plan.sessionId,
      url,
      mode: plan.mode,
      token,
      edgeToken,
      proxy,
    })
  }

  private async runningLocalUrl(agentName: string): Promise<string | null> {
    const local = db.getLocalAgent(agentName)
    const port = typeof local?.port === 'number' ? local.port : Number(local?.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
    if (!(await isTcpPortOpen(port))) return null
    return `http://localhost:${port}`
  }

  private async lookupDeployment(agentName: string, mode: ResumeUiMode): Promise<{
    row: DeploymentRow | null
    token: string | null
    error: string | null
    deployment_url: string | null
  } | null> {
    const needsDeployment = mode === 'production' || (mode === 'on-host' && !process.env.CAST_A2A_URL?.trim())
    if (!needsDeployment) return null

    if (mode === 'production') {
      const loadErrors = deploymentProviderLoadErrors()
      if (loadErrors.length > 0) {
        this.error(loadErrors.map(error => error.message).join('\n'))
      }
    }

    const resolution = resolveDeploymentTarget(agentName)
    if (resolution.type !== 'sha' && resolution.type !== 'single') {
      // On-host resume without CAST_A2A_URL explains the missing URL itself.
      // An ambiguous deployment still has to be reported here.
      const error = resolution.type === 'ambiguous' || mode === 'production'
        ? (resolution.message ?? `No deployment found for '${agentName}'. Use 'cast deploy' to deploy.`)
        : null
      return {
        row: null,
        token: null,
        error,
        deployment_url: null,
      }
    }

    const row = resolution.deployment as DeploymentRow
    const token = await resolveDeploymentAuthToken(row)
    return {
      row,
      token,
      error: null,
      deployment_url: row.deployment_url ?? null,
    }
  }

  private async applyDeploymentConnect(
    deployment: DeploymentRow,
    url: string,
    token: string | null,
  ): Promise<{url: string; token: string | null; edgeToken?: string; proxy?: ChildProcess}> {
    if (!token && deploymentHasAuthHash(deployment)) {
      const reason = await deploymentAuthFailureReason(deployment)
      this.error(missingDeploymentAuthMessage(deployment, reason))
    }

    let nextUrl = url
    let nextToken = token
    let edgeToken: string | undefined
    let proxy: ChildProcess | undefined
    const registered = getDeploymentProvider(deployment.provider)
    if (registered?.connect) {
      const result = await registered.connect({
        agentName: deployment.agent_name,
        deployment,
        url,
        token: token ?? undefined,
        flags: {proxy: false},
        log: message => this.log(message),
        warn: message => this.warn(message),
        error: (message: string): never => this.error(message),
      })
      if (result) {
        if (result.url) nextUrl = result.url
        if (result.proxyProcess) proxy = result.proxyProcess
        if (result.edgeToken) edgeToken = result.edgeToken
        if ('token' in result) nextToken = result.token ?? null
      }
    }

    if (!nextToken && !edgeToken) {
      this.warn(`No auth token found for agent '${deployment.agent_name}'. Connecting without authentication...`)
    }

    return {url: nextUrl, token: nextToken, edgeToken, proxy}
  }

  private async startDevAndLaunch(agentName: string, agentPath: string, sessionId: string, tuiPath: string): Promise<void> {
    const python = resolveCastPythonRuntime(pythonModuleDirForCommand(__dirname))
    if (python.command === 'python3' || python.command === 'python') {
      this.warn('Python virtual environment not found at python/.venv/')
      this.warn('Falling back to system python3. Some features may not work correctly.')
    }

    this.log(`Starting ${agentName} in development mode...`)
    const runtime = spawn(python.command, devRuntimeArgs(agentPath, 0), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CAST_AGENT_NAME: agentName,
        PYTHONPATH: python.pythonPath,
      },
    })
    attachRuntimeLog(agentName, runtime)

    let agentPort: number | null = null
    try {
      agentPort = await waitForAgentPort(runtime)
    } catch (error) {
      if (!runtime.killed) runtime.kill('SIGTERM')
      const message = error instanceof Error ? error.message : String(error)
      this.error(message)
    }

    db.setLocalAgent(agentName, runtime.pid || 0, agentPort)
    this.log(`Agent running on http://localhost:${agentPort}`)

    runtime.on('close', (code) => {
      db.removeLocalAgent(agentName)
      if (code !== 0 && code !== null) {
        this.log(`Agent exited with code ${code}`)
      }
    })

    await this.launchTui({
      tuiPath,
      agentName,
      sessionId,
      url: `http://localhost:${agentPort}`,
      mode: 'dev',
      runtime,
    })
  }

  private async launchTui(opts: {
    tuiPath: string
    agentName: string
    sessionId: string
    url: string
    mode: ResumeUiMode
    token?: string | null
    edgeToken?: string
    proxy?: ChildProcess
    runtime?: ChildProcess
  }): Promise<void> {
    this.log('Launching OpenTUI...')
    process.stdin.pause()

    const opentui = spawn(resolveBun(), buildTuiArgs({
      tuiPath: opts.tuiPath,
      agentName: opts.agentName,
      url: opts.url,
      mode: opts.mode,
      sessionId: opts.sessionId,
    }), {
      stdio: 'inherit',
      detached: false,
      env: tuiAuthEnv(process.env, {token: opts.token, edgeToken: opts.edgeToken}),
    })

    const stopChildren = () => {
      opts.proxy?.kill()
      if (opts.runtime && !opts.runtime.killed) {
        db.removeLocalAgent(opts.agentName)
        opts.runtime.kill('SIGTERM')
      }
    }

    opentui.on('error', (error) => {
      this.warn(`Failed to launch TUI: ${error.message}`)
      if (opts.runtime) {
        this.log(`Agent is still running at ${opts.url}`)
        return
      }
      stopChildren()
      process.exit(1)
    })

    opentui.on('exit', (code) => {
      this.log(`OpenTUI exited with code ${code}`)
      process.stdin.resume()
      stopChildren()
      process.exit(code ?? 0)
    })

    if (opts.runtime) {
      process.on('SIGINT', () => {
        this.log('\nShutting down agent...')
        stopChildren()
      })
    }

    await new Promise(() => {})
  }
}

function deploymentHasAuthHash(deployment: DeploymentRow): boolean {
  const row = deployment as DeploymentRow & {auth_token_hash?: string | null}
  return Boolean(row.auth_token_hash)
}

export function waitForAgentPort(runtime: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let settled = false
    let pending = ''
    const finish = (port: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(port)
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(message))
    }

    const timer = setTimeout(() => {
      fail('Agent failed to start within 30 seconds. Check the output above for errors.')
    }, 30000)

    runtime.stdout?.on('data', (data: Buffer) => {
      pending += data.toString()
      const parsed = takeAgentReadyPort(pending)
      pending = parsed.leftover
      if (settled) return
      if (parsed.logs) process.stdout.write(parsed.logs)
      if (parsed.port !== null) finish(parsed.port)
    })

    runtime.on('error', (error) => {
      fail(`Failed to start Python runtime: ${error.message}`)
    })

    runtime.on('close', (code) => {
      const trailing = takeAgentReadyPort(`${pending}\n`)
      if (trailing.port !== null) {
        finish(trailing.port)
        return
      }
      fail(`Agent exited with code ${code ?? 'null'} before it was ready.`)
    })
  })
}
