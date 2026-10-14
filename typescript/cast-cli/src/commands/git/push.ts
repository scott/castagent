import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit, {PushResult, SimpleGit} from 'simple-git'

export default class GitPush extends Command {
  static description = 'Push commits to the remote repository'

  static examples = [
    '<%= config.bin %> git push my-agent',
    '<%= config.bin %> git push my-agent --branch main',
    '<%= config.bin %> git push my-agent --remote upstream --branch feature/x',
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
      description: 'Branch to push. Defaults to the current branch.',
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

      const branch = await this.resolveBranch(git, flags.branch, agentName)

      this.log(`Pushing to ${remote}/${branch}...`)

      const result = await git.push(remote, branch)
      await this.reportPush(git, result, remote, branch)

    } catch (error: any) {
      if (error?.oclif) throw error
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

  private async resolveBranch(git: SimpleGit, requested: string | undefined, agentName: string): Promise<string> {
    const branch = requested?.trim()
    if (branch) return branch

    const status = await git.status()
    if (status.detached || !status.current) {
      this.error(
        `HEAD is detached, so there is no current branch to push.\n` +
        `Pass one with: cast git push ${agentName} --branch <name>`
      )
    }
    return status.current
  }

  private async reportPush(git: SimpleGit, result: PushResult, remote: string, branch: string): Promise<void> {
    const target = `${remote}/${branch}`
    const updatedTo = result.update?.hash?.to
    const created = (result.pushed ?? []).some(item => item.new)

    if (!updatedTo && !created) {
      const pushed = result.pushed ?? []
      const unchanged = pushed.length === 0 || pushed.every(item => item.alreadyUpdated)
      if (unchanged) {
        this.log(`Everything up-to-date at ${target}`)
        return
      }
    }

    const hash = updatedTo ?? await this.headHash(git, branch)
    this.log('')
    this.log(`Successfully pushed to ${target}`)
    if (hash) {
      this.log(`  ${target}: ${hash.substring(0, 7)}`)
    }
  }

  private async headHash(git: SimpleGit, branch: string): Promise<string | undefined> {
    try {
      const hash = (await git.revparse([branch])).trim()
      return hash || undefined
    } catch {
      return undefined
    }
  }
}
