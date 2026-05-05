import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import {db} from '../lib/sqlite'
import {keychain} from '../lib/keychain'

export default class Delete extends Command {
  static description = 'Delete agent'

  static flags = {
    force: Flags.boolean({description: 'Force deletion without confirmation'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
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
    const {args, flags} = await this.parse(Delete)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), 'cast-agents', agentName)

    // Check if agent is deployed
    const deployment = db.getDeployment(agentName)
    if (deployment) {
      this.error(
        `Agent '${agentName}' is currently deployed to ${deployment.provider} (${deployment.deployment_url}).\n` +
        `Shut it down first before deleting:\n` +
        `  cast shutdown ${agentName}`
      )
    }

    // Handle missing agent gracefully
    if (!fs.existsSync(agentPath)) {
      // Check if it's only in the database
      const dbAgent = db.getAgent(agentName)
      if (dbAgent) {
        this.warn(`Agent directory not found, but '${agentName}' exists in the database.`)
        this.warn('Cleaning up database records...')
        db.deleteAgent(agentName)
        try {
          await keychain.deleteToken(agentName)
        } catch {
          // Ignore keychain errors during cleanup
        }
        this.log(`Agent '${agentName}' removed from database.`)
        return
      }

      this.log(`Agent '${agentName}' not found. Nothing to delete.`)
      return
    }

    // Show what will be deleted
    const itemsToDelete: string[] = []
    itemsToDelete.push(`Agent directory: ${agentPath}`)

    const dbAgent = db.getAgent(agentName)
    if (dbAgent) {
      itemsToDelete.push('Database records')
    }

    try {
      const token = await keychain.getToken(agentName)
      if (token) {
        itemsToDelete.push('Auth token from keychain')
      }
    } catch {
      // Ignore keychain read errors
    }

    this.log('The following will be deleted:')
    for (const item of itemsToDelete) {
      this.log(`  - ${item}`)
    }
    this.log('')

    if (!flags.force) {
      const confirmed = await this.confirm(`Are you sure you want to delete agent '${agentName}'?`)
      if (!confirmed) {
        this.log('Deletion cancelled.')
        return
      }
    }

    this.log(`Deleting ${agentName}...`)

    // Delete agent directory
    try {
      fs.rmSync(agentPath, {recursive: true, force: true})
      this.log(`Removed agent directory: ${agentPath}`)
    } catch (error: any) {
      this.error(`Failed to remove agent directory: ${error.message}`)
    }

    // Remove from SQLite
    try {
      db.deleteAgent(agentName)
      this.log('Removed from database.')
    } catch (error: any) {
      this.warn('Failed to remove from database: ' + error.message)
    }

    // Remove from keychain
    try {
      await keychain.deleteToken(agentName)
      this.log('Removed token from keychain.')
    } catch (error: any) {
      this.warn('Failed to remove token from keychain: ' + error.message)
    }

    this.log(`Agent '${agentName}' deleted successfully.`)
  }
}
