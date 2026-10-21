import {Args, Command, Flags} from '@oclif/core'
import {activeModelCatalog, applyBuilderModel} from '../lib/inference-provider'
import {
  formatModelCatalog,
  getCurrentBuilderModel,
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
        'Builder model id. A curated id, openrouter/<id>, or <prefix>/<id> for an enabled provider. A freeform provider accepts any id with its prefix.',
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
      const catalog = await activeModelCatalog()
      if (flags.list) {
        if (flags.json) {
          this.log(JSON.stringify(catalog.models, null, 2))
        } else {
          for (const model of catalog.models) this.log(model.id)
          if (catalog.fallback) {
            this.log('Live catalog could not be loaded. Showing starter models.')
          }
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
        const stored = await applyBuilderModel(modelId)
        this.log(`✓ Builder model set to: ${stored}`)
        this.log('  Restart the builder to take effect (run `cast dev <agent>` again).')
        return
      }

      const listing = formatModelCatalog(getCurrentBuilderModel(), catalog.models)
      this.log(catalog.fallback
        ? `${listing}\nLive catalog could not be loaded. Showing starter models.`
        : listing)
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
