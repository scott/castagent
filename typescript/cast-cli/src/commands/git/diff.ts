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
    '<%= config.bin %> git diff my-agent --file instructions.md',
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
      description: 'Show diff for a specific file. Errors if the path is not in the repository.',
    }),
  }

  private getAgentsDir(): string {
    return path.join(os.homedir(), '.cast', 'agents')
  }

  private isGitRepo(agentPath: string): boolean {
    return fs.existsSync(path.join(agentPath, '.git'))
  }

  /**
   * Path relative to the agent repo, or undefined when it points outside.
   */
  private repoRelativePath(agentPath: string, file: string): string | undefined {
    if (!file.trim()) return undefined
    const resolved = path.resolve(agentPath, file)
    const relative = path.relative(agentPath, resolved)
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return undefined
    }
    return relative.split(path.sep).join('/')
  }

  /**
   * A path is in the repo when it exists in the working tree, the index, or HEAD.
   * A missing path must not fall through to the full diff.
   */
  private async pathInRepo(git: SimpleGit, agentPath: string, relativeFile: string): Promise<boolean> {
    if (fs.existsSync(path.join(agentPath, relativeFile))) return true

    const listed = await git.raw(['ls-files', '--', relativeFile])
    if (listed.trim().length > 0) return true

    try {
      await git.raw(['cat-file', '-e', `HEAD:${relativeFile}`])
      return true
    } catch {
      return false
    }
  }

  private matchesRequestedPath(candidate: string, relativeFile: string): boolean {
    const name = candidate.split(path.sep).join('/')
    return name === relativeFile || name.startsWith(`${relativeFile}/`)
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(GitDiff)
    const agentName = args.agent
    const ref = args.ref
    const requestedFile = flags.file

    const agentsDir = this.getAgentsDir()
    const agentPath = path.join(agentsDir, agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    if (!this.isGitRepo(agentPath)) {
      this.error(`'${agentName}' is not a Git repository. Run 'cast git init ${agentName}' first.`)
    }

    let relativeFile: string | undefined
    if (requestedFile !== undefined) {
      relativeFile = this.repoRelativePath(agentPath, requestedFile)
      if (!relativeFile) {
        this.error(`File '${requestedFile}' is not in the repository.`)
      }
    }

    try {
      const git: SimpleGit = simpleGit(agentPath)
      const pathspec = relativeFile ? ['--', relativeFile] : []

      if (relativeFile && !(await this.pathInRepo(git, agentPath, relativeFile))) {
        this.error(`File '${requestedFile}' is not in the repository.`)
      }

      if (flags.staged) {
        const diff = await git.diff(['--staged', ...pathspec])
        if (diff) {
          this.log(`Staged changes for '${agentName}':`)
          this.log('')
          this.log(diff)
        } else if (relativeFile) {
          this.log(`No staged changes for '${relativeFile}'.`)
        } else {
          this.log('No staged changes.')
        }
        return
      }

      if (ref) {
        const diff = await git.diff([ref, ...pathspec])
        if (diff) {
          this.log(`Changes since ${ref}:`)
          this.log('')
          this.log(diff)
        } else if (relativeFile) {
          this.log(`No changes for '${relativeFile}' since ${ref}.`)
        } else {
          this.log(`No changes since ${ref}.`)
        }
        return
      }

      if (relativeFile) {
        const diff = await git.diff(pathspec)
        if (diff) {
          this.log(`Uncommitted changes for '${agentName}':`)
          this.log('')
          this.log(diff)
          return
        }

        const status = await git.status()
        const untracked = status.not_added.filter(name => this.matchesRequestedPath(name, relativeFile))
        if (untracked.length > 0) {
          this.log('Untracked files:')
          for (const file of untracked) {
            this.log(`  ?? ${file}`)
          }
          return
        }

        this.log(`No changes for '${relativeFile}'.`)
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
      if (error?.oclif) throw error
      this.error(`Failed to get diff: ${error.message}`)
    }
  }
}
