import {Args, Command} from '@oclif/core'
import {collectRuntimeLogs} from '../lib/runtime-logs'

export default class Logs extends Command {
  static description = 'Print local runtime logs, Docker container logs, Sprites service logs, or Fly.io logs'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-assistant',
    '<%= config.bin %> <%= command.id %> abc123',
  ]

  static args = {
    agent: Args.string({description: 'Agent name or deployment SHA', required: true}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(Logs)
    const result = await collectRuntimeLogs(args.agent)
    if (result.status === 'error') {
      this.error(result.text)
    }
    const text = result.text.endsWith('\n') ? result.text : `${result.text}\n`
    process.stdout.write(text)
  }
}
