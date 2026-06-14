import {Args, Command, Flags} from '@oclif/core'
import * as readline from 'readline'
import {db} from '../lib/sqlite'
import {keychain} from '../lib/keychain'
import {resolveDeploymentTarget} from '../lib/deploy/deploy-utils'
import DockerDeploy from '../lib/deploy/docker'
import FlyDeploy from '../lib/deploy/fly'
import RailwayDeploy from '../lib/deploy/railway'
import DigitalOceanDeploy from '../lib/deploy/digitalocean'
import SpritesDeploy from '../lib/deploy/sprites'

export const PROVIDER_DESTROYERS: Record<string, (agentName: string) => Promise<void>> = {
  docker: DockerDeploy.destroy,
  fly: FlyDeploy.destroy,
  railway: RailwayDeploy.destroy,
  digitalocean: DigitalOceanDeploy.destroy,
  sprites: SpritesDeploy.destroy,
}

export default class Shutdown extends Command {
  static description = 'Shut down a deployed agent (destroy remote resources)'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> abc123  # Shutdown by deployment SHA',
    '<%= config.bin %> <%= command.id %> email-agent --force',
  ]

  static flags = {
    force: Flags.boolean({description: 'Skip confirmation prompt'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name or deployment SHA', required: true}),
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
    const {args, flags} = await this.parse(Shutdown)
    const target = args.agent

    // Resolve target (SHA or agent name)
    const resolution = resolveDeploymentTarget(target)

    if (resolution.type === 'not_found') {
      this.log(`No deployment found for '${target}'.`)
      return
    }

    if (resolution.type === 'ambiguous') {
      this.error(resolution.message!)
    }

    // resolution.type is 'sha' or 'single'
    const deployment = resolution.deployment!
    const agentName = deployment.agent_name
    const deploymentSha = deployment.id

    const provider = deployment.provider
    const url = deployment.deployment_url

    this.log(`Agent '${agentName}' (deployment: ${deploymentSha}) is deployed to ${provider} (${url})`)

    if (!flags.force) {
      const confirmed = await this.confirm(`Are you sure you want to shut down '${agentName}' and destroy all remote resources?`)
      if (!confirmed) {
        this.log('Shutdown cancelled.')
        return
      }
    }

    this.log(`Shutting down ${agentName} on ${provider}...`)

    const destroyer = PROVIDER_DESTROYERS[provider]
    if (!destroyer) {
      this.warn(`No shutdown handler for provider '${provider}'. Removing local records only.`)
    } else {
      try {
        await destroyer(agentName)
        this.log(`Remote resources destroyed on ${provider}.`)
      } catch (error: any) {
        this.warn(`Failed to destroy remote resources: ${error.message || error}`)
        this.warn('Removing local records anyway. You may need to clean up manually.')
      }
    }

    // Soft delete all deployment records for this agent (set deleted_at)
    //
    // When an agent has been deployed multiple times, only the most recent
    // row was previously removed, leaving older records undeleted. This
    // caused `cast list` to still show the agent as deployed (it finds the
    // next most recent undeleted row). Remove all records so the agent
    // correctly shows as shut down.
    try {
      db.removeAllDeployments(agentName)
      this.log('Marked all deployments as deleted in database.')
    } catch (error: any) {
      this.warn('Failed to update deployment records: ' + error.message)
    }

    // Remove auth token from keychain
    try {
      await keychain.deleteToken(agentName)
      this.log('Removed auth token from keychain.')
    } catch (error: any) {
      this.warn('Failed to remove auth token from keychain: ' + error.message)
    }

    this.log(`Agent '${agentName}' has been shut down.`)
  }
}
