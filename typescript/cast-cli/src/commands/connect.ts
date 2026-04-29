import {Args, Command} from '@oclif/core'
import {spawn} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'
import {db} from '../lib/sqlite'
import {keychain} from '../lib/keychain'
import {A2AClient, A2AClientError} from '../lib/a2a/client'

export default class Connect extends Command {
  static description = 'Connect to deployed agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(Connect)
    const agentName = args.agent

    this.log(`Connecting to ${agentName}...`)

    // Retrieve deployment info from SQLite
    const deployment = db.getDeployment(agentName)
    if (!deployment || !deployment.deployment_url) {
      // Check if there's a local agent running
      const localAgent = db.getLocalAgent(agentName)
      if (localAgent?.port) {
        this.log(`No deployment found, but local agent is running on port ${localAgent.port}.`)
        this.log(`Connecting to local agent instead...`)
        await this.launchTui(agentName, `http://localhost:${localAgent.port}`)
        return
      }

      this.error(
        `No deployment found for agent '${agentName}'.\n\n` +
        `To fix this:\n` +
        `  1. Deploy the agent: cast deploy ${agentName}\n` +
        `  2. Or start it locally: cast dev ${agentName} --no-tui`
      )
    }

    const deploymentUrl = deployment.deployment_url

    // Retrieve auth token from keychain
    const token = await keychain.getToken(agentName)
    if (!token) {
      this.warn(`No auth token found for agent '${agentName}'. Connecting without authentication...`)
    }

    // Verify connection before launching TUI
    try {
      const client = new A2AClient(deploymentUrl, token || undefined)
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
            `The agent may be starting up or unresponsive. Try again in a moment.`
          )
        } else {
          this.warn(`Could not verify connection: ${error.message}`)
        }
      } else {
        this.warn(`Could not verify connection: ${error.message}`)
      }
    }

    await this.launchTui(agentName, deploymentUrl, token || undefined)
  }

  private async launchTui(agentName: string, url: string, token?: string): Promise<void> {
    this.log(`Deployment URL: ${url}`)

    // Launch OpenTUI
    this.log('Launching OpenTUI...')

    const bunPath = this.resolveBun()
    const tuiPath = path.join(__dirname, '../../../cast-tui/dist/index.js')

    if (!fs.existsSync(tuiPath)) {
      this.warn(`OpenTUI not found at ${tuiPath}`)
      this.log(`Agent endpoint: ${url}`)
      return
    }

    const opentuiArgs = [
      tuiPath,
      '--agent', agentName,
      '--url', url,
      '--mode', 'production',
    ]

    if (token) {
      opentuiArgs.push('--token', token)
    }

    const opentui = spawn(bunPath, opentuiArgs, {
      stdio: 'inherit',
    })

    opentui.on('error', (error) => {
      this.error(`Failed to launch OpenTUI: ${error.message}`)
    })

    opentui.on('exit', (code) => {
      this.log(`OpenTUI exited with code ${code}`)
      process.exit(code || 0)
    })
  }

  private resolveBun(): string {
    const candidates = [
      'bun',
      path.join(os.homedir(), '.bun', 'bin', 'bun'),
      '/usr/local/bin/bun',
      '/opt/homebrew/bin/bun',
    ]

    for (const candidate of candidates) {
      if (candidate === 'bun') {
        return candidate
      }

      if (fs.existsSync(candidate)) {
        return candidate
      }
    }

    return 'node'
  }
}
