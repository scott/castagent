import {Command, Args} from '@oclif/core'
import {renameSession} from '../../lib/sessions'

export default class SessionRename extends Command {
  static description = 'Rename a session'

  static examples = [
    '<%= config.bin %> <%= command.id %> 01JABC… "auth experiment"',
  ]

  static args = {
    identifier: Args.string({description: 'Session id (or current name)', required: true}),
    name: Args.string({description: 'New name', required: true}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(SessionRename)
    try {
      const sess = await renameSession(args.identifier, args.name)
      this.log(`Renamed session ${sess.id} to '${sess.name}'.`)
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
