import {Args, Command} from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import * as yaml from 'yaml'
import {db} from '../lib/sqlite'
import {keychain} from '../lib/keychain'

export default class Rename extends Command {
  static description = 'Rename an existing agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> old-name new-name',
  ]

  static flags = {}

  static args = {
    currentName: Args.string({description: 'Current agent name', required: true}),
    newName: Args.string({description: 'New agent name', required: true}),
  }

  private validateAgentName(name: string): boolean {
    return /^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(name)
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
    const {args} = await this.parse(Rename)
    const currentName = args.currentName
    const newName = args.newName

    if (!this.validateAgentName(currentName)) {
      this.error(`Invalid current agent name '${currentName}'. Names must start with a letter or number and contain only letters, numbers, and hyphens.`)
    }

    if (!this.validateAgentName(newName)) {
      this.error(`Invalid new agent name '${newName}'. Names must start with a letter or number and contain only letters, numbers, and hyphens.`)
    }

    if (currentName === newName) {
      this.error('Current name and new name are the same.')
    }

    const currentPath = path.join(os.homedir(), '.cast', 'agents', currentName)
    const newPath = path.join(os.homedir(), '.cast', 'agents', newName)
    const configPath = path.join(currentPath, 'agent.yaml')

    if (!fs.existsSync(configPath)) {
      this.error(`Agent '${currentName}' does not exist. Create it first with: cast new`)
    }

    if (fs.existsSync(newPath)) {
      this.error(`An agent named '${newName}' already exists. Please choose a different name.`)
    }

    const deployment = db.getDeployment(currentName)
    if (deployment) {
      this.warn(`Agent '${currentName}' is currently deployed to ${deployment.provider}.`)
      this.warn('The deployment URL and configuration will be updated, but you may need to update any external references.')
    }

    const localAgent = db.getLocalAgent(currentName)
    if (localAgent) {
      this.warn(`Agent '${currentName}' is currently running locally.`)
      const confirmed = await this.confirm('Rename anyway? (The agent will continue running with the old name until restarted.)')
      if (!confirmed) {
        this.log('Rename cancelled.')
        return
      }
    }

    this.log(`Renaming agent '${currentName}' to '${newName}'...`)

    try {
      fs.renameSync(currentPath, newPath)
      this.log(`Moved agent directory to: ${newPath}`)
    } catch (error: any) {
      this.error(`Failed to move agent directory: ${error.message}`)
    }

    try {
      const configContent = fs.readFileSync(configPath.replace(currentPath, newPath), 'utf8')
      const config = yaml.parse(configContent)
      if (config) {
        config.name = newName
        fs.writeFileSync(configPath.replace(currentPath, newPath), yaml.stringify(config))
        this.log('Updated agent.yaml')
      }
    } catch (error: any) {
      this.warn(`Failed to update agent.yaml: ${error.message}`)
    }

    const versionsPath = path.join(newPath, '.cast', 'versions', 'versions.json')
    if (fs.existsSync(versionsPath)) {
      try {
        const versions = JSON.parse(fs.readFileSync(versionsPath, 'utf8'))
        this.log(`Versions file exists at ${versionsPath}`)
      } catch (error: any) {
        this.warn(`Failed to read versions file: ${error.message}`)
      }
    }

    try {
      db.renameAgent(currentName, newName)
      this.log('Updated database records.')
    } catch (error: any) {
      this.warn(`Failed to update database: ${error.message}`)
    }

    try {
      await keychain.renameAgentEntries(currentName, newName)
      this.log('Updated keychain entries.')
    } catch (error: any) {
      this.warn(`Failed to update keychain: ${error.message}`)
    }

    try {
      const mcpServers = db.listAgentMcp(currentName)
      for (const mcp of mcpServers) {
        const cred = await keychain.getCredential(currentName, mcp.server_name)
        if (cred) {
          await keychain.setCredential(newName, mcp.server_name, cred)
          await keychain.deleteCredential(currentName, mcp.server_name)
        }
      }
    } catch (error: any) {
      this.warn(`Failed to update MCP credentials: ${error.message}`)
    }

    this.log(`Agent '${currentName}' has been renamed to '${newName}' successfully.`)
    this.log('')
    this.log('Note: If the agent was running locally or deployed, restart it to use the new name.')
  }
}