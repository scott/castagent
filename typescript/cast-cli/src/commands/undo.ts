import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {undo as doUndo, canUndo, getUndoHistory} from '../lib/undo'

export default class Undo extends Command {
  static description = 'Undo the last change(s) for an agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent --steps 3',
    '<%= config.bin %> <%= command.id %> my-agent --steps 3 --message "Back to a working state"',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    steps: Flags.integer({
      description: 'Number of changes to undo',
      default: 1,
    }),
    message: Flags.string({description: 'Optional message for the snapshot entry'}),
    json: Flags.boolean({description: 'Output the undone entries as JSON', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Undo)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}.`)
    }

    if (flags.steps < 1) {
      this.error('--steps must be >= 1')
    }

    if (!(await canUndo(agentName))) {
      this.error(`Nothing to undo for agent '${agentName}'.`)
    }

    try {
      const undone = await doUndo(agentName, flags.steps, flags.message)
      if (flags.json) {
        this.log(JSON.stringify(undone, null, 2))
        return
      }
      this.log('')
      this.log(`Undid ${undone.length} change${undone.length === 1 ? '' : 's'} for agent '${agentName}':`)
      for (const u of undone) {
        this.log(`  - v${u.id}  ${u.message}  (${u.timestamp})`)
      }
      this.log('')
      this.log('Use `cast redo` to bring the changes back.')
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
