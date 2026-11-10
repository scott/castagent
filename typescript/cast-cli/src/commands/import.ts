import {Args, Command, Flags} from '@oclif/core'
import {readFileSync} from 'fs'
import {CastbotImportError, importCastbotBlob, removeCastbotImport} from '../lib/castbot-import'

export default class Import extends Command {
  static description = 'Import a castbot machine into the local Cast CLI'

  static examples = [
    '<%= config.bin %> <%= command.id %> < export.json',
    '<%= config.bin %> <%= command.id %> --remove my-agent',
  ]

  static flags = {
    remove: Flags.boolean({description: 'Delete only the local castbot entry and its token'}),
  }

  static args = {
    name: Args.string({description: 'Agent name, used with --remove', required: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Import)
    try {
      if (flags.remove) {
        if (!args.name) this.error('Pass the agent name: cast import --remove <name>')
        await removeCastbotImport(args.name)
        this.log(`Removed the local castbot entry for '${args.name}'. The machine is still running.`)
        return
      }
      if (process.stdin.isTTY) this.error('Pipe the import blob on stdin.')
      const saved = await importCastbotBlob(readFileSync(0, 'utf8'))
      this.log(`Imported '${saved.name}' (${saved.id}).`)
      this.log(`Connect with: cast connect ${saved.name}`)
    } catch (error) {
      if (error instanceof CastbotImportError) this.error(error.message)
      throw error
    }
  }
}
