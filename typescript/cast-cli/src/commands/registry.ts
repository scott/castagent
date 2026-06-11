import {Command, Flags, Args} from '@oclif/core'
import {db} from '../lib/sqlite'

export default class Registry extends Command {
  static description = 'List all releases across all agents (or for a specific agent)'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> email-agent',
  ]

  static flags = {
    json: Flags.boolean({description: 'Output as JSON', default: false}),
  }

  static args = {
    agent: Args.string({description: 'Agent name (optional, shows detailed deployments for single agent)'}),
  }

  async run(): Promise<void> {
    const {flags, args} = await this.parse(Registry)
    const agentName = args.agent as string | undefined

    if (agentName) {
      // Show detailed deployments for single agent
      await this.showAgentDeployments(agentName, flags.json)
    } else {
      // Show all releases across all agents
      await this.showAllReleases(flags.json)
    }
  }

  private async showAgentDeployments(agentName: string, json: boolean): Promise<void> {
    const deployments = db.listAllDeploymentsForAgent(agentName)

    if (json) {
      console.log(JSON.stringify(deployments, null, 2))
      return
    }

    if (deployments.length === 0) {
      this.log(`No deployments found for agent '${agentName}'.`)
      return
    }

    this.log('')
    this.log(`Local Agent Registry: ${agentName}`)
    this.log('──────────────────────────────────────────────────────────────────────────────')
    this.log('  SHA       PROVIDER   VERSION   DEPLOYED               URL')
    this.log('  ──────────────────────────────────────────────────────────────────────────────')

    for (const dep of deployments) {
      const deployedDate = dep.deployed_at
        ? new Date(dep.deployed_at).toLocaleDateString() + ' ' + new Date(dep.deployed_at).toLocaleTimeString()
        : 'unknown'
      const version = dep.deployed_version || 'latest'
      const url = dep.deployment_url || 'N/A'
      const provider = (dep.provider || 'unknown').padEnd(8)
      this.log(`  ${dep.deployment_sha}  ${provider}   ${version.padEnd(8)} ${deployedDate.padEnd(20)} ${url}`)
    }

    this.log('──────────────────────────────────────────────────────────────────────────────')
    this.log('')
    this.log(`Total: ${deployments.length} deployment(s)`)
  }

  private async showAllReleases(json: boolean): Promise<void> {
    const releases = db.listAllReleases()

    if (json) {
      console.log(JSON.stringify(releases, null, 2))
      return
    }

    if (releases.length === 0) {
      this.log('No releases found.')
      return
    }

    this.log('')
    this.log('Local Agent Registry')
    this.log('──────────────────────────────────────────────────────────────────────────────')

    for (const release of releases) {
      const date = new Date(release.created_at)
      const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
      let status = ''
      if (release.provider && release.deployment_sha) {
        status = ` [DEPLOYED on ${release.provider.toUpperCase()}, sha:${release.deployment_sha}]`
      } else if (release.provider) {
        status = ` [DEPLOYED on ${release.provider.toUpperCase()}]`
      }
      this.log(`  ${release.agent_name}    ${release.version}   ${dateStr}${status}`)
    }

    this.log('──────────────────────────────────────────────────────────────────────────────')
    this.log('')
    this.log(`Total: ${releases.length} release(s)`)
  }
}