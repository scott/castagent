import {Args, Command, Flags} from '@oclif/core'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

interface ChangeInfo {
  id: number
  timestamp: string
  source: string
  message: string
}

interface ChangesJson {
  current: number
  versions: ChangeInfo[]
}

export default class Changes extends Command {
  static description = 'List all changes of an agent'

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
    const {args, flags} = await this.parse(Changes)
    const agentName = args.agent
    // Try both old and new paths for backward compatibility
    const newPath = path.join(os.homedir(), '.cast', 'agents', agentName, '.cast', 'changes', 'changes.json')
    const oldPath = path.join(os.homedir(), '.cast', 'agents', agentName, '.cast', 'versions', 'versions.json')
    
    const changesJsonPath = fs.existsSync(newPath) ? newPath : oldPath

    if (!fs.existsSync(changesJsonPath)) {
      this.log(`No changes found for agent '${agentName}'.`)
      this.log('Changes are created automatically when the agent is edited.')
      return
    }

    try {
      const data: ChangesJson = JSON.parse(fs.readFileSync(changesJsonPath, 'utf8'))

      if (flags.json) {
        console.log(JSON.stringify(data, null, 2))
        return
      }

      this.log('')
      this.log(`Agent: ${agentName}`)
      this.log(`Current change: ${data.current}`)
      this.log('')
      this.log('Change History:')
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
      this.log(`  cast restore ${agentName} --change <num>  - Restore to a specific change`)
      this.log(`  cast diff ${agentName} --change <n> --change <m>  - Compare changes`)
      this.log(`  cast release ${agentName} <version>  - Create a release`)
    } catch (error: any) {
      this.error(`Failed to read changes: ${error.message}`)
    }
  }
}