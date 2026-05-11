import {Args, Command, Flags} from '@oclif/core'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

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

export default class Versions extends Command {
  static description = 'List all versions of an agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent --json',
  ]

  static flags = {
    json: Flags.boolean({description: 'Output as JSON', default: false}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Versions)
    const agentName = args.agent
    const versionsJsonPath = path.join(os.homedir(), '.cast', 'agents', agentName, '.cast', 'versions', 'versions.json')

    if (!fs.existsSync(versionsJsonPath)) {
      this.log(`No versions found for agent '${agentName}'.`)
      this.log('Versions are created when the agent is edited or modified.')
      return
    }

    try {
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsJsonPath, 'utf8'))

      if (flags.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }

      this.log('')
      this.log(`Agent: ${agentName}`)
      this.log(`Current version: ${data.current}`)
      this.log('')
      this.log('Version History:')
      this.log('──────────────────────────────────────────────────────────────────────────────')

      for (const v of data.versions) {
        const date = new Date(v.timestamp)
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
        const sourceLabel = v.source === 'create' ? 'CREATED' : v.source.toUpperCase()
        this.log(`  v${v.id}  ${dateStr}  [${sourceLabel}]  ${v.message}`)
      }

      this.log('──────────────────────────────────────────────────────────────────────────────')
      this.log('')
      this.log('Commands:')
      this.log(`  cast revert ${agentName} [version]  - Revert to a specific version`)
      this.log(`  cast diff ${agentName} [v1] [v2]     - Compare two versions`)
    } catch (error: any) {
      this.error(`Failed to read versions: ${error.message}`)
    }
  }
}