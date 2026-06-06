import {Args, Command} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit, {SimpleGit} from 'simple-git'

export default class GitStatus extends Command {
  static description = 'Show the working tree status of an agent'

  static examples = [
    '<%= config.bin %> git status my-agent',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  private getAgentsDir(): string {
    return path.join(os.homedir(), '.cast', 'agents')
  }

  private isGitRepo(agentPath: string): boolean {
    return fs.existsSync(path.join(agentPath, '.git'))
  }

  async run(): Promise<void> {
    const {args} = await this.parse(GitStatus)
    const agentName = args.agent

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
      const status = await git.status()

      this.log(`Agent: ${agentName}`)
      this.log('')

      if (status.isClean()) {
        this.log('✓ Working tree is clean')
      } else {
        if (status.current) {
          this.log(`Current branch: ${status.current}`)
        }

        if (status.tracking) {
          this.log(`Tracking: ${status.tracking}`)
        }

        this.log('')

        if (status.modified.length > 0) {
          this.log('Modified files:')
          for (const file of status.modified) {
            this.log(`  M ${file}`)
          }
          this.log('')
        }

        if (status.not_added.length > 0) {
          this.log('Untracked files:')
          for (const file of status.not_added) {
            this.log(`  ?? ${file}`)
          }
          this.log('')
        }

        if (status.staged.length > 0) {
          this.log('Staged files:')
          for (const file of status.staged) {
            this.log(`  A ${file}`)
          }
          this.log('')
        }

        if (status.deleted.length > 0) {
          this.log('Deleted files:')
          for (const file of status.deleted) {
            this.log(`  D ${file}`)
          }
          this.log('')
        }

        const ahead = status.ahead
        const behind = status.behind

        if (ahead > 0 || behind > 0) {
          this.log('Sync status:')
          if (ahead > 0) {
            this.log(`  ${ahead} commit(s) ahead of remote`)
          }
          if (behind > 0) {
            this.log(`  ${behind} commit(s) behind remote`)
          }
          this.log('')
        }
      }

      const remotes = await git.getRemotes(true)
      if (remotes.length > 0) {
        this.log('Remotes:')
        for (const remote of remotes) {
          this.log(`  ${remote.name} → ${(remote as any).refs?.fetch || 'N/A'}`)
        }
      } else {
        this.log('No remotes configured. Use "cast git remote create" to add one.')
      }

    } catch (error: any) {
      this.error(`Failed to get status: ${error.message}`)
    }
  }
}