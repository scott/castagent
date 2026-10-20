import {Flags} from '@oclif/core'
import FlyDeploy, {
  deleteFlyVolumeByName,
  deployFlyAgent,
  ensureFlyMemoryVolume,
  flyAppName,
  flyBuilderOptions,
  flyVolumeName,
  flyVolumeNamesForDestroy,
  isFlyVolumeName,
} from '../fly'
import {execCommand} from '../deploy-utils'
import type {DeploymentProvider} from '../types'
import {upgradeFlyDeployment} from '../upgrades'

export const flyProvider: DeploymentProvider = {
  key: 'fly',
  name: 'Fly.io',
  description: 'Distributed containers close to your users',
  usesProviderHttpBase: true,
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
  flags: {
    'local-only': Flags.boolean({
      description: 'Fly.io: build with the local Docker daemon (flyctl deploy --local-only).',
    }),
    'remote-only': Flags.boolean({
      description: 'Fly.io: build with the Fly remote builder (flyctl deploy --remote-only).',
    }),
    depot: Flags.boolean({
      description: 'Fly.io: build with Depot (flyctl deploy --depot).',
    }),
    'no-depot': Flags.boolean({
      description: 'Fly.io: do not use Depot (flyctl deploy --depot=false).',
    }),
  },
  memory: {
    mountPath: '/app/agent/memory',
    async create(ctx) {
      const volumeName = isFlyVolumeName(ctx.volumeId) ? ctx.volumeId : flyVolumeName(ctx.agentName)
      await ensureFlyMemoryVolume({
        volumeName,
        appName: flyAppName(ctx.agentName),
        exec: (args, opts) => execCommand('flyctl', args, {
          cwd: opts?.cwd,
          silent: opts?.silent,
          shell: opts?.shell,
        }),
      })
    },
    async delete(ctx) {
      const names = flyVolumeNamesForDestroy(ctx.agentName, [ctx.volumeId])
      const exec = (args: string[], opts?: {cwd?: string; silent?: boolean; shell?: boolean}) =>
        execCommand('flyctl', args, {silent: opts?.silent, shell: opts?.shell})
      for (const name of names) {
        await deleteFlyVolumeByName(name, flyAppName(ctx.agentName), exec)
      }
    },
  },
  async deploy(ctx) {
    const builder = flyBuilderOptions(ctx.flags)
    await deployFlyAgent({
      agentName: ctx.agentName,
      agentPath: ctx.agentPath,
      builder,
      host: {
        log: ctx.log,
        warn: ctx.warn,
        error: ctx.error,
      },
    })
  },
  async destroy(ctx) {
    await FlyDeploy.destroy(ctx.agentName, ctx.deployment.volume_id)
  },
  async upgrade(ctx) {
    await upgradeFlyDeployment(ctx, ctx.agentName, ctx.version, ctx.versionTarballPath)
  },
}
