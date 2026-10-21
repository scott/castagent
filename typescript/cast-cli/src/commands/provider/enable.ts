import {Args, Command, Flags} from '@oclif/core'
import {enableInferenceProvider} from '../../lib/inference-provider'

export default class ProviderEnable extends Command {
  static description = 'Store an inference provider token and optional API URL'

  static examples = [
    '<%= config.bin %> <%= command.id %> digitalocean --token <model-access-key> --url https://inference.do-ai.run/v1',
    '<%= config.bin %> <%= command.id %> openrouter --token <key>',
    '<%= config.bin %> <%= command.id %> digitalocean --url https://inference.example/v1',
  ]

  static args = {
    provider: Args.string({
      description: 'Inference provider key',
      required: true,
    }),
  }

  static flags = {
    token: Flags.string({
      description: 'Model access key. Use - to read the key from stdin. The key is stored in the system keychain.',
    }),
    url: Flags.string({
      description: 'OpenAI-compatible base URL, including the /v1 path',
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(ProviderEnable)
    try {
      const result = await enableInferenceProvider(args.provider, {
        token: flags.token,
        url: flags.url,
      })
      this.log(`✓ Inference provider ${args.provider} updated.`)
      this.log(`  Base URL: ${result.baseUrl}`)
      if (result.tokenStore === 'keychain') this.log('  Token stored in the system keychain.')
      if (result.tokenStore === 'file') this.log('  Token stored in ~/.cast/tokens/inference/ (mode 0600).')
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }
}
