import {Command, Args} from '@oclif/core'
import {getSession} from '../../lib/sessions'

export default class SessionShow extends Command {
  static description = 'Print a session transcript'

  static examples = [
    '<%= config.bin %> <%= command.id %> 01JABC…',
    '<%= config.bin %> <%= command.id %> my-session',
  ]

  static args = {
    identifier: Args.string({
      description: 'Session id (or name)',
      required: true,
    }),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(SessionShow)
    const sess = await getSession(args.identifier)
    if (!sess) {
      this.error(`Session not found: ${args.identifier}`)
    }

    this.log('')
    this.log(`Session: ${sess.name ?? '(untitled)'}  (${sess.id})`)
    this.log(`Agent:   ${sess.agent_name}`)
    this.log(`Mode:    ${sess.mode} · ${sess.ui_mode}`)
    this.log(`Started: ${sess.created_at}`)
    this.log(`Updated: ${sess.updated_at}${sess.ended_at ? ` · ended ${sess.ended_at}` : ''}`)
    if (sess.parent_session_id) {
      this.log(`Forked from: ${sess.parent_session_id}`)
    }
    if (sess.agent_version_at_start) {
      this.log(`Agent version at start: ${sess.agent_version_at_start}`)
    }
    this.log('──────────────────────────────────────────────────────────────────────────────')

    if (sess.messages.length === 0) {
      this.log('(no messages)')
    } else {
      for (const m of sess.messages) {
        const role = m.role === 'user' ? 'You' : 'Agent'
        this.log('')
        this.log(`[${role}]  ${m.ts}`)
        this.log(m.text)
      }
    }

    this.log('')
    this.log('──────────────────────────────────────────────────────────────────────────────')
  }
}
