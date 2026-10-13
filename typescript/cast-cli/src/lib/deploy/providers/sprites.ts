import {spawn} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {A2AClient, A2AClientError} from '../../a2a/client'
import {execCommand} from '../deploy-utils'
import SpritesDeploy from '../sprites'
import {spriteStartServiceArgs} from '../sprites-service'
import type {DeploymentProvider} from '../types'
import {upgradeSpritesDeployment} from '../upgrades'

export function resolveSprite(): string {
  const candidates = [
    'sprite',
    path.join(os.homedir(), '.local', 'bin', 'sprite'),
    '/usr/local/bin/sprite',
    '/opt/homebrew/bin/sprite',
  ]

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return 'sprite'
}

export async function findAvailablePort(startPort: number, endPort: number): Promise<number> {
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

export async function checkNeedsProxy(url: string): Promise<boolean> {
  try {
    const client = new A2AClient(url)
    await client.getAgentCard()
    return false
  } catch (error: any) {
    if (error instanceof A2AClientError) {
      if (
        error.statusCode === 302 ||
        error.statusCode === 401 ||
        error.statusCode === 403 ||
        error.code === 'ECONNREFUSED' ||
        error.message?.includes('Unsupported protocol')
      ) {
        return true
      }
    }
    return false
  }
}

export async function startSpriteProxy(
  agentName: string,
  deploymentUrl: string,
  log: (message: string) => void,
  warn: (message: string) => void,
): Promise<{url: string; process: ReturnType<typeof spawn>} | null> {
  const localPort = await findAvailablePort(8500, 9000)
  const spriteName = `cast-${agentName}`

  log(`Starting sprite proxy for ${spriteName} on port ${localPort}...`)

  const spritePath = resolveSprite()
  const proxyProcess = spawn(spritePath, ['proxy', `${localPort}:8080`, '-s', spriteName], {
    stdio: 'pipe',
  })

  let proxyError = ''
  proxyProcess.stderr?.on('data', (data: Buffer) => {
    proxyError += data.toString()
  })

  await new Promise((resolve) => setTimeout(resolve, 3000))

  if (proxyError.includes('address already in use')) {
    warn(`Port ${localPort} is already in use. Killing old proxy...`)
    proxyProcess.kill()
    return startSpriteProxy(agentName, deploymentUrl, log, warn)
  }

  if (proxyError.includes('Error:') || proxyError.includes('failed')) {
    warn(`Proxy failed: ${proxyError.trim()}`)
    proxyProcess.kill()
    return null
  }

  return {url: `http://localhost:${localPort}`, process: proxyProcess}
}

export const spritesProvider: DeploymentProvider = {
  key: 'sprites',
  name: 'Sprites',
  description: 'Persistent Firecracker VMs on Fly.io (sprites.dev)',
  cli: {
    command: 'sprite',
    installUrl: 'https://sprites.dev/install.sh',
    interactiveRecheckError: 'Sprites CLI is required.',
    interactiveRecheckHelp: [
      '',
      '─────────────────────────────────────────────────────────────',
      '  Sprites CLI Required',
      '─────────────────────────────────────────────────────────────',
      '',
      'You need the Sprites CLI to deploy.',
      '',
      'Install it:',
      '  curl https://sprites.dev/install.sh | bash',
      '',
      'Then authenticate:',
      '  sprite login',
      '  # or set SPRITES_TOKEN environment variable',
      '',
    ],
  },
  auth: {
    command: 'sprite login',
    envVars: ['SPRITES_TOKEN'],
  },
  // The sprites command checks the CLI itself. The historical deploy
  // switch did not pre-check it.
  toolChecks: [],
  memory: {
    mountPath: '/opt/cast-agent/memory',
    // Host directory creation happens at deploy time.
    async create() {},
  },
  async deploy(ctx) {
    await SpritesDeploy.run([ctx.agentName])
  },
  async destroy(ctx) {
    await SpritesDeploy.destroy(ctx.agentName)
  },
  async upgrade(ctx) {
    await upgradeSpritesDeployment(ctx, ctx.agentName, ctx.version, ctx.versionTarballPath)
  },
  async connect(ctx) {
    // The TCP proxy does not start a stopped service. Start it before the
    // first chat POST, or the proxy accepts the socket and then resets it.
    const spriteName = `cast-${ctx.agentName}`
    try {
      const started = await execCommand('sprite', spriteStartServiceArgs(spriteName), {silent: true, shell: false})
      if (started.exitCode !== 0) {
        const detail = (started.stderr || started.stdout).trim()
        ctx.warn(`Could not start the sprite agent service${detail ? `: ${detail}` : ''}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.warn(`Could not start the sprite agent service: ${message}`)
    }

    const needsProxy = await checkNeedsProxy(ctx.url)
    if (!(needsProxy || ctx.flags?.proxy)) return
    ctx.log('Sprites auth detected. Starting local proxy...')
    const proxyResult = await startSpriteProxy(ctx.agentName, ctx.url, ctx.log, ctx.warn)
    if (proxyResult) {
      ctx.log(`Proxy started at ${proxyResult.url}`)
      return {url: proxyResult.url, proxyProcess: proxyResult.process}
    }
    ctx.warn('Failed to start sprite proxy. Trying direct connection...')
  },
}
