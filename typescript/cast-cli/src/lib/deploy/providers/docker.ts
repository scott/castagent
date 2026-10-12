import DockerDeploy from '../docker'
import {execCommand, execCommandIgnoreError} from '../deploy-utils'
import type {DeploymentProvider} from '../types'
import {upgradeDockerDeployment} from '../upgrades'

export const dockerProvider: DeploymentProvider = {
  key: 'docker',
  name: 'Docker (local)',
  description: 'Self-hosted Docker container on this machine',
  cli: {
    command: 'docker',
    installUrl: 'https://docs.docker.com/get-docker/',
    walkthrough: 'skip',
  },
  requiresDocker: true,
  requiresDockerDaemon: true,
  toolChecks: [
    {
      command: 'docker',
      installUrl: 'https://docs.docker.com/get-docker/',
      error: 'Docker is not installed or not in PATH.\nInstall it from: https://docs.docker.com/get-docker/',
      requireDaemon: true,
    },
  ],
  memory: {
    mountPath: '/app/agent/memory',
    async create(ctx) {
      await execCommand('docker', ['volume', 'create', ctx.volumeId])
    },
    async delete(ctx) {
      await execCommandIgnoreError('docker', ['volume', 'rm', ctx.volumeId])
    },
  },
  async deploy(ctx) {
    await DockerDeploy.run([ctx.agentName, '--port', String(ctx.port)])
  },
  async destroy(ctx) {
    await DockerDeploy.destroy(ctx.agentName)
  },
  async upgrade(ctx) {
    await upgradeDockerDeployment(ctx, ctx.agentName, ctx.version, ctx.versionTarballPath)
  },
}
