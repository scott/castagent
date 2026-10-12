import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  installFromFields,
  installFromFolder,
  installFromGithub,
  listBuilderSkills,
  parseGithubSkillSource,
  removeBuilderSkill,
  type GithubSkillSource,
} from '../../../typescript/cast-cli/src/lib/builder-skills'

const originalHome = process.env.HOME

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`
}

function writeSkill(dir: string, name: string, description: string, body: string): void {
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMarkdown(name, description, body))
}

async function loadCommand(): Promise<any> {
  return require('../../../typescript/cast-cli/src/commands/builder-skills').default
}

async function runCommand(Cmd: any, args: any, flags: any): Promise<{logs: string[]; errors: string[]}> {
  const logs: string[] = []
  const errors: string[] = []
  const instance = new Cmd([], {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({args, flags, argv: [], raw: [], metadata: {}, nonExistentFlags: []})
  instance.log = (msg?: string) => logs.push(msg ?? '')
  instance.warn = (msg?: string) => logs.push(`warn:${msg ?? ''}`)
  instance.error = (msg: string) => {
    errors.push(msg)
    throw new Error(msg)
  }
  try {
    await instance.run()
  } catch (error: any) {
    if (errors.length === 0) errors.push(error.message ?? String(error))
  }
  return {logs, errors}
}

describe('builder skills CLI', () => {
  let home: string
  let skillsRoot: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-builder-skills-'))
    process.env.HOME = home
    skillsRoot = path.join(home, '.cast', 'builder', 'skills')
  })

  afterEach(() => {
    process.env.HOME = originalHome
    fs.rmSync(home, {recursive: true, force: true})
  })

  describe('GitHub URL parsing', () => {
    const cases: Array<{input: string; expected: GithubSkillSource | null}> = [
      {input: 'https://github.com/owner/repo', expected: {owner: 'owner', repo: 'repo'}},
      {input: 'https://github.com/owner/repo.git', expected: {owner: 'owner', repo: 'repo'}},
      {
        input: 'https://github.com/owner/repo/tree/main/skills/tool',
        expected: {owner: 'owner', repo: 'repo', ref: 'main', subpath: 'skills/tool'},
      },
      {
        input: 'https://github.com/owner/repo/tree/dev',
        expected: {owner: 'owner', repo: 'repo', ref: 'dev'},
      },
      {input: 'owner/repo', expected: {owner: 'owner', repo: 'repo'}},
      {input: 'owner/repo/skills/tool', expected: {owner: 'owner', repo: 'repo', subpath: 'skills/tool'}},
      {input: 'owner/repo@dev', expected: {owner: 'owner', repo: 'repo', ref: 'dev'}},
      {input: 'owner/repo@dev/skills/tool', expected: {owner: 'owner', repo: 'repo', ref: 'dev', subpath: 'skills/tool'}},
      {input: 'https://gitlab.com/owner/repo', expected: null},
      {input: 'not a repo', expected: null},
      {input: '', expected: null},
      {input: './local/skill', expected: null},
    ]

    for (const testCase of cases) {
      it(`parses ${testCase.input || '(empty)'}`, () => {
        expect(parseGithubSkillSource(testCase.input)).to.deep.equal(testCase.expected)
      })
    }
  })

  it('adds a skill from a folder and copies scripts but not .git', () => {
    const source = path.join(home, 'src-skill')
    writeSkill(source, 'cast-tool-style', 'How this team writes a Python tool', 'Keep tools small.')
    fs.mkdirSync(path.join(source, 'scripts'))
    fs.writeFileSync(path.join(source, 'scripts', 'run.sh'), 'echo hi\n')
    fs.mkdirSync(path.join(source, '.git'))
    fs.writeFileSync(path.join(source, '.git', 'config'), 'do not copy\n')

    const installed = installFromFolder(source, home)

    expect(installed.name).to.equal('cast-tool-style')
    expect(fs.readFileSync(path.join(installed.path, 'SKILL.md'), 'utf8')).to.include('Keep tools small.')
    expect(fs.readFileSync(path.join(installed.path, 'scripts', 'run.sh'), 'utf8')).to.equal('echo hi\n')
    expect(fs.existsSync(path.join(installed.path, '.git'))).to.equal(false)
    expect(fs.lstatSync(installed.path).isSymbolicLink()).to.equal(false)
  })

  it('adds a skill from name, description, and body', () => {
    const installed = installFromFields({
      name: 'modal-skill',
      description: 'Entered in the modal',
      body: 'Follow this procedure.\n',
    }, home)

    const text = fs.readFileSync(path.join(installed.path, 'SKILL.md'), 'utf8')
    expect(text).to.include('name: modal-skill')
    expect(text).to.include('description: Entered in the modal')
    expect(text).to.include('Follow this procedure.')
    const listed = listBuilderSkills(home)
    expect(listed.skills.map((skill) => skill.name)).to.deep.equal(['modal-skill'])
  })

  it('rejects a folder with no SKILL.md and writes nothing', () => {
    const source = path.join(home, 'empty-folder')
    fs.mkdirSync(source)
    fs.writeFileSync(path.join(source, 'README.md'), 'no skill\n')

    expect(() => installFromFolder(source, home)).to.throw(/No SKILL.md/)
    expect(fs.existsSync(skillsRoot)).to.equal(false)
  })

  it('rejects a bad skill name with no directory', () => {
    const source = path.join(home, 'bad-name')
    writeSkill(source, 'Bad_Name', 'Not valid', 'nope')

    expect(() => installFromFolder(source, home)).to.throw(/Invalid skill/)
    expect(fs.existsSync(skillsRoot)).to.equal(false)
  })

  it('rejects a source path already inside the builder skills directory', () => {
    const installed = installFromFields({
      name: 'already',
      description: 'Installed',
      body: 'Original body.\n',
    }, home)

    expect(() => installFromFolder(installed.path, home)).to.throw(/already inside/)
    expect(fs.readFileSync(path.join(installed.path, 'SKILL.md'), 'utf8')).to.include('Original body.')
    expect(fs.readdirSync(skillsRoot).filter((name) => !name.startsWith('.'))).to.deep.equal(['already'])
  })

  it('rejects a duplicate name and leaves the original directory untouched', () => {
    installFromFields({name: 'alpha', description: 'First', body: 'Original body.\n'}, home)
    const source = path.join(home, 'other')
    writeSkill(source, 'alpha', 'Second', 'Replacement body.')

    expect(() => installFromFolder(source, home)).to.throw(/already installed/)
    expect(fs.readFileSync(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8')).to.include('Original body.')
    expect(fs.readdirSync(skillsRoot).filter((name) => !name.startsWith('.'))).to.deep.equal(['alpha'])
  })

  it('lists skills alphabetically and removes one directory', () => {
    installFromFields({name: 'zeta', description: 'Last', body: 'z'}, home)
    installFromFields({name: 'alpha', description: 'First', body: 'a'}, home)

    const listed = listBuilderSkills(home)
    expect(listed.skills.map((skill) => skill.name)).to.deep.equal(['alpha', 'zeta'])

    removeBuilderSkill('zeta', home)
    expect(fs.existsSync(path.join(skillsRoot, 'alpha', 'SKILL.md'))).to.equal(true)
    expect(fs.existsSync(path.join(skillsRoot, 'zeta'))).to.equal(false)
    expect(() => removeBuilderSkill('zeta', home)).to.throw(/not installed/)
    expect(fs.existsSync(path.join(skillsRoot, 'alpha', 'SKILL.md'))).to.equal(true)
  })

  it('installs one skill from a multi-skill tree without using the network', () => {
    const repo = path.join(home, 'repo')
    writeSkill(path.join(repo, 'skills', 'b'), 'zeta', 'Zeta skill', 'zeta body')
    writeSkill(path.join(repo, 'skills', 'a'), 'alpha', 'Alpha skill', 'alpha body')
    let cloned: GithubSkillSource | undefined

    const multiple = installFromGithub({
      repo: 'https://github.com/acme/skills',
      home,
      clone: (source, dest) => {
        cloned = source
        fs.cpSync(repo, dest, {recursive: true})
      },
    })

    expect(cloned).to.deep.equal({owner: 'acme', repo: 'skills'})
    expect(multiple.kind).to.equal('multiple')
    if (multiple.kind === 'multiple') {
      expect(multiple.candidates.map((candidate) => candidate.name)).to.deep.equal(['alpha', 'zeta'])
      expect(multiple.candidates[0].description).to.equal('Alpha skill')
      expect(multiple.candidates[0].subpath).to.equal('skills/a')
    }
    expect(fs.existsSync(skillsRoot)).to.equal(false)

    const installed = installFromGithub({
      repo: 'owner/skills@dev',
      ref: 'feature',
      subpath: 'skills/a',
      home,
      clone: (source, dest) => {
        expect(source).to.deep.equal({owner: 'owner', repo: 'skills', ref: 'feature', subpath: 'skills/a'})
        fs.cpSync(repo, dest, {recursive: true})
      },
    })
    expect(installed.kind).to.equal('installed')
    if (installed.kind === 'installed') expect(installed.skill.name).to.equal('alpha')
    expect(fs.readdirSync(skillsRoot)).to.deep.equal(['alpha'])
  })

  it('errors when a repository has no SKILL.md', () => {
    const repo = path.join(home, 'repo')
    fs.mkdirSync(repo)
    expect(() => installFromGithub({
      repo: 'owner/empty',
      home,
      clone: (_source, dest) => fs.cpSync(repo, dest, {recursive: true}),
    })).to.throw(/No SKILL.md/)
    expect(fs.existsSync(skillsRoot)).to.equal(false)
  })

  describe('command', () => {
    it('prints No builder skills. when the folder is empty', async () => {
      const Cmd = await loadCommand()
      const {logs, errors} = await runCommand(Cmd, {}, {json: false})
      expect(errors).to.deep.equal([])
      expect(logs).to.deep.equal(['No builder skills.'])
    })

    it('lists and returns JSON', async () => {
      installFromFields({name: 'zeta', description: 'Last', body: 'z'}, home)
      installFromFields({name: 'alpha', description: 'First', body: 'a'}, home)
      const Cmd = await loadCommand()
      const text = await runCommand(Cmd, {}, {json: false})
      expect(text.errors).to.deep.equal([])
      expect(text.logs).to.deep.equal(['alpha  First', 'zeta  Last'])

      const json = await runCommand(Cmd, {}, {json: true})
      const parsed = JSON.parse(json.logs.join(''))
      expect(parsed.map((skill: {name: string}) => skill.name)).to.deep.equal(['alpha', 'zeta'])
      expect(parsed[0].path).to.equal(path.join(skillsRoot, 'alpha'))
    })

    it('adds from a folder and from fields, then removes', async () => {
      const source = path.join(home, 'folder-skill')
      writeSkill(source, 'from-folder', 'Folder skill', 'folder body')
      const Cmd = await loadCommand()
      const added = await runCommand(Cmd, {action: 'add'}, {json: true, folder: source})
      expect(added.errors).to.deep.equal([])
      expect(JSON.parse(added.logs[0]).name).to.equal('from-folder')

      const modal = await runCommand(Cmd, {action: 'add'}, {
        json: false,
        name: 'from-modal',
        description: 'Modal skill',
        body: 'modal body',
      })
      expect(modal.errors).to.deep.equal([])
      expect(modal.logs[0]).to.include("Added builder skill 'from-modal'.")
      expect(fs.existsSync(path.join(skillsRoot, 'from-modal', 'SKILL.md'))).to.equal(true)

      const removed = await runCommand(Cmd, {action: 'remove', skillName: 'from-folder'}, {json: false})
      expect(removed.errors).to.deep.equal([])
      expect(fs.existsSync(path.join(skillsRoot, 'from-folder'))).to.equal(false)
      expect(fs.existsSync(path.join(skillsRoot, 'from-modal'))).to.equal(true)

      const missing = await runCommand(Cmd, {action: 'remove', skillName: 'from-folder'}, {json: false})
      expect(missing.errors.join('\n')).to.include('not installed')
    })

    it('rejects a folder with no SKILL.md from the command', async () => {
      const source = path.join(home, 'no-skill')
      fs.mkdirSync(source)
      const Cmd = await loadCommand()
      const {errors} = await runCommand(Cmd, {action: 'add'}, {json: false, folder: source})
      expect(errors.join('\n')).to.include('No SKILL.md')
      expect(fs.existsSync(skillsRoot)).to.equal(false)
    })
  })
})
