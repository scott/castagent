import {Args, Command, Flags} from '@oclif/core'
import {enableInferenceProvider} from '../../lib/inference-provider'

const ARGV_TOKEN_WARNING = 'Warning: a model access key on the command line is visible in process listings and shell history. Prefer: cast provider enable <key> --token -\n'

export default class ProviderEnable extends Command {
  static description = 'Store an inference provider token and optional API URL'

  static examples = [
    '<%= config.bin %> <%= command.id %> digitalocean --token -',
    '<%= config.bin %> <%= command.id %> openrouter --token -',
    '<%= config.bin %> <%= command.id %> gemini --token -',
    '<%= config.bin %> <%= command.id %> anthropic-api --token -',
    '<%= config.bin %> <%= command.id %> digitalocean --token - --url https://inference.do-ai.run/v1',
  ]

  private promptForToken = false

  async init(): Promise<void> {
    const index = this.argv.indexOf('--token')
    if (index !== -1) {
      const next = this.argv[index + 1]
      const missing = next === undefined || (next.startsWith('-') && next !== '-')
      if (missing) {
        this.argv.splice(index + 1, 0, '-')
        this.promptForToken = true
      }
    }
    await super.init()
  }

  static args = {
    provider: Args.string({
      description: 'Inference provider key',
      required: true,
    }),
  }

  static flags = {
    token: Flags.string({
      description: 'Model access key. Use --token - to read it from stdin, or --token with no value to type it without echo. The key is stored in the system keychain.',
    }),
    url: Flags.string({
      description: 'API base URL, including the /v1 path',
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(ProviderEnable)
    try {
      let token = flags.token
      if (token && token !== '-') {
        process.stderr.write(ARGV_TOKEN_WARNING)
      } else if (token === '-' && (this.promptForToken || process.stdin.isTTY)) {
        token = await promptHidden('Model access key: ')
      }
      const result = await enableInferenceProvider(args.provider, {
        token,
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

/** Read a secret from the terminal without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    const output = process.stderr
    output.write(question)
    const raw = Boolean(stdin.isTTY && stdin.setRawMode)
    if (raw) stdin.setRawMode(true)
    stdin.resume()
    let value = ''
    const finish = (result: string | Error) => {
      stdin.removeListener('data', onData)
      if (raw) stdin.setRawMode(false)
      stdin.pause()
      if (result instanceof Error) reject(result)
      else resolve(result)
    }
    const onData = (chunk: Buffer | string) => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      for (const ch of text) {
        if (ch === '\u0003') {
          output.write('\n')
          finish(new Error('Canceled.'))
          return
        }
        if (ch === '\r' || ch === '\n') {
          output.write('\n')
          finish(value.trim())
          return
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1)
          continue
        }
        if (ch === '\u0004') continue
        value += ch
      }
    }
    stdin.on('data', onData)
  })
}
