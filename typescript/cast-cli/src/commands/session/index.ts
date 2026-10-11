import {Command} from '@oclif/core'

export default class Session extends Command {
  static description = 'Manage conversation sessions'

  static examples = [
    '<%= config.bin %> session list',
    '<%= config.bin %> session show <id|name>',
    '<%= config.bin %> session new <agent>',
    '<%= config.bin %> session resume <id|name>',
    '<%= config.bin %> session rename <id> <name>',
    '<%= config.bin %> session fork <id> [name]',
    '<%= config.bin %> session delete <id>',
    '<%= config.bin %> session export <id> [--out file]',
    '<%= config.bin %> session import <file>',
    '<%= config.bin %> session prune [--days N]',
  ]

  async run(): Promise<void> {
    this.log('Cast session — manage conversation sessions for an agent.')
    this.log('')
    this.log('Subcommands:')
    this.log('  list     List saved sessions (newest first)')
    this.log('  show     Print a session transcript')
    this.log('  new      Create a new session for an agent')
    this.log('  resume   Open a session in the TUI')
    this.log('  rename   Rename a session')
    this.log('  fork     Fork a session into a new one')
    this.log('  delete   Delete a session')
    this.log('  export   Export a session to a JSON file')
    this.log('  import   Import a session from a JSON file')
    this.log('  prune    Delete ended sessions older than N days (default 30)')
    this.log('')
    this.log('A session is a saved, named conversation tied to an agent. It is')
    this.log('distinct from changes (which are an internal undo log of the agent')
    this.log("'s files) and from releases (which are the user-facing deployment")
    this.log('artifact). Use sessions to resume, fork, and audit conversations.')
    this.log('')
    this.log('Run `cast session <subcommand> --help` for full options.')
  }
}
