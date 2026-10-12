import {Args, Command, Flags} from '@oclif/core'
import {
  assertImportTargetAvailable,
  formatCloneError,
  importAgent,
  planAgentImport,
  type PlannedImport,
} from '../lib/agent-import'

export default class Clone extends Command {
  static description = 'Clone an agent from a Git repository or a local directory'

  static examples = [
    '<%= config.bin %> clone https://github.com/user/my-agent',
    '<%= config.bin %> clone git@github.com:user/my-agent.git',
    '<%= config.bin %> clone https://github.com/user/my-agent cool-agent',
    '<%= config.bin %> clone user/my-agent',
    '<%= config.bin %> clone ./path/to/local-agent',
    '<%= config.bin %> clone /absolute/path/to/local-agent my-local-name',
    '<%= config.bin %> clone ./path/to/local-agent my-local-name --force',
  ]

  static flags = {
    force: Flags.boolean({
      char: 'f',
      description: 'Overwrite an existing agent directory',
      default: false,
    }),
  }

  static args = {
    url: Args.string({
      description: 'Git URL, GitHub user/repo, or local path',
      required: true,
    }),
    name: Args.string({
      description: 'Local agent name (optional, defaults to repo or directory name)',
      required: false,
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Clone)
    const source = args.url
    const requestedName = args.name

    let plan: PlannedImport
    try {
      plan = planAgentImport(source, {name: requestedName})
    } catch (error) {
      this.error(formatCloneError(error, {agentPath: '', source}))
    }

    try {
      assertImportTargetAvailable(plan, flags.force)
    } catch (error) {
      this.error(formatCloneError(error, {agentPath: plan.agentPath, source}))
    }

    if (plan.kind === 'git') {
      this.log(`Cloning ${plan.location}...`)
      this.log('')
    }

    try {
      const result = await importAgent(source, {name: requestedName, force: flags.force})
      if (result.kind === 'local') {
        this.log(`Imported '${result.name}' from ${result.source}.`)
        this.log('')
        this.log('Next steps:')
        this.log(`- cast dev ${result.name}`)
        this.log(`- cast edit ${result.name}`)
        this.log(`- cast deploy ${result.name} --provider docker`)
        return
      }

      this.log(`Successfully cloned agent '${result.name}'!`)
      this.log('')
      this.log('Next steps:')
      this.log(`  - Run the agent: cast dev ${result.name}`)
      this.log(`  - Check git status: cast git status ${result.name}`)
      this.log(`  - View commit history: cast git log ${result.name}`)

      if (result.commitCount > 0) {
        this.log('')
        this.log(`Imported ${result.commitCount} commit(s).`)
      }
    } catch (error) {
      this.error(formatCloneError(error, {agentPath: plan.agentPath, source}))
    }
  }
}
