import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import {
  GITHUB_SOURCE_HINT,
  SkillError,
  addedMessage,
  formatSkillsText,
  installFromFolder,
  installFromGitHub,
  installFromModal,
  listSkills,
  parseGitHubSource,
  readSkillBody,
  removeSkill,
  removedMessage,
} from '../lib/skills'

export default class Skills extends Command {
  static description = 'List, add, or remove skills on a user agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> email-agent --json',
    '<%= config.bin %> <%= command.id %> add email-agent --github owner/repo',
    '<%= config.bin %> <%= command.id %> add email-agent --github owner/repo --ref main --subpath skills/triage',
    '<%= config.bin %> <%= command.id %> add email-agent --folder ~/skills/triage',
    '<%= config.bin %> <%= command.id %> add email-agent --name triage --description "Sort mail" --body "# Triage"',
    '<%= config.bin %> <%= command.id %> add email-agent --name triage --description "Sort mail" --body -',
    '<%= config.bin %> <%= command.id %> remove email-agent triage',
  ]

  // oclif feeds stdin to the first missing arg. That would consume the pipe
  // before `--body -` can read the markdown, so every arg opts out.
  static args = {
    target: Args.string({
      description: 'Agent name, or add, or remove',
      required: true,
      ignoreStdin: true,
    }),
    agent: Args.string({
      description: 'Agent name when adding or removing',
      ignoreStdin: true,
    }),
    skill: Args.string({
      description: 'Skill name when removing',
      ignoreStdin: true,
    }),
  }

  static flags = {
    json: Flags.boolean({
      description: 'Print installed skills as JSON',
      default: false,
    }),
    github: Flags.string({
      description: 'GitHub repo (owner/repo, owner/repo@ref, or a github.com URL)',
    }),
    ref: Flags.string({
      description: 'Git ref to clone (branch or tag)',
    }),
    subpath: Flags.string({
      description: 'Directory inside the repo that contains SKILL.md',
    }),
    folder: Flags.string({
      description: 'Absolute path, or a path starting with ~, that contains SKILL.md',
    }),
    name: Flags.string({
      description: 'Skill name for an inline skill',
    }),
    description: Flags.string({
      description: 'One-line skill description for an inline skill',
    }),
    body: Flags.string({
      description: 'Skill markdown body for an inline skill. Use - to read stdin.',
    }),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Skills)
    if (args.target === 'add') {
      this.add(args.agent, flags)
      return
    }
    if (args.target === 'remove') {
      this.remove(args.agent, args.skill)
      return
    }
    if (args.agent || args.skill) {
      this.error('Usage: cast skills <agent> [--json]')
    }
    this.list(args.target, Boolean(flags.json))
  }

  private list(agentName: string, asJson: boolean): void {
    const skills = this.install(() => listSkills(agentName))
    if (asJson) {
      this.log(JSON.stringify(skills, null, 2))
      return
    }
    this.log(formatSkillsText(agentName, skills))
  }

  private add(agentName: string | undefined, flags: {
    github?: string
    ref?: string
    subpath?: string
    folder?: string
    name?: string
    description?: string
    body?: string
  }): void {
    if (!agentName) {
      this.error('Usage: cast skills add <agent> (--github <repo> | --folder <path> | --name <name> --description <text> --body <markdown>)')
    }
    const modes = [flags.github, flags.folder, flags.name].filter((value) => value !== undefined)
    if (modes.length !== 1) {
      this.error('Use only one of --github, --folder, or --name.')
    }
    const github = flags.github
    if (github !== undefined) {
      const parsed = parseGitHubSource(github)
      if (!parsed) this.error(GITHUB_SOURCE_HINT)
      const ref = flags.ref || parsed.ref
      const subpath = flags.subpath || parsed.subpath
      const entry = this.install(() => installFromGitHub({
        agentName,
        repo: parsed.repo,
        ref,
        subpath,
        sourceLabel: github,
      }))
      this.log(addedMessage(agentName, entry))
      return
    }
    if (flags.folder !== undefined) {
      const entry = this.install(() => installFromFolder({agentName, folder: flags.folder ?? ''}))
      this.log(addedMessage(agentName, entry))
      return
    }
    if (!flags.description || flags.body === undefined) {
      this.error('Usage: cast skills add <agent> --name <name> --description <text> --body <markdown>')
    }
    const body = readSkillBody(flags.body, () => fs.readFileSync(0, 'utf8'))
    const entry = this.install(() => installFromModal({
      agentName,
      name: flags.name ?? '',
      description: flags.description ?? '',
      body,
    }))
    this.log(addedMessage(agentName, entry))
  }

  private install<T>(fn: () => T): T {
    try {
      return fn()
    } catch (err) {
      if (err instanceof SkillError && err.code === 'multiple') {
        this.log(JSON.stringify(err.details, null, 2))
        this.exit(2)
      }
      const message = err instanceof Error ? err.message : String(err)
      this.error(message)
    }
  }

  private remove(agentName: string | undefined, skillName: string | undefined): void {
    if (!agentName || !skillName) {
      this.error('Usage: cast skills remove <agent> <name>')
    }
    this.install(() => removeSkill(agentName, skillName))
    this.log(removedMessage(skillName, agentName))
  }
}
