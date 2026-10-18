import {Args, Command} from '@oclif/core'
import {collectDeploymentStatus} from '../lib/deployment-status'

export default class Status extends Command {
  static description = 'Show Fly.io machine status, or the registry row for another provider'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-assistant',
    '<%= config.bin %> <%= command.id %> abc123',
  ]

  static args = {
    agent: Args.string({description: 'Agent name or deployment SHA', required: true}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(Status)
    const result = await collectDeploymentStatus(args.agent)
    if (result.status === 'error') {
      this.error(result.text)
    }
    const text = result.text.endsWith('\n') ? result.text : `${result.text}\n`
    process.stdout.write(text)
  }
}
