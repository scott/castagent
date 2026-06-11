import {Args, Command, Flags} from '@oclif/core'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {execSync} from 'child_process'

interface VersionInfo {
  id: number
  timestamp: string
  source: string
  message: string
}

interface VersionsJson {
  current: number
  versions: VersionInfo[]
}

export default class Revert extends Command {
  static description = 'Revert an agent to a previous version'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent --to-version 3',
    '<%= config.bin %> <%= command.id %> my-agent --to-version 3 --message "Revert bad changes"',
  ]

  static flags = {
    'to-version': Flags.integer({
      description: 'Specific version to revert to (default: latest)',
    }),
    message: Flags.string({
      description: 'Message for the revert version',
    }),
    'dry-run': Flags.boolean({
      description: 'Preview what would be reverted without making changes',
      default: false,
    }),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Revert)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    // Validate agent exists
    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    const versionsJsonPath = path.join(agentPath, '.cast', 'versions', 'versions.json')

    if (!fs.existsSync(versionsJsonPath)) {
      this.error(`No versions found for agent '${agentName}'. Cannot revert.`)
    }

    try {
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsJsonPath, 'utf8'))

      if (data.versions.length === 0) {
        this.error(`No versions available for agent '${agentName}'.`)
      }

      const targetVersion = flags['to-version'] || data.current

      // Find the target version
      const version = data.versions.find(v => v.id === targetVersion)
      if (!version) {
        this.error(`Version ${targetVersion} not found. Available versions: ${data.versions.map(v => v.id).join(', ')}`)
      }

      // Show what will happen
      this.log('')
      this.log(`Reverting agent '${agentName}' to version ${targetVersion}:`)
      this.log(`  Message: ${version.message}`)
      this.log(`  Created: ${version.timestamp}`)
      this.log(`  Source: ${version.source}`)
      this.log('')

      if (flags['dry-run']) {
        this.log('Dry run - no changes made.')
        return
      }

      // Confirm the action
      this.log('A new version will be created of the current state before reverting.')
      this.log('')

      // Call Python to do the revert
      const message = flags.message || `Reverted to version ${targetVersion}`

      try {
        // Find the Python executable
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

        // Import and call the Python revert function
        const script = `
import sys
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import revert_to_version
result = revert_to_version('${agentName}', ${targetVersion}, '${message}')
print(f"Reverted to version {result.id}")
`

        execSync(
          `${pythonCmd} -c "${script.replace(/\n/g, ';').replace(/^\s*;/, '').trim()}"`,
          {
            cwd: os.homedir(),
            stdio: 'inherit',
          },
        )

        this.log('')
        this.log(`Successfully reverted to version ${targetVersion}.`)
        this.log(`A new version was created recording the revert.`)
      } catch (err: any) {
        this.error(`Revert failed: ${err.message}`)
      }
    } catch (error: any) {
      this.error(`Failed to read versions: ${error.message}`)
    }
  }
}