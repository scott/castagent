import {Args, Command, Flags} from '@oclif/core'
import * as readline from 'readline'
import {db} from '../lib/sqlite'
import {deploymentIdsToRemove, forgetDeploymentTokens, resolveDeploymentTarget} from '../lib/deploy/deploy-utils'
import {
  deploymentProviderLoadErrors,
  getDeploymentProvider,
  listDeploymentProviders,
} from '../lib/deploy/registry'
import type {DeploymentRow} from '../lib/deploy/types'
import type {TokenStore} from '../lib/keychain'

/** Name only the stores that actually held the token. An empty list names none. */
export function shutdownTokenPlace(stores: ReadonlyArray<TokenStore>): string {
  const names = new Set(stores)
  const parts: string[] = []
  if (names.has('keychain')) parts.push('keychain')
  if (names.has('file')) parts.push('token file')
  return parts.join(' and ')
}

export function shutdownTokenRemovalMessage(
  scope: 'agent' | 'deployment',
  stores: ReadonlyArray<TokenStore>,
  deploymentSha: string,
): string {
  const place = shutdownTokenPlace(stores)
  const where = place ? ` from ${place}` : ''
  if (scope === 'deployment') {
    return `Removed auth token for deployment ${deploymentSha}${where}.`
  }
  return `Removed auth token${where}.`
}

export const PROVIDER_DESTROYERS: Record<string, (agentName: string, deployment?: DeploymentRow) => Promise<void>> = {}

/** Fill missing keys only. Tests replace entries; a later sync must leave those in place. */
function syncDestroyers(): void {
  for (const provider of listDeploymentProviders()) {
    if (!provider.destroy) continue
    if (PROVIDER_DESTROYERS[provider.key]) continue
    const key = provider.key
    PROVIDER_DESTROYERS[key] = async (agentName: string, deployment?: DeploymentRow) => {
      const current = getDeploymentProvider(key)
      if (!current?.destroy) return
      const row: DeploymentRow = deployment?.id
        ? deployment
        : {
          id: '',
          agent_name: agentName,
          provider: key,
          deployment_url: '',
        }
      await current.destroy({agentName, deployment: row, log: () => {}})
    }
  }
}

syncDestroyers()

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
    const loadErrors = deploymentProviderLoadErrors()
    if (loadErrors.length > 0) {
      this.error(loadErrors.map(error => error.message).join('\n'))
    }
    syncDestroyers()

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

    const bySha = resolution.type === 'sha'
    const live = db.listDeployments(agentName)
    const ids = deploymentIdsToRemove(deployment, live, bySha)
    const removed = live.filter(row => ids.includes(row.id))
    const remaining = live.filter(row => !ids.includes(row.id))
    const removesEveryLiveRow = ids.length === live.length

    if (!flags.force) {
      const targetLabel = bySha && !removesEveryLiveRow
        ? `deployment ${deploymentSha} on ${provider}`
        : `'${agentName}'`
      const confirmed = await this.confirm(`Are you sure you want to shut down ${targetLabel} and destroy its remote resources?`)
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
        await destroyer(agentName, deployment)
        this.log(`Remote resources destroyed on ${provider}.`)
      } catch (error: any) {
        if (error?.keepDeployment === true) {
          this.error(error.message || String(error))
          return
        }
        this.warn(`Failed to destroy remote resources: ${error.message || error}`)
        this.warn('Removing local records anyway. You may need to clean up manually.')
      }
    }

    // Soft-delete the remote this command destroyed.
    //
    // An agent name with one live target still clears every row of that
    // target, including older re-deploys. A SHA clears only that remote:
    // another provider stays in the registry. Providers that name one
    // remote after the agent (a sprite, a droplet, a Fly app) take their
    // other rows with them, because that remote is gone.
    try {
      if (removesEveryLiveRow) {
        db.removeAllDeployments(agentName)
        this.log('Marked all deployments as deleted in database.')
      } else {
        for (const id of ids) db.removeDeploymentBySha(id)
        const label = ids.length === 1 ? `deployment ${ids[0]}` : `${ids.length} ${provider} deployments`
        this.log(`Marked ${label} as deleted in database.`)
      }
    } catch (error: any) {
      this.warn('Failed to update deployment records: ' + error.message)
    }

    try {
      const forgotten = await forgetDeploymentTokens(agentName, removed, remaining)
      if (forgotten.scope === 'agent' || forgotten.scope === 'deployment') {
        this.log(shutdownTokenRemovalMessage(forgotten.scope, forgotten.stores, deploymentSha))
      } else if (remaining.length > 0) {
        this.log('Left the auth token in place for the remaining deployment.')
      }
    } catch (error: any) {
      this.warn('Failed to remove auth token from keychain: ' + error.message)
    }

    if (removesEveryLiveRow) {
      this.log(`Agent '${agentName}' has been shut down.`)
    } else {
      this.log(`Deployment '${deploymentSha}' of '${agentName}' has been shut down.`)
    }
  }
}
