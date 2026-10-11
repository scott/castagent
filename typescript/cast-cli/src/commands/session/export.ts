import {Command, Args, Flags} from '@oclif/core'
import * as os from 'os'
import * as path from 'path'
import {exportSession} from '../../lib/sessions'

export default class SessionExport extends Command {
  static description = 'Export a session to a JSON file'

  static examples = [
    '<%= config.bin %> <%= command.id %> 01JABC…',
    '<%= config.bin %> <%= command.id %> 01JABC… --out ~/backup.json',
  ]

  static args = {
    identifier: Args.string({description: 'Session id (or name)', required: true}),
  }

  static flags = {
    out: Flags.string({description: 'Output path (defaults to <agent>-<id>.json in cwd)'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(SessionExport)
    const out = flags.out
      ? path.resolve(flags.out)
      : path.resolve(process.cwd(), `session-${args.identifier.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`)

    try {
      const written = await exportSession(args.identifier, out)
      this.log(`Exported session ${args.identifier} to ${written}.`)
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
