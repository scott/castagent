import {Command, Flags} from '@oclif/core'
import {pruneSessions} from '../../lib/sessions'

export default class SessionPrune extends Command {
  static description = 'Delete ended sessions older than N days (default: 30)'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --days 7',
  ]

  static flags = {
    days: Flags.integer({
      description: 'Cutoff in days. Sessions ended more than this many days ago are deleted.',
      default: 30,
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation prompt',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SessionPrune)
    if (flags.days < 1) {
      this.error('--days must be >= 1')
    }

    if (!flags.force) {
      this.log(`This will delete every ended session last updated more than ${flags.days} day(s) ago.`)
      this.log('Re-run with --force to confirm.')
      return
    }

    const deleted = await pruneSessions(flags.days)
    this.log(`Pruned ${deleted} session${deleted === 1 ? '' : 's'}.`)
  }
}
