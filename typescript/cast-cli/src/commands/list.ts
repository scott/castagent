import {Command} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {db} from '../lib/sqlite'

export default class List extends Command {
  static description = 'List all agents'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
  ]

  async run(): Promise<void> {
    await this.parse(List)

    const agentsDir = path.join(os.homedir(), '.cast', 'agents')

    if (!fs.existsSync(agentsDir)) {
      this.log('No agents directory found at ~/.cast/agents/')
      this.log('')
      this.log("Create your first agent with: cast dev <agent-name>")
      return
    }

    // Read from SQLite for accurate state
    const dbAgents = db.listAgents()

    // Also scan filesystem for agents not in database
    const fsAgents: string[] = []
    try {
      fsAgents.push(...fs.readdirSync(agentsDir).filter(name => {
        const fullPath = path.join(agentsDir, name)
        return fs.statSync(fullPath).isDirectory()
      }))
    } catch {
      // Ignore filesystem errors
    }

    const allAgentNames = Array.from(new Set([
      ...dbAgents.map(a => a.name),
      ...fsAgents,
    ]))

    if (allAgentNames.length === 0) {
      this.log('No agents found.')
      this.log('')
      this.log("Create your first agent with: cast dev <agent-name>")
      return
    }

    this.log('Agents in ~/.cast/agents/')
    this.log('')

    for (const agentName of allAgentNames) {
      const dbAgent = dbAgents.find(a => a.name === agentName)
      const deployment = db.getDeployment(agentName)
      const localAgent = db.getLocalAgent(agentName)

      let status = ''
      if (deployment?.deployment_url) {
        status = `[deployed: ${deployment.provider}]`
      } else if (localAgent?.port) {
        status = `[local: running on port ${localAgent.port}]`
      } else if (dbAgent) {
        status = '[local: stopped]'
      } else {
        status = '[local: stopped]'
      }

      this.log(`  ${agentName.padEnd(15)} ${status}`)
    }

    this.log('')
    this.log("Status: [local: stopped] → Not running | [local: running on port XXXX] → Active")
    this.log('')
    this.log("Commands:")
    this.log("  cast dev <agent-name>       Start an agent")
    this.log("  cast stop <agent-name>      Stop a running agent")
    this.log("  cast deploy <agent-name>    Deploy to cloud")
  }
}
