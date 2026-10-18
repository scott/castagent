import {Args, Command, Flags} from '@oclif/core'
import {defaultStopAgentDeps, stopAgent} from '../lib/stop-agent'

export default class Stop extends Command {
  static description = 'Stop a running local agent, Docker deployment, DigitalOcean droplet, or Fly.io machine'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> email-agent --force',
  ]

  static flags = {
    force: Flags.boolean({description: 'Force kill (SIGKILL instead of SIGTERM)'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Stop)
    const result = await stopAgent(args.agent, {force: flags.force}, {
      ...defaultStopAgentDeps(),
      onLog: (text) => this.log(text),
      onWarn: (text) => this.warn(text),
    })

    if (result.status === 'error') {
      const text = result.messages
        .filter(message => message.kind === 'error')
        .map(message => message.text)
        .join('\n')
      this.error(text)
    }
  }
}
