import {Command, Args, Flags} from '@oclif/core'
import {
  listSessions,
} from '../../lib/sessions'

function relativeTime(iso: string): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''
  const diff = Date.now() - then
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `${sec}s ago`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}d ago`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo ago`
  return `${Math.floor(mo / 12)}y ago`
}

function truncate(s: string | null | undefined, n: number): string {
  if (!s) return ''
  const oneLine = s.replace(/\s+/g, ' ').trim()
  return oneLine.length > n ? oneLine.slice(0, n - 1) + '…' : oneLine
}

export default class SessionList extends Command {
  static description = 'List saved conversation sessions'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --agent my-agent',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static flags = {
    agent: Flags.string({description: 'Filter by agent name'}),
    limit: Flags.integer({description: 'Maximum sessions to show', default: 50}),
    'include-ended': Flags.boolean({
      description: 'Include ended sessions (default: true)',
      default: true,
      allowNo: true,
    }),
    json: Flags.boolean({description: 'Output as JSON', default: false}),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(SessionList)
    const sessions = await listSessions({
      agentName: flags.agent,
      limit: flags.limit,
      includeEnded: flags['include-ended'],
    })

    if (flags.json) {
      this.log(JSON.stringify(sessions, null, 2))
      return
    }

    if (sessions.length === 0) {
      this.log('No sessions found.')
      this.log('Sessions are created automatically when you chat with an agent.')
      return
    }

    this.log('')
    this.log(`${sessions.length} session${sessions.length === 1 ? '' : 's'}${flags.agent ? ` for agent '${flags.agent}'` : ''}:`)
    this.log('──────────────────────────────────────────────────────────────────────────────')

    for (const s of sessions) {
      const title = s.name || truncate(s.first_user_message, 60) || '(untitled)'
      const ended = s.ended_at ? ' (ended)' : ''
      this.log(
        `  ${s.id}  ${title}${ended}`,
      )
      this.log(
        `    agent: ${s.agent_name} · ${s.message_count} msg · updated ${relativeTime(s.updated_at)}`,
      )
    }

    this.log('──────────────────────────────────────────────────────────────────────────────')
    this.log('')
    this.log('Commands:')
    this.log('  cast session show <id|name>          - Print a session transcript')
    this.log('  cast session resume <id|name>        - Open the session in the TUI')
    this.log('  cast session fork <id|name> [name]   - Fork into a new session')
    this.log('  cast session delete <id|name>        - Delete a session')
    this.log('  cast session prune [--days N]        - Delete ended sessions older than N days')
  }
}
