import {Args, Command, Flags} from '@oclif/core'
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

  static flags = {
    proxy: Flags.boolean({description: 'Use sprite proxy for sprites deployments', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Connect)
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

    let deploymentUrl = deployment.deployment_url
    const provider = deployment.provider
    const token = await keychain.getToken(agentName)
    let proxyProcess: ReturnType<typeof spawn> | undefined

    if (!token) {
      this.warn(`No auth token found for agent '${agentName}'. Connecting without authentication...`)
    }

    // For sprites deployments, use proxy if public access is blocked
    if (provider === 'sprites') {
      // Check if sprite proxy is available and if public access works
      const needsProxy = await this.checkNeedsProxy(deploymentUrl)
      if (needsProxy || flags.proxy) {
        this.log('Sprites auth detected. Starting local proxy...')
        const proxyResult = await this.startSpriteProxy(agentName, deploymentUrl)
        if (proxyResult) {
          deploymentUrl = proxyResult.url
          proxyProcess = proxyResult.process
          this.log(`Proxy started at ${deploymentUrl}`)
        } else {
          this.warn('Failed to start sprite proxy. Trying direct connection...')
        }
      }
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

    await this.launchTui(agentName, deploymentUrl, token || undefined, proxyProcess)
  }

  private async checkNeedsProxy(url: string): Promise<boolean> {
    try {
      const client = new A2AClient(url)
      await client.getAgentCard()
      return false
    } catch (error: any) {
      // If we get a redirect or auth error, we need proxy
      if (error instanceof A2AClientError) {
        if (error.statusCode === 302 || error.message?.includes('Unsupported protocol')) {
          return true
        }
      }
      return false
    }
  }

  private async startSpriteProxy(agentName: string, deploymentUrl: string): Promise<{url: string; process: ReturnType<typeof spawn>} | null> {
    const localPort = await this.findAvailablePort(8500, 9000)
    const spriteName = `cast-${agentName}`

    this.log(`Starting sprite proxy for ${spriteName} on port ${localPort}...`)

    // Use LOCAL:REMOTE syntax to map localhost:${localPort} -> remote:8080
    const proxyProcess = spawn('sprite', ['proxy', `${localPort}:8080`, '-s', spriteName], {
      stdio: 'pipe',
    })

    let proxyError = ''
    proxyProcess.stderr?.on('data', (data: Buffer) => {
      proxyError += data.toString()
    })

    // Wait for proxy to be ready (or fail)
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // Check if proxy failed
    if (proxyError.includes('address already in use')) {
      this.warn(`Port ${localPort} is already in use. Killing old proxy...`)
      proxyProcess.kill()
      // Try one more time with a different port
      return this.startSpriteProxy(agentName, deploymentUrl)
    }

    if (proxyError.includes('Error:') || proxyError.includes('failed')) {
      this.warn(`Proxy failed: ${proxyError.trim()}`)
      proxyProcess.kill()
      return null
    }

    return {url: `http://localhost:${localPort}`, process: proxyProcess}
  }

  private async findAvailablePort(startPort: number, endPort: number): Promise<number> {
    const net = await import('net')
    return new Promise((resolve, reject) => {
      const tryPort = (port: number) => {
        if (port > endPort) {
          reject(new Error('No available ports found'))
          return
        }
        const server = net.createServer()
        server.listen(port, '127.0.0.1', () => {
          server.close(() => resolve(port))
        })
        server.on('error', () => tryPort(port + 1))
      }
      tryPort(startPort)
    })
  }

  private async launchTui(agentName: string, url: string, token?: string, proxyProcess?: ReturnType<typeof spawn>): Promise<void> {
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

    if (token) {
      opentuiArgs.push('--token', token)
    }

    const opentui = spawn(bunPath, opentuiArgs, {
      stdio: 'inherit',
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
