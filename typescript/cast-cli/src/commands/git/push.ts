import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit, {SimpleGit} from 'simple-git'

export default class GitPush extends Command {
  static description = 'Push commits to the remote repository'

  static examples = [
    '<%= config.bin %> git push my-agent',
    '<%= config.bin %> git push my-agent origin main',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  static flags = {
    remote: Flags.string({
      description: 'Remote name',
      default: 'origin',
    }),
    branch: Flags.string({
      description: 'Branch name',
      default: 'main',
    }),
  }

  private getAgentsDir(): string {
    return path.join(os.homedir(), '.cast', 'agents')
  }

  private isGitRepo(agentPath: string): boolean {
    return fs.existsSync(path.join(agentPath, '.git'))
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(GitPush)
    const agentName = args.agent
    const remote = flags.remote
    const branch = flags.branch

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

      const remotes = await git.getRemotes()
      const remoteExists = remotes.some(r => r.name === remote)

      if (!remoteExists) {
        this.error(
          `Remote '${remote}' does not exist.\n` +
          `Add a remote with: cast git remote ${agentName} add ${remote} <url>`
        )
      }

      this.log(`Pushing to ${remote}/${branch}...`)

      const result = await git.push(remote, branch)

      if (result.pushed && result.pushed.length > 0) {
        this.log('')
        this.log(`Successfully pushed ${result.pushed.length} commit(s) to ${remote}/${branch}`)
        for (const push of result.pushed) {
          const pushItem = push as any
          const commit = pushItem.commit || 'unknown'
          this.log(`  ${pushItem.ref || remote}/${branch}: ${String(commit).substring(0, 7)}`)
        }
      } else {
        this.log('Everything up-to-date - no commits to push.')
      }

    } catch (error: any) {
      if (error.message.includes('Authentication failed') || error.message.includes('Permission denied')) {
        this.error(
          `Authentication failed.\n` +
          `Please ensure you have the correct credentials for the remote.\n` +
          `You may need to:\n` +
          `  - Configure SSH keys\n` +
          `  - Use a GitHub token instead of password\n` +
          `  - Check your remote URL`
        )
      }
      this.error(`Failed to push: ${error.message}`)
    }
  }
}