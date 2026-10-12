import DigitalOceanDeploy from '../digitalocean'
import type {DeploymentProvider} from '../types'
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
}
