import {Command, Args, Flags} from '@oclif/core'
import * as fs from 'fs'
import {importSession} from '../../lib/sessions'

export default class SessionImport extends Command {
  static description = 'Import a session from a JSON file'

  static examples = [
    '<%= config.bin %> <%= command.id %> ./session.json',
    '<%= config.bin %> <%= command.id %> ./session.json --keep-id',
  ]

  static args = {
    file: Args.string({description: 'JSON file to import', required: true}),
  }

  static flags = {
    'keep-id': Flags.boolean({
      description: 'Keep the original session id (default: assign a new id)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(SessionImport)
    if (!fs.existsSync(args.file)) {
      this.error(`File not found: ${args.file}`)
    }
    try {
      const sess = await importSession(args.file, !flags['keep-id'])
      this.log(`Imported as session ${sess.id} (agent: ${sess.agent_name}).`)
      this.log(`Open it with: cast session resume ${sess.id}`)
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
