import {Command, Args, Flags} from '@oclif/core'
import {forkSession} from '../../lib/sessions'

export default class SessionFork extends Command {
  static description = 'Fork a session into a new one'

  static examples = [
    '<%= config.bin %> <%= command.id %> 01JABC…',
    '<%= config.bin %> <%= command.id %> 01JABC… "alt approach"',
  ]

  static args = {
    identifier: Args.string({description: 'Session id (or name) to fork', required: true}),
  }

  static flags = {
    name: Flags.string({description: 'Name for the forked session'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(SessionFork)
    try {
      const forked = await forkSession(args.identifier, flags.name ?? null)
      this.log(`Forked into new session ${forked.id} (parent: ${forked.parent_session_id}).`)
      this.log(`Open it with: cast session resume ${forked.id}`)
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
