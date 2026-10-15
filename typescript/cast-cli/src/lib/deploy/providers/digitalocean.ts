import DigitalOceanDeploy, {
  dropletHostFromUrl,
  isLoopbackClientUrl,
  startDropletSshTunnel,
} from '../digitalocean'
import type {ConnectContext, DeploymentProvider} from '../types'
import {upgradeDigitalOceanDeployment} from '../upgrades'
import {DIGITALOCEAN_AUTH, DOCTL_CLI} from './shared'

export const digitaloceanProvider: DeploymentProvider = {
  key: 'digitalocean',
  name: 'DigitalOcean',
  description: 'Droplet with Docker container hosting',
  cli: DOCTL_CLI,
  auth: DIGITALOCEAN_AUTH,
  requiresDocker: true,
  withTui: 'supported',
  toolChecks: [
    {
      command: 'docker',
      installUrl: 'https://docs.docker.com/get-docker/',
      error: 'Docker is required for DigitalOcean deployment.\nInstall it from: https://docs.docker.com/get-docker/',
    },
  ],
  memory: {
    mountPath: '/app/agent/memory',
    // Volume creation and attachment happen in digitalocean.ts.
    async create() {},
  },
  async deploy(ctx) {
    const args = ctx.withTui ? [ctx.agentName, '--with-tui'] : [ctx.agentName]
    await DigitalOceanDeploy.run(args)
  },
  async destroy(ctx) {
    await DigitalOceanDeploy.destroy(ctx.agentName)
  },
  async upgrade(ctx) {
    await upgradeDigitalOceanDeployment(ctx, ctx.agentName, ctx.version, ctx.versionTarballPath)
  },
  async connect(ctx: ConnectContext) {
    let host: string
    try {
      host = dropletHostFromUrl(ctx.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.error(message)
      return
    }
    ctx.log(`Opening an SSH tunnel to ${host}. The bearer token stays inside SSH.`)
    let tunnel: Awaited<ReturnType<typeof startDropletSshTunnel>>
    try {
      tunnel = await startDropletSshTunnel(host, ctx.log)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.error(
        `Could not open an SSH tunnel to the DigitalOcean droplet at ${host}.\n` +
        `${message}\n` +
        'The agent listens on 127.0.0.1:8080. cast connect will not send the bearer token to a public HTTP URL.',
      )
      return
    }
    if (!isLoopbackClientUrl(tunnel.url)) {
      try { tunnel.process.kill() } catch { /* already gone */ }
      ctx.error('Refusing to send the bearer token to a public URL.')
    }
    return {url: tunnel.url, proxyProcess: tunnel.process}
  },
}
