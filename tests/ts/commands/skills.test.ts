import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'

async function loadSkillsCommand(): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '..',
    '..',
    '..',
    'typescript',
    'cast-cli',
    'src',
    'commands',
    'skills.ts',
  )
  return require(commandPath).default
}

async function runCommand(Cmd: any, args: any, flags: any): Promise<{logs: string[]; errors: string[]}> {
  const logs: string[] = []
  const errors: string[] = []
  const instance = new Cmd([], {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({args, flags, argv: [], raw: [], metadata: {}, nonExistentFlags: []})
  instance.log = (msg?: string) => logs.push(msg ?? '')
  instance.error = (msg: string) => {
    errors.push(msg)
    throw new Error(msg)
  }
  instance.exit = (code?: number) => {
    throw new Error(`exit ${code ?? 0}`)
  }
  try {
    await instance.run()
  } catch (err: any) {
    if (errors.length === 0) errors.push(err.message ?? String(err))
  }
  return {logs, errors}
}

function writeSkill(dir: string, name: string, description: string, body: string, extra?: Record<string, string>): void {
  fs.mkdirSync(dir, {recursive: true})
  const frontmatter = yaml.stringify({name, description}).trimEnd()
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n\n${body}\n`)
  for (const [rel, contents] of Object.entries(extra ?? {})) {
    const file = path.join(dir, rel)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, contents)
  }
}

describe('cast skills command', () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skills-cmd-'))
  const previous = process.env.CAST_AGENTS_DIR
  let Skills: any
  let n = 0

  before(async () => {
    process.env.CAST_AGENTS_DIR = agentsDir
    Skills = await loadSkillsCommand()
  })

  after(() => {
    if (previous === undefined) delete process.env.CAST_AGENTS_DIR
    else process.env.CAST_AGENTS_DIR = previous
    fs.rmSync(agentsDir, {recursive: true, force: true})
  })

  function makeAgent(): {name: string; dir: string} {
    n += 1
    const name = `email-agent-${n}`
    const dir = path.join(agentsDir, name)
    fs.mkdirSync(dir, {recursive: true})
    fs.writeFileSync(path.join(dir, 'agent.yaml'), yaml.stringify({
      name,
      version: '1.0',
      description: 'Mail',
    }))
    fs.writeFileSync(path.join(dir, 'instructions.md'), 'You sort mail.\n')
    return {name, dir}
  }

  function readConfig(dir: string): any {
    return yaml.parse(fs.readFileSync(path.join(dir, 'agent.yaml'), 'utf8'))
  }

  it('prints an empty list and JSON', async () => {
    const agent = makeAgent()
    const listed = await runCommand(Skills, {target: agent.name}, {json: false})
    expect(listed.errors).to.deep.equal([])
    expect(listed.logs.join('\n')).to.equal(`No skills on '${agent.name}'.`)

    const json = await runCommand(Skills, {target: agent.name}, {json: true})
    expect(json.errors).to.deep.equal([])
    expect(JSON.parse(json.logs.join('\n'))).to.deep.equal([])
  })

  it('adds a skill from a folder and lists it', async () => {
    const agent = makeAgent()
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-folder-'))
    writeSkill(folder, 'triage', 'Sort incoming mail into buckets', '# Triage\n', {
      'scripts/run.sh': 'echo hi\n',
    })
    const added = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {folder, json: false},
    )
    expect(added.errors).to.deep.equal([])
    expect(added.logs.join('\n')).to.equal(
      `Added skill 'triage' to '${agent.name}' (folder: ${fs.realpathSync(folder)}).`,
    )
    expect(fs.readFileSync(path.join(agent.dir, 'skills', 'triage', 'scripts', 'run.sh'), 'utf8')).to.equal('echo hi\n')
    const config = readConfig(agent.dir)
    expect(config.skills).to.deep.equal([{
      name: 'triage',
      description: 'Sort incoming mail into buckets',
      path: 'skills/triage',
      source: {type: 'folder', from: fs.realpathSync(folder)},
    }])

    const listed = await runCommand(Skills, {target: agent.name}, {json: false})
    expect(listed.logs.join('\n')).to.equal('triage  Sort incoming mail into buckets  folder')
    const json = await runCommand(Skills, {target: agent.name}, {json: true})
    const parsed = JSON.parse(json.logs.join('\n'))
    expect(parsed[0].description).to.equal('Sort incoming mail into buckets')
    expect(parsed[0].source.type).to.equal('folder')
    fs.rmSync(folder, {recursive: true, force: true})
  })

  it('adds a folded description and stores one line', async () => {
    const agent = makeAgent()
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-fold-'))
    fs.writeFileSync(path.join(folder, 'SKILL.md'), [
      '---',
      'name: triage',
      'description: >',
      '  Sort incoming mail into buckets',
      '---',
      '',
      '# Triage',
      '',
    ].join('\n'))
    const added = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder, json: false})
    expect(added.errors).to.deep.equal([])
    expect(readConfig(agent.dir).skills[0].description).to.equal('Sort incoming mail into buckets')
    expect(fs.readFileSync(path.join(agent.dir, 'skills', 'triage', 'SKILL.md'), 'utf8')).to.include('description: >')
    fs.rmSync(folder, {recursive: true, force: true})
  })

  it('adds a literal description as one line', async () => {
    const agent = makeAgent()
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-lit-'))
    fs.writeFileSync(path.join(folder, 'SKILL.md'), [
      '---',
      'name: triage',
      'description: |',
      '  Sort incoming mail into buckets.',
      '  Use when the user asks to triage an inbox.',
      '---',
      '',
      '# Triage',
      '',
    ].join('\n'))
    const added = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder, json: false})
    expect(added.errors).to.deep.equal([])
    expect(readConfig(agent.dir).skills[0].description).to.equal(
      'Sort incoming mail into buckets. Use when the user asks to triage an inbox.',
    )
    fs.rmSync(folder, {recursive: true, force: true})
  })

  it('rejects a missing or blank description', async () => {
    const agent = makeAgent()
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-blank-'))
    fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: triage\ndescription: ""\n---\n\n# Triage\n')
    const blank = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder, json: false})
    expect(blank.errors.join('\n')).to.include('Skill description is required')
    expect(readConfig(agent.dir).skills).to.equal(undefined)
    expect(fs.existsSync(path.join(agent.dir, 'skills'))).to.equal(false)

    const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-missing-'))
    fs.writeFileSync(path.join(missingDir, 'SKILL.md'), '---\nname: triage\n---\n\n# Triage\n')
    const missing = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder: missingDir, json: false})
    expect(missing.errors.join('\n')).to.include('Skill description is required')

    const inline = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {name: 'triage', description: '   ', body: '# Triage', json: false},
    )
    expect(inline.errors.join('\n')).to.include('Skill description is required.')
    expect(readConfig(agent.dir).skills).to.equal(undefined)
    fs.rmSync(folder, {recursive: true, force: true})
    fs.rmSync(missingDir, {recursive: true, force: true})
  })

  it('adds an inline skill from name, description, and body', async () => {
    const agent = makeAgent()
    const added = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {name: 'triage', description: 'Sort incoming mail into buckets', body: '# Triage\n\nSort it.', json: false},
    )
    expect(added.errors).to.deep.equal([])
    expect(added.logs.join('\n')).to.include('entered in the modal')
    const markdown = fs.readFileSync(path.join(agent.dir, 'skills', 'triage', 'SKILL.md'), 'utf8')
    expect(markdown).to.include('name: triage')
    expect(markdown).to.include('description: Sort incoming mail into buckets')
    expect(markdown).to.include('# Triage')
    expect(readConfig(agent.dir).skills[0].source).to.deep.equal({type: 'modal'})
  })

  it('rejects a folder with no SKILL.md and writes nothing', async () => {
    const agent = makeAgent()
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-empty-'))
    const before = fs.readdirSync(agent.dir).sort()
    const yamlBefore = fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')
    const result = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {folder, json: false},
    )
    expect(result.errors.join('\n')).to.include(`No SKILL.md in ${fs.realpathSync(folder)}`)
    expect(fs.readdirSync(agent.dir).sort()).to.deep.equal(before)
    expect(fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')).to.equal(yamlBefore)
    expect(fs.existsSync(path.join(agent.dir, 'skills'))).to.equal(false)
    fs.rmSync(folder, {recursive: true, force: true})
  })

  it('rejects a path inside the agent skills directory', async () => {
    const agent = makeAgent()
    const inside = path.join(agent.dir, 'skills', 'already')
    writeSkill(inside, 'already', 'Already there', 'Body')
    const yamlBefore = fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')
    const result = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {folder: inside, json: false},
    )
    expect(result.errors.join('\n')).to.include('skills/')
    expect(fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')).to.equal(yamlBefore)
    expect(fs.existsSync(path.join(agent.dir, 'skills', 'already', 'SKILL.md'))).to.equal(true)
    expect(fs.existsSync(path.join(agent.dir, 'skills', 'fresh'))).to.equal(false)
  })

  it('rejects a duplicate name and does not write a partial skill', async () => {
    const agent = makeAgent()
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-first-'))
    const second = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-second-'))
    writeSkill(first, 'triage', 'Sort incoming mail into buckets', 'First body')
    writeSkill(second, 'triage', 'Sort incoming mail into buckets', 'Second body', {'EXTRA.txt': 'nope\n'})
    const added = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder: first, json: false})
    expect(added.errors).to.deep.equal([])
    const yamlAfterFirst = fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')
    const result = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder: second, json: false})
    expect(result.errors.join('\n')).to.equal(
      `Skill 'triage' is already on '${agent.name}'. Remove it with /skills first.`,
    )
    expect(fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')).to.equal(yamlAfterFirst)
    expect(fs.existsSync(path.join(agent.dir, 'skills', 'triage', 'EXTRA.txt'))).to.equal(false)
    expect(fs.readFileSync(path.join(agent.dir, 'skills', 'triage', 'SKILL.md'), 'utf8')).to.include('First body')
    expect(fs.readdirSync(path.join(agent.dir, 'skills')).filter((name) => name.startsWith('.'))).to.deep.equal([])
    fs.rmSync(first, {recursive: true, force: true})
    fs.rmSync(second, {recursive: true, force: true})
  })

  it('rejects a bad skill name with no partial write', async () => {
    const agent = makeAgent()
    const before = fs.readdirSync(agent.dir).sort()
    const result = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {name: 'Not Valid', description: 'Nope', body: 'Body', json: false},
    )
    expect(result.errors.join('\n')).to.include('invalid')
    expect(fs.readdirSync(agent.dir).sort()).to.deep.equal(before)
    expect(readConfig(agent.dir).skills).to.equal(undefined)
  })

  it('removes one skill and writes skills: [] when the last one is gone', async () => {
    const agent = makeAgent()
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-rm-'))
    writeSkill(folder, 'triage', 'Sort incoming mail into buckets', 'Body')
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-rm2-'))
    writeSkill(other, 'label', 'Label the mail', 'Labels')
    await runCommand(Skills, {target: 'add', agent: agent.name}, {folder, json: false})
    await runCommand(Skills, {target: 'add', agent: agent.name}, {folder: other, json: false})

    const removed = await runCommand(Skills, {target: 'remove', agent: agent.name, skill: 'triage'}, {json: false})
    expect(removed.errors).to.deep.equal([])
    expect(removed.logs.join('\n')).to.equal(`Removed skill 'triage' from '${agent.name}'.`)
    expect(fs.existsSync(path.join(agent.dir, 'skills', 'triage'))).to.equal(false)
    expect(fs.existsSync(path.join(agent.dir, 'skills', 'label'))).to.equal(true)
    expect(readConfig(agent.dir).skills.map((skill: {name: string}) => skill.name)).to.deep.equal(['label'])

    const last = await runCommand(Skills, {target: 'remove', agent: agent.name, skill: 'label'}, {json: false})
    expect(last.errors).to.deep.equal([])
    expect(readConfig(agent.dir).skills).to.deep.equal([])
    expect(fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')).to.include('skills: []')
    fs.rmSync(folder, {recursive: true, force: true})
    fs.rmSync(other, {recursive: true, force: true})
  })

  it('fails when removing a skill that is not installed', async () => {
    const agent = makeAgent()
    const result = await runCommand(
      Skills,
      {target: 'remove', agent: agent.name, skill: 'missing'},
      {json: false},
    )
    expect(result.errors.join('\n')).to.include(`Skill 'missing' is not on '${agent.name}'`)
    expect(readConfig(agent.dir).skills).to.equal(undefined)
  })

  it('rejects a github value that is not a repo without cloning', async () => {
    const agent = makeAgent()
    const result = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {github: 'not a repo', json: false},
    )
    expect(result.errors.join('\n')).to.include('Give a GitHub repo')
    expect(fs.existsSync(path.join(agent.dir, 'skills'))).to.equal(false)
  })
})
