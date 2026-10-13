import {Command, Flags, Args} from '@oclif/core'
import {db} from '../lib/sqlite'

const RULE = '──────────────────────────────────────────────────────────────────────────────'
const COL = {agent: 15, sha: 10, provider: 16, version: 10, deployed: 23}

function pad(value: string, width: number): string {
  return value.padEnd(width)
}

function displayVersion(version: string | null | undefined): string {
  if (version == null) return '—'
  const trimmed = String(version).trim()
  return trimmed.length > 0 ? trimmed : '—'
}

function displaySha(sha: string | null | undefined): string {
  if (sha == null) return '—'
  const trimmed = String(sha).trim()
  return trimmed.length > 0 ? trimmed : '—'
}

function displayDeployed(value: string | null | undefined): string {
  if (!value) return 'unknown'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return `${date.toLocaleDateString()} ${date.toLocaleTimeString()}`
}

function deploymentCells(dep: {
  deployment_sha?: string | null
  id?: string | null
  provider?: string | null
  deployed_version?: string | null
  deployed_at?: string | null
  deployment_url?: string | null
}): {sha: string; provider: string; version: string; deployed: string; url: string} {
  return {
    sha: pad(displaySha(dep.deployment_sha ?? dep.id), COL.sha),
    provider: pad(dep.provider || 'unknown', COL.provider),
    version: pad(displayVersion(dep.deployed_version), COL.version),
    deployed: pad(displayDeployed(dep.deployed_at), COL.deployed),
    url: dep.deployment_url || 'N/A',
  }
}

export default class Registry extends Command {
  static description = 'List live deployments across all agents (or for a specific agent)'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> email-agent',
  ]

  static flags = {
    json: Flags.boolean({description: 'Output as JSON', default: false}),
  }

  static args = {
    agent: Args.string({description: 'Agent name (optional). Limits the table to that agent.'}),
  }

  async run(): Promise<void> {
    const {flags, args} = await this.parse(Registry)
    const agentName = args.agent as string | undefined

    if (agentName) {
      await this.showAgentDeployments(agentName, flags.json)
    } else {
      await this.showFleet(flags.json)
    }
  }

  private async showFleet(json: boolean): Promise<void> {
    const deployments = db.listActiveDeployments()

    if (json) {
      console.log(JSON.stringify(deployments, null, 2))
      return
    }

    if (deployments.length === 0) {
      this.log('No deployments found.')
      return
    }

    this.log('')
    this.log('Local Agent Registry')
    this.log(RULE)
    this.log(`  ${pad('AGENT', COL.agent)}${pad('SHA', COL.sha)}${pad('PROVIDER', COL.provider)}${pad('VERSION', COL.version)}${pad('DEPLOYED', COL.deployed)}URL`)
    this.log(`  ${RULE}`)

    for (const dep of deployments) {
      const cells = deploymentCells(dep)
      const agent = pad(dep.agent_name || '—', COL.agent)
      this.log(`  ${agent}${cells.sha}${cells.provider}${cells.version}${cells.deployed}${cells.url}`)
    }

    this.log(RULE)
    this.log('')
    this.log(`Total: ${deployments.length} deployment(s)`)
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
    this.log(RULE)
    this.log(`  ${pad('SHA', COL.sha)}${pad('PROVIDER', COL.provider)}${pad('VERSION', COL.version)}${pad('DEPLOYED', COL.deployed)}URL`)
    this.log(`  ${RULE}`)

    for (const dep of deployments) {
      const cells = deploymentCells(dep)
      this.log(`  ${cells.sha}${cells.provider}${cells.version}${cells.deployed}${cells.url}`)
    }

    this.log(RULE)
    this.log('')
    this.log(`Total: ${deployments.length} deployment(s)`)
  }
}
