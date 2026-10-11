import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {redo as doRedo, canRedo} from '../lib/undo'

export default class Redo extends Command {
  static description = 'Redo previously-undone change(s) for an agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent --steps 3',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    steps: Flags.integer({
      description: 'Number of changes to redo',
      default: 1,
    }),
    message: Flags.string({description: 'Optional message for the snapshot entry'}),
    json: Flags.boolean({description: 'Output the redone entries as JSON', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Redo)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}.`)
    }

    if (flags.steps < 1) {
      this.error('--steps must be >= 1')
    }

    if (!(await canRedo(agentName))) {
      this.error(`Nothing to redo for agent '${agentName}'.`)
    }

    try {
      const redone = await doRedo(agentName, flags.steps, flags.message)
      if (flags.json) {
        this.log(JSON.stringify(redone, null, 2))
        return
      }
      this.log('')
      this.log(`Redid ${redone.length} change${redone.length === 1 ? '' : 's'} for agent '${agentName}':`)
      for (const r of redone) {
        this.log(`  - v${r.id}  ${r.message}  (${r.timestamp})`)
      }
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
