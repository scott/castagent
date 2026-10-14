import {Args, Command, Flags} from '@oclif/core'
import {
  formatModelCatalog,
  getCurrentBuilderModel,
  MODELS,
  setBuilderModel,
} from '../lib/models'

export default class Model extends Command {
  static description = 'Show or set the model the builder agent uses'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> anthropic/claude-sonnet-4.6',
    '<%= config.bin %> <%= command.id %> openrouter/minimax/minimax-m2.5',
    '<%= config.bin %> <%= command.id %> --list',
    '<%= config.bin %> <%= command.id %> --list --json',
    '<%= config.bin %> <%= command.id %> --current --json',
  ]

  static args = {
    model: Args.string({
      description:
        'Builder model id to store in defaults.builder_model. A curated id, or the same id with a leading openrouter/ prefix.',
      required: false,
    }),
  }

  static flags = {
    list: Flags.boolean({
      description: 'Print available builder models, one id per line',
      default: false,
    }),
    json: Flags.boolean({
      description: 'Print JSON. Use with --list or --current.',
      default: false,
    }),
    current: Flags.boolean({
      description: 'Print the current raw builder model id',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Model)
    try {
      if (flags.list) {
        if (flags.json) {
          this.log(JSON.stringify(MODELS, null, 2))
        } else {
          for (const model of MODELS) this.log(model.id)
        }
        return
      }

      if (flags.current) {
        const id = getCurrentBuilderModel()
        this.log(flags.json ? JSON.stringify({id}) : id)
        return
      }

      const modelId = args.model?.trim()
      if (modelId) {
        const stored = setBuilderModel(modelId)
        this.log(`✓ Builder model set to: ${stored}`)
        this.log('  Restart the builder to take effect (run `cast dev <agent>` again).')
        return
      }

      this.log(formatModelCatalog(getCurrentBuilderModel()))
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
