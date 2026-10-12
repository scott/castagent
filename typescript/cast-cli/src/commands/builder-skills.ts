import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import {
  BuilderSkillError,
  installFromFields,
  installFromFolder,
  installFromGithub,
  listBuilderSkills,
  removeBuilderSkill,
  type SkillCandidate,
} from '../lib/builder-skills'

export default class BuilderSkills extends Command {
  static description = 'List, add, or remove skills the builder uses when creating agents'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> add --github owner/repo',
    '<%= config.bin %> <%= command.id %> add --github owner/repo --ref main --subpath skills/tool-style',
    '<%= config.bin %> <%= command.id %> add --folder ./my-skill',
    '<%= config.bin %> <%= command.id %> add --name cast-tool-style --description "How this team writes a Python tool" --body "When scaffolding a custom tool, ..."',
    '<%= config.bin %> <%= command.id %> remove cast-tool-style',
  ]

  static args = {
    action: Args.string({
      description: 'add or remove. Omit to list builder skills.',
      options: ['add', 'remove'],
    }),
    skillName: Args.string({
      description: 'Skill name to remove',
    }),
  }

  static flags = {
    json: Flags.boolean({description: 'Print JSON', default: false}),
    github: Flags.string({description: 'GitHub repository (owner/repo, owner/repo@ref, or a github.com URL)'}),
    ref: Flags.string({description: 'Git ref to clone. Overrides a ref in the GitHub URL.'}),
    subpath: Flags.string({description: 'Directory inside the repository that contains SKILL.md. "." is the repository root.'}),
    skill: Flags.string({description: 'Frontmatter name to install when a repository contains more than one skill'}),
    folder: Flags.string({description: 'Folder that contains SKILL.md. Copied, not symlinked.'}),
    name: Flags.string({description: 'Skill name for a skill entered directly'}),
    description: Flags.string({description: 'One-line description for a skill entered directly'}),
    body: Flags.string({description: 'Markdown body for a skill entered directly. "-" reads stdin.'}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(BuilderSkills)
    try {
      if (!args.action) {
        this.list(flags.json)
        return
      }
      if (args.action === 'remove') {
        this.remove(args.skillName, flags.json)
        return
      }
      await this.add(flags)
    } catch (error: any) {
      this.error(error?.message ?? String(error))
    }
  }

  private list(asJson: boolean): void {
    const {skills, warnings} = listBuilderSkills()
    for (const warning of warnings) this.warn(warning)
    if (asJson) {
      this.log(JSON.stringify(skills))
      return
    }
    if (skills.length === 0) {
      this.log('No builder skills.')
      return
    }
    for (const skill of skills) {
      this.log(`${skill.name}  ${skill.description}`)
    }
  }

  private remove(name: string | undefined, asJson: boolean): void {
    if (!name) throw new BuilderSkillError('Specify a skill name to remove.')
    removeBuilderSkill(name)
    if (asJson) {
      this.log(JSON.stringify({removed: name}))
      return
    }
    this.log(`Removed builder skill '${name}'.`)
  }

  private async add(flags: {
    json: boolean
    github?: string
    ref?: string
    subpath?: string
    skill?: string
    folder?: string
    name?: string
    description?: string
    body?: string
  }): Promise<void> {
    const sources = [flags.github, flags.folder, flags.name].filter((value) => value !== undefined && value !== '')
    if (sources.length === 0) {
      throw new BuilderSkillError('Specify one source: --github, --folder, or --name/--description/--body.')
    }
    if (sources.length > 1) {
      throw new BuilderSkillError('Specify only one source: --github, --folder, or --name/--description/--body.')
    }

    if (flags.github) {
      const result = installFromGithub({
        repo: flags.github,
        ref: flags.ref,
        subpath: flags.subpath,
        skill: flags.skill,
      })
      if (result.kind === 'multiple') {
        this.reportMultiple(result.candidates, flags.json)
        return
      }
      this.reportInstalled(result.skill, flags.json)
      return
    }

    if (flags.folder) {
      const skill = installFromFolder(flags.folder)
      this.reportInstalled(skill, flags.json)
      return
    }

    if (!flags.name || flags.description === undefined || flags.body === undefined) {
      throw new BuilderSkillError('Adding a skill directly requires --name, --description, and --body.')
    }
    const body = flags.body === '-' ? fs.readFileSync(0, 'utf8') : flags.body
    const skill = installFromFields({name: flags.name, description: flags.description, body})
    this.reportInstalled(skill, flags.json)
  }

  private reportInstalled(skill: {name: string; description: string; path: string}, asJson: boolean): void {
    if (asJson) {
      this.log(JSON.stringify(skill))
      return
    }
    this.log(`Added builder skill '${skill.name}'.`)
    this.log('It will apply on the next `cast new` or `cast edit`.')
  }

  private reportMultiple(candidates: SkillCandidate[], asJson: boolean): void {
    const payload = {error: 'multiple', candidates}
    if (asJson) this.log(JSON.stringify(payload))
    else {
      this.log('Multiple skills found. Re-run with --subpath <path> or --skill <name>:')
      for (const candidate of candidates) {
        const where = candidate.subpath || '.'
        this.log(`  ${candidate.name} — ${candidate.description} (${where})`)
      }
    }
    throw new BuilderSkillError('Multiple skills found.')
  }
}
