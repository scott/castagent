import {Command, Args, Flags} from '@oclif/core'
import {deleteSession, getSessionMeta} from '../../lib/sessions'

export default class SessionDelete extends Command {
  static description = 'Delete a session'

  static examples = [
    '<%= config.bin %> <%= command.id %> 01JABC…',
    '<%= config.bin %> <%= command.id %> my-session --force',
  ]

  static args = {
    identifier: Args.string({description: 'Session id (or name)', required: true}),
  }

  static flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(SessionDelete)
    const meta = await getSessionMeta(args.identifier)
    if (!meta) {
      this.error(`Session not found: ${args.identifier}`)
    }

    if (!flags.force) {
      const label = meta.name ? `'${meta.name}'` : meta.id
      this.log(`About to delete session ${label} (${meta.message_count} message${meta.message_count === 1 ? '' : 's'}).`)
      this.log('Re-run with --force to confirm.')
      return
    }

    await deleteSession(meta.id)
    this.log(`Deleted session ${meta.id}.`)
  }
}
