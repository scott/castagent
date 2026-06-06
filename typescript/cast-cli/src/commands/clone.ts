import {Args, Command} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit, {SimpleGit} from 'simple-git'
import * as yaml from 'yaml'

export default class Clone extends Command {
  static description = 'Clone an agent from a Git repository'

  static examples = [
    '<%= config.bin %> clone https://github.com/user/my-agent',
    '<%= config.bin %> clone git@github.com:user/my-agent.git',
    '<%= config.bin %> clone https://github.com/user/my-agent cool-agent',
  ]

  static args = {
    url: Args.string({description: 'Git repository URL', required: true}),
    name: Args.string({description: 'Local agent name (optional, defaults to repo name)', required: false}),
  }

  private getAgentsDir(): string {
    return path.join(os.homedir(), '.cast', 'agents')
  }

  private extractRepoName(url: string): string {
    const match = url.match(/\/([^\/]+?)(?:\.git)?$/)
    return match ? match[1] : 'agent'
  }

  private validateUrl(url: string): boolean {
    const patterns = [
      /^https?:\/\/.+\/.+\/.+\.git$/,
      /^https?:\/\/.+\/.+\/[^\/]+$/,
      /^git@.+:.+\/.+\.git$/,
      /^git@.+:.+\/.+$/,
    ]
    return patterns.some(p => p.test(url))
  }

  private isValidAgent(agentPath: string): boolean {
    return fs.existsSync(path.join(agentPath, 'agent.yaml'))
  }

  private initLocalRepo(agentPath: string, remoteUrl: string): void {
    const git: SimpleGit = simpleGit(agentPath)

    const remotes = fs.existsSync(path.join(agentPath, '.git'))
    if (remotes) {
      return
    }

    git.init()
    git.addRemote('origin', remoteUrl)
  }

  private updateAgentYaml(agentPath: string, url: string): void {
    const configPath = path.join(agentPath, 'agent.yaml')
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, 'utf-8')
      const config = yaml.parse(content) || {}

      config.repository = {
        remote: 'origin',
        url: url,
        branch: 'main',
      }

      fs.writeFileSync(configPath, yaml.stringify(config))
    }
  }

  async run(): Promise<void> {
    const {args} = await this.parse(Clone)
    const url = args.url
    const requestedName = args.name

    if (!this.validateUrl(url)) {
      this.error(
        `Invalid Git URL: ${url}\n` +
        `Expected formats:\n` +
        `  - https://github.com/user/repo.git\n` +
        `  - git@github.com:user/repo.git`
      )
    }

    const repoName = this.extractRepoName(url)
    const agentName = requestedName || repoName

    const agentsDir = this.getAgentsDir()

    if (!fs.existsSync(agentsDir)) {
      fs.mkdirSync(agentsDir, {recursive: true})
    }

    const agentPath = path.join(agentsDir, agentName)

    if (fs.existsSync(agentPath)) {
      this.error(
        `Agent '${agentName}' already exists at ${agentPath}.\n` +
        `Remove it first with: cast delete ${agentName}\n` +
        `Or use a different name as the second argument.`
      )
    }

    this.log(`Cloning ${url}...`)
    this.log('')

    try {
      fs.mkdirSync(agentPath, {recursive: true})

      const git: SimpleGit = simpleGit()
      await git.clone(url, agentPath, ['--single-branch'])

      if (!this.isValidAgent(agentPath)) {
        fs.rmSync(agentPath, {recursive: true, force: true})
        this.error(
          `Cloned repository does not contain a valid Cast agent.\n` +
          `Expected to find 'agent.yaml' in the root directory.`
        )
      }

      this.initLocalRepo(agentPath, url)
      this.updateAgentYaml(agentPath, url)

      const gitLog = simpleGit(agentPath)
      const log = await gitLog.log({maxCount: 5})

      this.log(`Successfully cloned agent '${agentName}'!`)
      this.log('')
      this.log('Next steps:')
      this.log(`  - Run the agent: cast dev ${agentName}`)
      this.log(`  - Check git status: cast git status ${agentName}`)
      this.log(`  - View commit history: cast git log ${agentName}`)

      if (log.all.length > 0) {
        this.log('')
        this.log(`Imported ${log.all.length} commit(s).`)
      }

    } catch (error: any) {
      if (fs.existsSync(agentPath)) {
        fs.rmSync(agentPath, {recursive: true, force: true})
      }

      if (error.message.includes('Authentication failed') || error.message.includes('Permission denied')) {
        this.error(
          `Authentication failed.\n` +
          `Please ensure you have access to the repository and correct credentials.\n` +
          `You may need to:\n` +
          `  - Configure SSH keys for the Git host\n` +
          `  - Use a GitHub token for HTTPS URLs`
        )
      }

      this.error(`Failed to clone: ${error.message}`)
    }
  }
}