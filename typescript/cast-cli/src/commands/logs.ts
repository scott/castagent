import {Args, Command} from '@oclif/core'

export default class Logs extends Command {
  static description = 'View runtime logs'

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(Logs)
    this.log(`Viewing logs for ${args.agent}...`)
  }
}
