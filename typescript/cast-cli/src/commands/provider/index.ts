import {Args, Command, Flags} from '@oclif/core'
import {
  formatProviderList,
  listInferenceProviders,
  switchInferenceProvider,
} from '../../lib/inference-provider'

export default class Provider extends Command {
  static description = 'Show or switch the inference provider the builder uses. The model prefix selects the provider. openai/, anthropic/, google/, and x-ai/ stay on OpenRouter. openai-api/ is direct OpenAI. xai/ is xAI. gemini/<model> is Google Gemini. bedrock/<profile> is Amazon Bedrock. Direct prefixes anthropic-api/ and ollama/ are reserved.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> openrouter',
    '<%= config.bin %> <%= command.id %> digitalocean',
    '<%= config.bin %> <%= command.id %> gemini',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --current',
  ]

  static args = {
    provider: Args.string({
      description: 'Inference provider key to switch to, when that provider is enabled',
      required: false,
    }),
  }

  static flags = {
    json: Flags.boolean({
      description: 'Print the provider list as JSON',
      default: false,
    }),
    current: Flags.boolean({
      description: 'Print the active inference provider key',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Provider)
    try {
      const key = args.provider?.trim()
      if (key) {
        const switched = await switchInferenceProvider(key)
        if (switched.needsModel) {
          this.log(`'${key}' needs a model before it becomes the builder provider.`)
          this.log(`  Set a model with: cast model ${key}/<model-id>`)
          return
        }
        this.log(`✓ Inference provider set to: ${switched.provider}`)
        if (switched.model) this.log(`  Builder model: ${switched.model}`)
        this.log('  Restart the builder to take effect (run `cast dev <agent>` again).')
        return
      }

      const rows = await listInferenceProviders()
      if (flags.current) {
        const current = rows.find(row => row.current)
        const id = current?.key ?? ''
        this.log(flags.json ? JSON.stringify({key: id}) : id)
        return
      }
      if (flags.json) {
        this.log(JSON.stringify(rows, null, 2))
        return
      }
      this.log(formatProviderList(rows))
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
