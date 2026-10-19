import {Args, Command, Flags} from '@oclif/core'
import {spawn, type ChildProcess} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {db} from '../lib/sqlite'
import {A2AClient, A2AClientError} from '../lib/a2a/client'
import {deploymentAuthFailureReason, missingDeploymentAuthMessage, resolveDeploymentAuthToken, resolveDeploymentTarget} from '../lib/deploy/deploy-utils'
import {deploymentProviderLoadErrors, getDeploymentProvider} from '../lib/deploy/registry'
import {
  checkNeedsProxy as spriteNeedsProxy,
  findAvailablePort as spriteFindAvailablePort,
  resolveSprite as spriteResolveSprite,
  startSpriteProxy as spriteStartProxy,
} from '../lib/deploy/providers/sprites'
import {tuiAuthEnv} from '../lib/session-resume'

export default class Connect extends Command {
  static description = 'Connect to deployed agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> abc123  # Connect by deployment SHA',
  ]

  static args = {
    agent: Args.string({description: 'Agent name or deployment SHA', required: true}),
  }

  static flags = {
    proxy: Flags.boolean({description: 'Use sprite proxy for sprites deployments', default: false}),
    sha: Flags.boolean({description: 'Treat input as deployment SHA (auto-detected)', default: false}),
  }

  async run(): Promise<void> {
    const loadErrors = deploymentProviderLoadErrors()
    if (loadErrors.length > 0) {
      this.error(loadErrors.map(error => error.message).join('\n'))
    }

    const {args, flags} = await this.parse(Connect)
    const target = args.agent

    // Resolve target (SHA or agent name)
    const resolution = await resolveDeploymentTarget(target)

    if (resolution.type === 'not_found') {
      // Check if there's a local agent running
      const localAgent = db.getLocalAgent(target)
      if (localAgent?.port) {
        this.log(`No deployment found for '${target}', but local agent is running on port ${localAgent.port}.`)
        this.log(`Connecting to local agent instead...`)
        await this.launchTui(target, `http://localhost:${localAgent.port}`)
        return
      }

      this.error(resolution.message!)
    }

    if (resolution.type === 'ambiguous') {
      this.error(resolution.message!)
    }

    // resolution.type is 'sha' or 'single'
    const deployment = resolution.deployment!
    const agentName = deployment.agent_name

    this.log(`Connecting to ${agentName}...`)

    if (!deployment.deployment_url) {
      this.error(
        `No deployment URL found for '${target}'.\n\n` +
        `The deployment may be corrupted. Try redeploying with:\n` +
        `  cast deploy ${agentName}`
      )
    }

    let deploymentUrl = deployment.deployment_url
    const provider = deployment.provider
    let token: string | null = await resolveDeploymentAuthToken(deployment)
    if (!token && deployment.auth_token_hash) {
      const reason = await deploymentAuthFailureReason(deployment)
      this.error(missingDeploymentAuthMessage(deployment, reason))
    }
    let edgeToken: string | undefined
    let proxyProcess: ChildProcess | undefined
    let timeoutHint = ''

    const registered = getDeploymentProvider(provider)
    if (registered?.connect) {
      const result = await registered.connect({
        agentName,
        deployment,
        url: deploymentUrl,
        token: token ?? undefined,
        flags: {proxy: flags.proxy},
        log: message => this.log(message),
        warn: message => this.warn(message),
        error: (message: string): never => this.error(message),
      })
      if (result) {
        if (result.url) deploymentUrl = result.url
        if (result.proxyProcess) proxyProcess = result.proxyProcess
        if (result.edgeToken) edgeToken = result.edgeToken
        if (result.timeoutHint) timeoutHint = result.timeoutHint
        if ('token' in result) token = result.token ?? null
      }
    }

    if (!token && !edgeToken) {
      this.warn(`No auth token found for agent '${agentName}'. Connecting without authentication...`)
    }

    // Verify connection before launching TUI
    try {
      const client = new A2AClient(deploymentUrl, token || undefined, edgeToken)
      await client.getAgentCard()
      this.log(`Connection verified: ${deploymentUrl}`)
    } catch (error: any) {
      if (error instanceof A2AClientError) {
        if (error.statusCode === 401 || error.statusCode === 403 || error.code === 'AUTH_FAILED' || error.code === 'FORBIDDEN') {
          this.error(
            `Authentication failed for agent '${agentName}'.\n` +
            `The auth token may be invalid or expired.\n` +
            `Try redeploying the agent to generate a new token.`
          )
        } else if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
          this.error(
            `Cannot connect to agent at ${deploymentUrl}.\n` +
            `The agent may not be running or the URL may be incorrect.\n` +
            `Check the deployment status with your provider.`
          )
        } else if (error.code === 'TIMEOUT') {
          this.error(
            `Connection to ${deploymentUrl} timed out.\n` +
            `The agent may be starting up or unresponsive. Try again in a moment.${timeoutHint}`
          )
        } else {
          this.warn(`Could not verify connection: ${error.message}`)
        }
      } else {
        this.warn(`Could not verify connection: ${error.message}`)
      }
    }

    await this.launchTui(agentName, deploymentUrl, token || undefined, proxyProcess, edgeToken)
  }

  private async checkNeedsProxy(url: string): Promise<boolean> {
    return spriteNeedsProxy(url)
  }

  private async startSpriteProxy(agentName: string, deploymentUrl: string): Promise<{url: string; process: ReturnType<typeof spawn>} | null> {
    return spriteStartProxy(
      agentName,
      deploymentUrl,
      message => this.log(message),
      message => this.warn(message),
    )
  }

  private async findAvailablePort(startPort: number, endPort: number): Promise<number> {
    return spriteFindAvailablePort(startPort, endPort)
  }

  private async launchTui(agentName: string, url: string, token?: string, proxyProcess?: ReturnType<typeof spawn>, edgeToken?: string): Promise<void> {
    this.log(`Deployment URL: ${url}`)

    // Launch OpenTUI
    this.log('Launching OpenTUI...')

    const bunPath = this.resolveBun()
    const tuiPath = path.join(__dirname, '../../../cast-tui/dist/index.js')

    if (!fs.existsSync(tuiPath)) {
      this.warn(`OpenTUI not found at ${tuiPath}`)
      this.log(`Agent endpoint: ${url}`)
      // Clean up proxy if it was started
      if (proxyProcess) {
        proxyProcess.kill()
      }
      return
    }

    const opentuiArgs = [
      tuiPath,
      '--agent', agentName,
      '--url', url,
      '--mode', 'production',
    ]

    const opentui = spawn(bunPath, opentuiArgs, {
      stdio: 'inherit',
      env: tuiAuthEnv(process.env, {token, edgeToken}),
    })

    // Store proxy process reference for cleanup
    const proxy = proxyProcess

    opentui.on('error', (error) => {
      this.error(`Failed to launch OpenTUI: ${error.message}`)
      proxy?.kill()
    })

    opentui.on('exit', (code) => {
      this.log(`OpenTUI exited with code ${code}`)
      if (proxy) {
        this.log('Stopping sprite proxy...')
        proxy.kill()
      }
      process.exit(code || 0)
    })
  }

  private resolveBun(): string {
    const candidates = [
      'bun',
      path.join(os.homedir(), '.bun', 'bin', 'bun'),
      path.join(os.homedir(), '.local', 'bin', 'bun'),
      '/usr/local/bin/bun',
      '/opt/homebrew/bin/bun',
    ]

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    // Fall back to 'bun' and let it fail with proper error if not found
    return 'bun'
  }

  private resolveSprite(): string {
    return spriteResolveSprite()
  }
}
