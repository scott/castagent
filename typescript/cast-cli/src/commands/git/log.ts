import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit, {SimpleGit} from 'simple-git'

export default class GitLog extends Command {
  static description = 'Show commit history for an agent'

  static examples = [
    '<%= config.bin %> git log my-agent',
    '<%= config.bin %> git log my-agent -n 20',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    count: Flags.integer({
      char: 'n',
      description: 'Number of commits to show (at least 1)',
      default: 10,
    }),
  }

  private getAgentsDir(): string {
    return path.join(os.homedir(), '.cast', 'agents')
  }

  private isGitRepo(agentPath: string): boolean {
    return fs.existsSync(path.join(agentPath, '.git'))
  }

  private formatDate(date: Date): string {
    return date.toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(GitLog)
    const agentName = args.agent
    const count = flags.count

    // simple-git omits --max-count when maxCount is 0 (the value is falsy),
    // and git treats a negative --max-count as unlimited. Both print the
    // full history. Reject them before calling log.
    if (count < 1) {
      this.error('--count must be >= 1')
    }

    const agentsDir = this.getAgentsDir()
    const agentPath = path.join(agentsDir, agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    if (!this.isGitRepo(agentPath)) {
      this.error(`'${agentName}' is not a Git repository. Run 'cast git init ${agentName}' first.`)
    }

    try {
      const git: SimpleGit = simpleGit(agentPath)
      const log = await git.log({maxCount: count})

      if (log.all.length === 0) {
        this.log('No commits found.')
        return
      }

      this.log(`Agent: ${agentName}`)
      this.log(`Commit history (last ${log.all.length} commits):`)
      this.log('')

      for (const commit of log.all) {
        this.log(`commit ${commit.hash}`)
        this.log(`Date:   ${this.formatDate(new Date(commit.date))}`)
        this.log(`Author: ${commit.author_name} <${commit.author_email}>`)
        this.log('')
        this.log(`    ${commit.message}`)
        this.log('')
      }

    } catch (error: any) {
      this.error(`Failed to get log: ${error.message}`)
    }
  }
}