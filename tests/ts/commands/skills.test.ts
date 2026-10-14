import {expect} from 'chai'
import {spawnSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'
import * as skillLib from '../../../typescript/cast-cli/src/lib/skills'

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

async function runCommand(
  Cmd: any,
  args: any,
  flags: any,
): Promise<{logs: string[]; errors: string[]; exitCode?: number}> {
  const logs: string[] = []
  const errors: string[] = []
  let exitCode: number | undefined
  const instance = new Cmd([], {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({args, flags, argv: [], raw: [], metadata: {}, nonExistentFlags: []})
  instance.log = (msg?: string) => logs.push(msg ?? '')
  instance.error = (msg: string, options?: {exit?: number | false}) => {
    errors.push(msg)
    if (options && typeof options.exit === 'number') exitCode = options.exit
    throw new Error(msg)
  }
  instance.exit = (code?: number) => {
    exitCode = code ?? 0
    throw new Error(`exit ${code ?? 0}`)
  }
  try {
    await instance.run()
  } catch (err: any) {
    if (errors.length === 0) errors.push(err.message ?? String(err))
  }
  return {logs, errors, exitCode}
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

    const empty = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {name: 'bb-nodesc', description: '', body: 'y', json: false},
    )
    expect(empty.errors.join('\n')).to.equal('Skill description is required.')
    expect(readConfig(agent.dir).skills).to.equal(undefined)
    expect(fs.existsSync(path.join(agent.dir, 'skills'))).to.equal(false)

    const omitted = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {name: 'bb-nodesc', body: 'y', json: false},
    )
    expect(omitted.errors.join('\n')).to.include('Usage: cast skills add <agent> --name <name> --description <text> --body <markdown>')
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
    expect(added.logs.join('\n')).to.equal(
      `Added skill 'triage' to '${agent.name}' (entered directly).`,
    )
    const markdown = fs.readFileSync(path.join(agent.dir, 'skills', 'triage', 'SKILL.md'), 'utf8')
    expect(markdown).to.include('name: triage')
    expect(markdown).to.include('description: Sort incoming mail into buckets')
    expect(markdown).to.include('# Triage')
    expect(readConfig(agent.dir).skills[0].source).to.deep.equal({type: 'modal'})
  })

  it('reads a multiline body from stdin when --body is -', () => {
    const agent = makeAgent()
    const body = '# From stdin\n\nSecond line.\n'
    const result = spawnSync(process.execPath, [
      '-r', 'ts-node/register',
      path.join(__dirname, 'skill-stdin-worker.ts'),
      'skills',
      'add',
      agent.name,
      '--name',
      'bb-stdin',
      '--description',
      's',
      '--body',
      '-',
    ], {
      cwd: path.resolve(__dirname, '../../..'),
      env: {
        ...process.env,
        CAST_AGENTS_DIR: agentsDir,
        TS_NODE_TRANSPILE_ONLY: '1',
      },
      encoding: 'utf8',
      input: body,
    })
    expect(result.stderr, result.stderr).to.equal('')
    expect(result.status, result.stderr || result.stdout).to.equal(0)
    expect(result.stdout.trim()).to.equal(
      `Added skill 'bb-stdin' to '${agent.name}' (entered directly).`,
    )
    const markdown = fs.readFileSync(path.join(agent.dir, 'skills', 'bb-stdin', 'SKILL.md'), 'utf8')
    expect(markdown).to.include('# From stdin')
    expect(markdown).to.include('Second line.')
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

  it('prints a readable list when a github repo has several skills', async () => {
    const agent = makeAgent()
    const choices = [
      {name: 'alpha', description: 'Alpha skill', subpath: 'skills/alpha'},
      {name: 'zeta', description: 'Zeta skill', subpath: 'skills/zeta'},
    ]
    const original = skillLib.installFromGitHub
    const mutable = skillLib as {installFromGitHub: typeof skillLib.installFromGitHub}
    mutable.installFromGitHub = () => {
      throw new skillLib.SkillError(
        'Multiple SKILL.md files found in owner/multi. Re-run with --subpath or --skill.',
        'multiple',
        choices,
      )
    }
    try {
      const result = await runCommand(
        Skills,
        {target: 'add', agent: agent.name},
        {github: 'owner/multi', json: false},
      )
      expect(result.logs).to.deep.equal([
        'Multiple skills found. Re-run with --subpath <path> or --skill <name>:',
        '  alpha  Alpha skill (skills/alpha)',
        '  zeta  Zeta skill (skills/zeta)',
      ])
      expect(result.logs.join('\n')).to.not.include('"subpath"')
      expect(result.errors).to.deep.equal(['Multiple skills found. Pass --subpath'])
      expect(result.exitCode).to.equal(2)
      expect(readConfig(agent.dir).skills).to.equal(undefined)
    } finally {
      mutable.installFromGitHub = original
    }
  })

  it('prints the choice array as JSON when --json is set', async () => {
    const agent = makeAgent()
    const choices = [
      {name: 'alpha', description: 'Alpha skill', subpath: 'skills/alpha', ref: 'main'},
      {name: 'zeta', description: 'Zeta skill', subpath: 'skills/zeta', ref: 'main'},
    ]
    const original = skillLib.installFromGitHub
    const mutable = skillLib as {installFromGitHub: typeof skillLib.installFromGitHub}
    mutable.installFromGitHub = () => {
      throw new skillLib.SkillError('multiple', 'multiple', choices)
    }
    try {
      const result = await runCommand(
        Skills,
        {target: 'add', agent: agent.name},
        {github: 'owner/multi', json: true},
      )
      expect(JSON.parse(result.logs.join('\n'))).to.deep.equal(choices)
      expect(result.errors).to.deep.equal(['Multiple skills found. Pass --subpath'])
      expect(result.exitCode).to.equal(2)
      expect(fs.existsSync(path.join(agent.dir, 'skills'))).to.equal(false)
    } finally {
      mutable.installFromGitHub = original
    }
  })

  it('passes --skill through to the github installer', async () => {
    const agent = makeAgent()
    const original = skillLib.installFromGitHub
    const mutable = skillLib as {installFromGitHub: typeof skillLib.installFromGitHub}
    let seen: {skill?: string; agentName?: string; repo?: string} | undefined
    mutable.installFromGitHub = (options) => {
      seen = options
      return {
        name: 'alpha',
        description: 'Alpha skill',
        path: 'skills/alpha',
        source: {type: 'github', repo: options.repo, subpath: 'skills/alpha'},
      }
    }
    try {
      const result = await runCommand(
        Skills,
        {target: 'add', agent: agent.name},
        {github: 'owner/multi', skill: 'alpha', json: false},
      )
      expect(result.errors).to.deep.equal([])
      expect(seen?.skill).to.equal('alpha')
      expect(seen?.agentName).to.equal(agent.name)
      expect(seen?.repo).to.equal('owner/multi')
      expect(result.logs.join('\n')).to.equal(
        `Added skill 'alpha' to '${agent.name}' (github: owner/multi).`,
      )
    } finally {
      mutable.installFromGitHub = original
    }
  })

  it('rejects --skill unless the source is github', async () => {
    const agent = makeAgent()
    const result = await runCommand(
      Skills,
      {target: 'add', agent: agent.name},
      {folder: '/tmp/not-used', skill: 'alpha', json: false},
    )
    expect(result.errors).to.deep.equal(['Pass --skill with --github.'])
    expect(fs.existsSync(path.join(agent.dir, 'skills'))).to.equal(false)
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

  const wrapped = 'Sort incoming mail into buckets. Use this when new mail arrives.'
  const longLeft = 'A'.repeat(512)
  const longRight = 'B'.repeat(511)
  const longDescription = `${longLeft} ${longRight}`
  const folderCases: Array<{title: string; name: string; filename?: string; markdown: string; description: string}> = [
    {
      title: 'a frontmatter-only file',
      name: 'skill-name',
      markdown: '---\nname: skill-name\ndescription: A description of what this skill does and when to use it.\n---\n',
      description: 'A description of what this skill does and when to use it.',
    },
    {
      title: 'a folded description',
      name: 'folded-skill',
      markdown: '---\nname: folded-skill\ndescription: >\n  Sort incoming mail into buckets.\n  Use this when new mail arrives.\n---\n',
      description: wrapped,
    },
    {
      title: 'a literal description of two sentences',
      name: 'literal-skill',
      markdown: '---\nname: literal-skill\ndescription: |\n  Sort incoming mail into buckets.\n  Use this when new mail arrives.\n---\n',
      description: wrapped,
    },
    {
      title: 'skill.md',
      name: 'lower-skill',
      filename: 'skill.md',
      markdown: '---\nname: lower-skill\ndescription: Lowercase skill file\n---\n',
      description: 'Lowercase skill file',
    },
    {
      title: 'license and metadata',
      name: 'pdf-processing',
      markdown: [
        '---',
        'name: pdf-processing',
        'description: Extract PDF text, fill forms, merge files. Use when handling PDFs.',
        'license: Apache-2.0',
        'metadata:',
        '  author: example-org',
        '  version: "1.0"',
        '---',
        '',
      ].join('\n'),
      description: 'Extract PDF text, fill forms, merge files. Use when handling PDFs.',
    },
    {
      title: 'a one-line skill with a body',
      name: 'triage',
      markdown: '---\nname: triage\ndescription: Sort incoming mail into buckets\n---\n\n# Triage\n\nSort the mail.\n',
      description: 'Sort incoming mail into buckets',
    },
    {
      title: 'a 1024-character description',
      name: 'long-desc',
      markdown: `---\nname: long-desc\ndescription: |\n  ${longLeft}\n  ${longRight}\n---\n`,
      description: longDescription,
    },
  ]

  for (const testCase of folderCases) {
    it(`adds ${testCase.title} from a folder`, async () => {
      const agent = makeAgent()
      const filename = testCase.filename ?? 'SKILL.md'
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-agentskills-'))
      fs.writeFileSync(path.join(folder, filename), testCase.markdown)
      fs.mkdirSync(path.join(folder, 'scripts'))
      fs.writeFileSync(path.join(folder, 'scripts', 'run.sh'), 'echo hi\n')
      const added = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder, json: false})
      expect(added.errors).to.deep.equal([])
      const installed = path.join(agent.dir, 'skills', testCase.name)
      expect(fs.readdirSync(installed).filter((name) => name.toLowerCase() === 'skill.md')).to.deep.equal([filename])
      expect(fs.readFileSync(path.join(installed, filename), 'utf8')).to.equal(testCase.markdown)
      expect(fs.readFileSync(path.join(installed, 'scripts', 'run.sh'), 'utf8')).to.equal('echo hi\n')
      expect(readConfig(agent.dir).skills[0].description).to.equal(testCase.description)
      expect(readConfig(agent.dir).skills[0].description).to.not.include('\n')
      fs.rmSync(folder, {recursive: true, force: true})
    })
  }

  it('rejects a blank or missing description from a folder', async () => {
    for (const markdown of [
      '---\nname: blank-desc\ndescription: "   "\n---\n',
      '---\nname: blank-desc\n---\n# Body\n',
    ]) {
      const agent = makeAgent()
      const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-blank-'))
      fs.writeFileSync(path.join(folder, 'SKILL.md'), markdown)
      const before = fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')
      const result = await runCommand(Skills, {target: 'add', agent: agent.name}, {folder, json: false})
      expect(result.errors.join('\n')).to.include('description')
      expect(fs.readFileSync(path.join(agent.dir, 'agent.yaml'), 'utf8')).to.equal(before)
      expect(fs.existsSync(path.join(agent.dir, 'skills'))).to.equal(false)
      fs.rmSync(folder, {recursive: true, force: true})
    }
  })
})
