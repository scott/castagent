import {Flags} from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import MicrovmDeploy from '../microvm'
import {readAgentModel, resolveDigitalOceanToken} from '../deploy-utils'
import {ollamaDeployRefusal} from '../ollama'
import type {DeploymentProvider} from '../types'
import {DIGITALOCEAN_AUTH, DOCTL_CLI} from './shared'

export const MICROVM_WITH_TUI_REJECTION =
  'On-host TUI is not available for DigitalOcean MicroVMs. Deploy with --provider digitalocean --with-tui to SSH into a Droplet.'

async function extractVersionTarball(agentPath: string, versionTarballPath: string, log: (message: string) => void, version: string): Promise<void> {
  log(`Extracting version ${version} tarball...`)
  const tar = await import('tar')
  const agentFiles = fs.readdirSync(agentPath).filter(file =>
    !file.startsWith('.cast') && !file.startsWith('.git') && file !== 'Dockerfile' && file !== 'docker-compose.yml' && file !== 'requirements.txt'
  )
  for (const file of agentFiles) {
    const filePath = path.join(agentPath, file)
    if (fs.statSync(filePath).isDirectory()) {
      fs.rmSync(filePath, {recursive: true})
    } else {
      fs.unlinkSync(filePath)
    }
  }
  await tar.extract({file: versionTarballPath, cwd: agentPath})
}

export const microvmProvider: DeploymentProvider = {
  key: 'microvm',
  name: 'DigitalOcean MicroVM',
  description: 'Firecracker microVM in MKC1. Pauses when idle, resumes on the next request.',
  cli: {
    ...DOCTL_CLI,
    minVersion: '1.173.0',
  },
  auth: DIGITALOCEAN_AUTH,
  requiresDocker: true,
  withTui: 'rejected',
  withTuiRejectMessage: MICROVM_WITH_TUI_REJECTION,
  recordsVersionByDeploymentId: true,
  flags: {
    size: Flags.string({
      description: 'DigitalOcean MicroVM size as cpu:memory-mib. One of 1:2048, 2:4096, 8:16384, 16:32768.',
      default: '1:2048',
    }),
    'idle-timeout': Flags.string({
      description: 'DigitalOcean MicroVM idle timeout before auto-pause (for example 15m, maximum 4h).',
      default: '15m',
    }),
    'edge-auth-only': Flags.boolean({
      description: 'DigitalOcean MicroVM only. Skip the per-agent AUTH_TOKEN and rely on the team microvm:access token.',
      default: false,
    }),
  },
  toolChecks: [
    {
      command: 'docker',
      installUrl: 'https://docs.docker.com/get-docker/',
      error: 'Docker is required for DigitalOcean MicroVM deployment.\nInstall it from: https://docs.docker.com/get-docker/',
    },
    {
      command: 'doctl',
      installUrl: 'https://docs.digitalocean.com/reference/doctl/how-to/install/',
      error: 'doctl 1.173.0 or newer is required for DigitalOcean MicroVMs.\nInstall it from: https://docs.digitalocean.com/reference/doctl/how-to/install/',
    },
  ],
  memory: {
    mountPath: '/app/agent/memory',
    // The MicroVM disk survives pause and resume. There is no separate volume.
    async create() {},
  },
  async deploy(ctx) {
    const flags = ctx.flags
    await MicrovmDeploy.run([
      ctx.agentName,
      '--size', String(flags.size ?? '1:2048'),
      '--idle-timeout', String(flags['idle-timeout'] ?? '15m'),
      ...(flags['edge-auth-only'] ? ['--edge-auth-only'] : []),
    ])
  },
  async destroy(ctx) {
    await MicrovmDeploy.destroy(ctx.agentName, ctx.deployment)
  },
  async upgrade(ctx) {
    if (ctx.versionTarballPath && fs.existsSync(ctx.versionTarballPath)) {
      await extractVersionTarball(ctx.agentPath, ctx.versionTarballPath, ctx.log, ctx.version)
    }
    const refusal = ollamaDeployRefusal('microvm', readAgentModel(ctx.agentPath))
    if (refusal) ctx.error(refusal)
    await MicrovmDeploy.upgrade(ctx.agentName, ctx.deployment, message => ctx.log(message))
  },
  async connect(ctx) {
    const edgeToken = resolveDigitalOceanToken()
    if (!edgeToken) {
      ctx.error(
        `DigitalOcean API token not found for MicroVM '${ctx.agentName}'.\n` +
        `Set DIGITALOCEAN_ACCESS_TOKEN or run doctl auth init.\n` +
        `The first request can take longer while a paused MicroVM resumes.`
      )
    }
    let authMode = 'dual'
    try {
      authMode = JSON.parse(ctx.deployment.volume_config || '{}').authMode || 'dual'
    } catch {
      authMode = 'dual'
    }
    let token: string | null | undefined = ctx.token
    if (authMode === 'edge-only') token = null
    else if (!token) {
      ctx.warn(`No agent auth token in the keychain for '${ctx.agentName}'. The MicroVM may reject the connection.`)
    }
    return {
      edgeToken,
      token: token ?? null,
      timeoutHint: '\nThe MicroVM may be resuming from pause. Try again in a moment.',
    }
  },
}
