import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit, {SimpleGit} from 'simple-git'

export default class GitDiff extends Command {
  static description = 'Show changes between commits or working tree'

  static examples = [
    '<%= config.bin %> git diff my-agent',
    '<%= config.bin %> git diff my-agent HEAD~1',
    '<%= config.bin %> git diff my-agent --staged',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
    ref: Args.string({description: 'Commit reference (optional)', required: false}),
  }

  static flags = {
    staged: Flags.boolean({
      description: 'Show staged changes',
    }),
    file: Flags.string({
      description: 'Show diff for specific file',
    }),
  }

  private getAgentsDir(): string {
    return path.join(os.homedir(), '.cast', 'agents')
  }

  private isGitRepo(agentPath: string): boolean {
    return fs.existsSync(path.join(agentPath, '.git'))
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(GitDiff)
    const agentName = args.agent
    const ref = args.ref

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

      if (flags.staged) {
        const diff = await git.diff(['--staged'])
        if (diff) {
          this.log(`Staged changes for '${agentName}':`)
          this.log('')
          this.log(diff)
        } else {
          this.log('No staged changes.')
        }
        return
      }

      if (ref) {
        const diff = await git.diff([ref])
        if (diff) {
          this.log(`Changes since ${ref}:`)
          this.log('')
          this.log(diff)
        } else {
          this.log(`No changes since ${ref}.`)
        }
        return
      }

      const status = await git.status()
      if (status.isClean()) {
        this.log('Working tree is clean - no changes to show.')
        return
      }

      const diff = await git.diff()
      if (diff) {
        this.log(`Uncommitted changes for '${agentName}':`)
        this.log('')
        this.log(diff)
      }

      if (status.not_added.length > 0) {
        this.log('')
        this.log('Untracked files:')
        for (const file of status.not_added) {
          this.log(`  ?? ${file}`)
        }
      }

    } catch (error: any) {
      this.error(`Failed to get diff: ${error.message}`)
    }
  }
}