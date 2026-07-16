import {Command, Args, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {createSession} from '../../lib/sessions'

export default class SessionNew extends Command {
  static description = 'Create a new conversation session'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent --name "auth experiment"',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    name: Flags.string({description: 'Optional name for the session'}),
    mode: Flags.string({description: 'Mode at session start', options: ['plan', 'build'], default: 'build'}),
    'ui-mode': Flags.string({
      description: 'UI mode at session start',
      options: ['dev', 'production', 'on-host'],
      default: 'dev',
    }),
    json: Flags.boolean({description: 'Output the new session as JSON', default: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(SessionNew)
    const agentName = args.agent

    // Validate agent exists
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}.`)
    }

    const sess = await createSession({
      agentName,
      mode: flags.mode,
      uiMode: flags['ui-mode'],
      name: flags.name ?? null,
    })

    if (flags.json) {
      this.log(JSON.stringify(sess, null, 2))
      return
    }

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║                  Session Created!                             ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Id:    ${sess.id}`)
    this.log(`Agent: ${sess.agent_name}`)
    if (sess.name) {
      this.log(`Name:  ${sess.name}`)
    }
    this.log('')
    this.log(`Open it in the TUI with:  cast session resume ${sess.id}`)
  }
}
