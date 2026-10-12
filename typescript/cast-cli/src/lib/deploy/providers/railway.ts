import RailwayDeploy from '../railway'
import {execCommand} from '../deploy-utils'
import type {DeploymentProvider} from '../types'
import {upgradeRailwayDeployment} from '../upgrades'

export const railwayProvider: DeploymentProvider = {
  key: 'railway',
  name: 'Railway',
  description: 'Managed containers with automatic deployments',
  cli: {
    command: 'railway',
    installUrl: 'https://docs.railway.app/getting-started/installation',
    installHints: [
      'npm install -g @railway/cli',
      '# or',
      'brew install railway',
    ],
  },
  auth: {
    command: 'railway login',
  },
  toolChecks: [
    {
      command: 'railway',
      installUrl: 'https://docs.railway.app/getting-started/installation',
      error: 'Railway CLI is not installed.\nInstall it from: https://docs.railway.app/getting-started/installation',
    },
  ],
  memory: {
    // Railway sets CAST_MEMORY_PATH itself, so the mount path stays empty.
    mountPath: '',
    async create(ctx) {
      await execCommand('railway', ['volume', 'create', ctx.volumeId])
    },
  },
  async deploy(ctx) {
    await RailwayDeploy.run([ctx.agentName])
  },
  async destroy(ctx) {
    await RailwayDeploy.destroy(ctx.agentName)
  },
  async upgrade(ctx) {
    await upgradeRailwayDeployment(ctx, ctx.agentName, ctx.version, ctx.versionTarballPath)
  },
}
