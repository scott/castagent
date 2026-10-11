import {Command, Args} from '@oclif/core'
import {getSession} from '../../lib/sessions'
import {execFileSync} from 'child_process'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'

/**
 * Open the TUI in a specific session.
 *
 * In a real install this would shell out to the TUI with a `--session`
 * flag, but the TUI's session-aware launch is wired in Phase 3. For now
 * we just print the resolved session so the command is testable and the
 * CLI surface exists; the underlying TUI launcher is added in Phase 3.
 */
export default class SessionResume extends Command {
  static description = 'Resume a session in the TUI'

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

  private findTuiBinary(): string | null {
    const candidates = [
      'cast',
      path.resolve(__dirname, '../../../cast-tui/bin/run'),
      path.resolve(__dirname, '../../../../cast-tui/bin/run'),
    ]
    for (const c of candidates) {
      try {
        if (c === 'cast') {
          const p = execFileSync('which', ['cast'], {encoding: 'utf8', timeout: 5000}).trim()
          if (p && fs.existsSync(p)) return p
        } else if (fs.existsSync(c)) {
          return c
        }
      } catch {
        // try next
      }
    }
    return null
  }

  async run(): Promise<void> {
    const {args} = await this.parse(SessionResume)
    const sess = await getSession(args.identifier)
    if (!sess) {
      this.error(`Session not found: ${args.identifier}`)
    }

    const tui = this.findTuiBinary()
    if (!tui) {
      this.error('Could not locate the cast TUI. Run `cast` to start the TUI manually.')
    }

    this.log(`Resuming session ${sess.id} for agent '${sess.agent_name}'...`)
    try {
      execFileSync(tui, ['--session', sess.id], {stdio: 'inherit'})
    } catch (error: any) {
      // If the TUI doesn't yet understand --session, fall back to plain launch.
      try {
        execFileSync(tui, [sess.agent_name], {stdio: 'inherit'})
      } catch {
        this.error(`Failed to launch TUI: ${error?.message ?? error}`)
      }
    }
  }
}
