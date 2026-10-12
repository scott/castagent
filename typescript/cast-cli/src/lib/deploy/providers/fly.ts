import FlyDeploy from '../fly'
import {execCommand, execCommandIgnoreError} from '../deploy-utils'
import type {DeploymentProvider} from '../types'
import {upgradeFlyDeployment} from '../upgrades'

export const flyProvider: DeploymentProvider = {
  key: 'fly',
  name: 'Fly.io',
  description: 'Distributed containers close to your users',
  cli: {
    command: 'flyctl',
    installUrl: 'https://fly.io/docs/hands-on/install-flyctl/',
    installHints: [
      'curl -L https://fly.io/install.sh | sh',
      '# or',
      'brew install flyctl',
    ],
  },
  auth: {
    command: 'flyctl auth login',
  },
  toolChecks: [
    {
      command: 'flyctl',
      installUrl: 'https://fly.io/docs/hands-on/install-flyctl/',
      error: 'Fly.io CLI (flyctl) is not installed.\nInstall it from: https://fly.io/docs/hands-on/install-flyctl/',
    },
  ],
  memory: {
    mountPath: '/app/agent/memory',
    async create(ctx) {
      await execCommand('flyctl', ['volumes', 'create', ctx.volumeId, '--size', '1', '--app', `cast-${ctx.agentName}`])
    },
    async delete(ctx) {
      await execCommandIgnoreError('flyctl', ['volumes', 'delete', ctx.volumeId, '--app', `cast-${ctx.agentName}`, '--yes'])
    },
  },
  async deploy(ctx) {
    await FlyDeploy.run([ctx.agentName])
  },
  async destroy(ctx) {
    await FlyDeploy.destroy(ctx.agentName)
  },
  async upgrade(ctx) {
    await upgradeFlyDeployment(ctx, ctx.agentName, ctx.version, ctx.versionTarballPath)
  },
}
