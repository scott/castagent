import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as readline from 'readline'
import {missingAgentError} from '../lib/missing-agent'
import {getRelease, getCurrentRelease, listReleases, validateSemver} from '../lib/releases'
import {db} from '../lib/sqlite'
import {resolveDeploymentTarget} from '../lib/deploy/deploy-utils'
import {
  assertDeploymentProvidersLoaded,
  deploymentProviderLoadErrors,
  getDeploymentProvider,
} from '../lib/deploy/registry'
import {
  detectOnHostTui,
  readUpgradeOpenRouterKey,
  upgradeDigitalOceanDeployment,
  upgradeDockerDeployment,
  upgradeFlyDeployment,
  upgradeRailwayDeployment,
  upgradeSpritesDeployment,
} from '../lib/deploy/upgrades'
import type {UpgradeContext} from '../lib/deploy/types'

export default class Upgrade extends Command {
  static description = 'Upgrade a deployed agent to a new version'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> abc123  # Upgrade by deployment SHA',
    '<%= config.bin %> <%= command.id %> email-agent 1.6',
    '<%= config.bin %> <%= command.id %> email-agent --list-versions',
  ]

  static flags = {
    'list-versions': Flags.boolean({description: 'List available releases for the agent'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name or deployment SHA', required: true}),
    version: Args.string({description: 'Release version to upgrade to (optional, defaults to latest)'}),
  }

  private async confirm(message: string): Promise<boolean> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })

    return new Promise((resolve) => {
      rl.question(`${message} (y/N) `, (answer) => {
        rl.close()
        resolve(answer.trim().toLowerCase() === 'y')
      })
    })
  }

  async run(): Promise<void> {
    const loadErrors = deploymentProviderLoadErrors()
    if (loadErrors.length > 0) {
      this.error(loadErrors.map(error => error.message).join('\n'))
    }
    assertDeploymentProvidersLoaded()

    const {args, flags} = await this.parse(Upgrade)
    const target = args.agent
    const targetVersion = args.version

    const resolution = resolveDeploymentTarget(target)

    if (resolution.type === 'not_found') {
      this.error(
        `No deployment found for '${target}'.\n` +
        `Deploy it first with: cast deploy ${target}`
      )
    }

    if (resolution.type === 'ambiguous') {
      this.error(resolution.message!)
    }

    const deployment = resolution.deployment!
    const agentName = deployment.agent_name
    const deploymentSha = deployment.id

    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    if (!fs.existsSync(agentPath)) {
      this.error(missingAgentError(agentName, agentPath))
    }

    const provider = deployment.provider

    if (flags['list-versions']) {
      const releases = await listReleases(agentName)
      if (releases.length === 0) {
        this.log(`No releases found for agent '${agentName}'.`)
        this.log(`Create a release first with: cast release ${agentName}`)
        return
      }
      this.log(`Available releases for '${agentName}' (deployment: ${deploymentSha}):`)
      this.log('')
      for (const release of releases) {
        const currentTag = release.version === deployment.deployed_version ? ' (current)' : ''
        this.log(`  ${release.version}${currentTag}`)
        if (release.message) {
          this.log(`    ${release.message}`)
        }
      }
      this.log('')
      return
    }

    let version: string
    if (targetVersion) {
      version = targetVersion
      if (version !== 'latest') {
        const isValid = await validateSemver(version)
        if (!isValid) {
          this.error(`Invalid semantic version: '${version}'. Expected format: 1.0, 1.6, 2.0.0`)
        }
      }
    } else {
      version = 'latest'
    }

    if (version !== 'latest') {
      const release = await getRelease(agentName, version)
      if (!release) {
        const releases = await listReleases(agentName)
        const available = releases.map(r => r.version).join(', ')
        this.error(
          `Release ${version} does not exist for agent '${agentName}'.\n` +
          `Available releases: ${available || 'none'}\n` +
          `Use 'cast upgrade ${agentName}' to upgrade to the latest release.`
        )
      }
    }

    const currentVersion = deployment.deployed_version

    if (currentVersion === version || (version === 'latest' && currentVersion === 'latest')) {
      this.log(`Agent '${agentName}' is already at version ${version || currentVersion}.`)
      this.log(`Use 'cast upgrade ${agentName} <version>' to upgrade to a different version.`)
      return
    }

    this.log(`Upgrading ${agentName} from version ${currentVersion || 'unknown'} to ${version}...`)
    this.log(`Provider: ${provider}`)

    const confirmed = await this.confirm(`Proceed with upgrade?`)
    if (!confirmed) {
      this.log('Upgrade cancelled.')
      return
    }

    const isLatestVersion = version === 'latest'
    let versionTarballPath: string | null = null

    if (!isLatestVersion) {
      const release = await getRelease(agentName, version)
      if (release) {
        versionTarballPath = release.tarball_path

        if (!fs.existsSync(versionTarballPath)) {
          this.error(`Release tarball not found: ${versionTarballPath}`)
        }

        this.log(`Using release ${version} from ${versionTarballPath}`)
      }
    }

    const registered = getDeploymentProvider(provider)
    if (!registered?.upgrade) {
      this.error(`Upgrade not supported for provider '${provider}'. Please use 'cast shutdown' and 'cast deploy' instead.`)
    }

    try {
      const ctx: UpgradeContext = {
        agentName,
        agentPath,
        force: false,
        authToken: '',
        tokenHash: '',
        flags: {},
        version,
        deploymentSha,
        port: 8080,
        withTui: false,
        versionTarballPath,
        deployment,
        log: message => this.log(message),
        warn: message => this.warn(message),
        error: (message: string): never => this.error(message),
        confirm: message => this.confirm(message),
      }
      await registered.upgrade(ctx)

      let versionToStore = version
      if (version === 'latest') {
        const currentRelease = await getCurrentRelease(agentName)
        versionToStore = currentRelease || 'latest'
      }
      if (registered.recordsVersionByDeploymentId) {
        db.updateDeployedVersionById(deploymentSha, versionToStore)
      } else {
        db.updateDeployedVersion(agentName, versionToStore)
      }
      this.log(`Upgraded to version ${versionToStore} successfully.`)

    } catch (error: any) {
      if (error.oclif && error.oclif.exit !== undefined) {
        throw error
      }

      this.error(
        `Upgrade failed.\n\n` +
        `Error: ${error.message || error}\n\n` +
        `You can try rolling back by deploying the previous version:\n` +
        `  cast deploy ${agentName} --provider ${provider}`
      )
    }
  }

  private async upgradeDocker(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    await upgradeDockerDeployment(this, agentName, version, versionTarballPath)
  }

  private async upgradeRailway(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    await upgradeRailwayDeployment(this, agentName, version, versionTarballPath)
  }

  private async upgradeFly(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    await upgradeFlyDeployment(this, agentName, version, versionTarballPath)
  }

  private async upgradeDigitalOcean(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    await upgradeDigitalOceanDeployment(this, agentName, version, versionTarballPath)
  }

  private async upgradeSprites(agentName: string, version: string, versionTarballPath: string | null): Promise<void> {
    await upgradeSpritesDeployment(this, agentName, version, versionTarballPath)
  }

  private getOpenRouterApiKey(): string | undefined {
    return readUpgradeOpenRouterKey()
  }

  /**
   * Detect whether the on-host TUI is bundled in the agent container
   * running on the given droplet. The TUI patch in deploy-utils
   * creates a symlink at /usr/local/bin/cast-tui as its last step, so
   * a successful `test -e` on that path is a reliable signal that
   * the TUI is present in the image.
   *
   * Returns false on any error (SSH failure, container not running,
   * `docker exec` unavailable) — false is the safe default because
   * it causes the MOTD to omit the TUI hint, which is preferable to
   * telling users to run a command that doesn't exist.
   */
  private async detectOnHostTui(dropletIp: string): Promise<boolean> {
    return detectOnHostTui(dropletIp)
  }
}
