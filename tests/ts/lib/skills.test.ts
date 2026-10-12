import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'
import {
  GITHUB_SOURCE_HINT,
  SkillError,
  assertSkillIdentity,
  duplicateSkillMessage,
  installFromGitHub,
  parseGitHubSource,
  parseSkillMarkdown,
  readSkillBody,
  renderSkillMarkdown,
  resolveFolderInput,
} from '../../../typescript/cast-cli/src/lib/skills'

const FOLDED_DESCRIPTION = [
  '---',
  'name: triage-fold',
  'description: >',
  '  Sort incoming mail into buckets',
  '---',
  '',
  '# Triage',
  '',
].join('\n')

const LITERAL_DESCRIPTION = [
  '---',
  'name: triage-lit',
  'description: |',
  '  Sort incoming mail into buckets.',
  '  Use when the user asks to triage an inbox.',
  '---',
  '',
  '# Triage',
  '',
].join('\n')

const WRAPPED = 'Sort incoming mail into buckets. Use this when new mail arrives.'
const LONG_LEFT = 'A'.repeat(512)
const LONG_RIGHT = 'B'.repeat(511)
const LONG_DESCRIPTION = `${LONG_LEFT} ${LONG_RIGHT}`

function foldedMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: >\n  Sort incoming mail into buckets.\n  Use this when new mail arrives.\n---\n`
}

function literalMarkdown(name: string): string {
  return `---\nname: ${name}\ndescription: |\n  Sort incoming mail into buckets.\n  Use this when new mail arrives.\n---\n`
}

function minimalMarkdown(name = 'skill-name'): string {
  return `---\nname: ${name}\ndescription: A description of what this skill does and when to use it.\n---\n`
}

function metadataMarkdown(): string {
  return [
    '---',
    'name: pdf-processing',
    'description: Extract PDF text, fill forms, merge files. Use when handling PDFs.',
    'license: Apache-2.0',
    'metadata:',
    '  author: example-org',
    '  version: "1.0"',
    '---',
    '',
  ].join('\n')
}

function longMarkdown(): string {
  return `---\nname: long-desc\ndescription: |\n  ${LONG_LEFT}\n  ${LONG_RIGHT}\n---\n`
}

function oneLineMarkdown(): string {
  return '---\nname: triage\ndescription: Sort incoming mail into buckets\n---\n\n# Triage\n\nSort the mail.\n'
}

function skillMarkdown(name: string, description: string, body: string): string {
  return renderSkillMarkdown(name, description, body)
}

describe('skill github source parser', () => {
  it('parses owner/repo', () => {
    expect(parseGitHubSource('owner/repo')).to.deep.equal({repo: 'owner/repo'})
  })

  it('parses owner/repo@ref', () => {
    expect(parseGitHubSource('owner/repo@main')).to.deep.equal({repo: 'owner/repo', ref: 'main'})
  })

  it('parses owner/repo/<subpath> without treating tree as a ref', () => {
    expect(parseGitHubSource('owner/repo/skills/triage')).to.deep.equal({
      repo: 'owner/repo',
      subpath: 'skills/triage',
    })
    expect(parseGitHubSource('owner/repo/tree/main/skills')).to.deep.equal({
      repo: 'owner/repo',
      subpath: 'tree/main/skills',
    })
  })

  it('parses https://github.com/owner/repo', () => {
    expect(parseGitHubSource('https://github.com/owner/repo')).to.deep.equal({repo: 'owner/repo'})
    expect(parseGitHubSource('https://github.com/owner/repo.git')).to.deep.equal({repo: 'owner/repo'})
  })

  it('parses a tree URL into ref and subpath', () => {
    expect(parseGitHubSource('https://github.com/owner/repo/tree/main/skills/triage')).to.deep.equal({
      repo: 'owner/repo',
      ref: 'main',
      subpath: 'skills/triage',
    })
    expect(parseGitHubSource('https://github.com/owner/repo/tree/main')).to.deep.equal({
      repo: 'owner/repo',
      ref: 'main',
    })
  })

  it('rejects paths and non-github urls', () => {
    expect(parseGitHubSource('/tmp/skills/triage')).to.equal(null)
    expect(parseGitHubSource('~/skills/triage')).to.equal(null)
    expect(parseGitHubSource('https://gitlab.com/owner/repo')).to.equal(null)
    expect(parseGitHubSource('not a repo')).to.equal(null)
    expect(parseGitHubSource('')).to.equal(null)
  })
})

describe('skill folder paths and markdown', () => {
  it('expands ~ and rejects relative paths', () => {
    expect(resolveFolderInput('~/skills/triage')).to.equal(path.join(os.homedir(), 'skills/triage'))
    expect(resolveFolderInput('/tmp/skills/triage')).to.equal('/tmp/skills/triage')
    expect(() => resolveFolderInput('skills/triage')).to.throw(SkillError, /absolute path/)
    expect(() => resolveFolderInput('../skills')).to.throw(SkillError, /absolute path/)
  })

  it('round-trips SKILL.md frontmatter', () => {
    const markdown = skillMarkdown('triage', 'Sort incoming mail into buckets', '# Triage\n\nSort it.')
    expect(parseSkillMarkdown(markdown)).to.deep.equal({
      name: 'triage',
      description: 'Sort incoming mail into buckets',
      body: '# Triage\n\nSort it.',
    })
  })

  it('keeps a one-line description unchanged', () => {
    const markdown = [
      '---',
      'name: triage',
      'description: Sort incoming mail into buckets',
      '---',
      '',
      '# Triage',
      '',
    ].join('\n')
    expect(parseSkillMarkdown(markdown).description).to.equal('Sort incoming mail into buckets')
    expect(parseSkillMarkdown(renderSkillMarkdown('triage', 'Sort  incoming mail', '# Triage')).description).to.equal(
      'Sort  incoming mail',
    )
  })

  it('collapses a folded description to one line', () => {
    expect(parseSkillMarkdown(FOLDED_DESCRIPTION).description).to.equal('Sort incoming mail into buckets')
  })

  it('joins a literal description into one line', () => {
    expect(parseSkillMarkdown(LITERAL_DESCRIPTION).description).to.equal(
      'Sort incoming mail into buckets. Use when the user asks to triage an inbox.',
    )
  })

  it('rejects a missing or blank description', () => {
    const missing = '---\nname: triage\n---\n\n# Triage\n'
    const blank = '---\nname: triage\ndescription: ""\n---\n\n# Triage\n'
    const foldedBlank = '---\nname: triage\ndescription: >\n---\n\n# Triage\n'
    const spaces = '---\nname: triage\ndescription: "   "\n---\n\n# Triage\n'
    for (const markdown of [missing, blank, foldedBlank, spaces]) {
      expect(() => parseSkillMarkdown(markdown)).to.throw(SkillError, 'Skill description is required.')
    }
    expect(() => assertSkillIdentity('triage', '\n', '# Triage')).to.throw(SkillError, 'Skill description is required.')
    expect(() => assertSkillIdentity('triage', '   ', '# Triage')).to.throw(SkillError, 'Skill description is required.')
  })

  it('rejects a bad skill name', () => {
    expect(() => skillMarkdown('Triage', 'Sort mail', 'body')).to.throw(SkillError, /invalid/)
  })

  it('reads stdin when the body flag is -', () => {
    expect(readSkillBody('-', () => '# From stdin\n')).to.equal('# From stdin\n')
    expect(readSkillBody('# Inline\n', () => 'ignored')).to.equal('# Inline\n')
  })

  it('accepts a frontmatter-only skill and collapses wrapped descriptions', () => {
    expect(parseSkillMarkdown(minimalMarkdown())).to.deep.equal({
      name: 'skill-name',
      description: 'A description of what this skill does and when to use it.',
      body: '',
    })
    expect(parseSkillMarkdown(foldedMarkdown('folded-skill')).description).to.equal(WRAPPED)
    expect(parseSkillMarkdown(literalMarkdown('literal-skill')).description).to.equal(WRAPPED)
    const parsedLong = parseSkillMarkdown(longMarkdown())
    expect(parsedLong.description).to.equal(LONG_DESCRIPTION)
    expect(parsedLong.description).to.have.length(1024)
    const oneLine = parseSkillMarkdown(oneLineMarkdown())
    expect(oneLine.description).to.equal('Sort incoming mail into buckets')
    expect(oneLine.body).to.equal('# Triage\n\nSort the mail.')
    expect(() => parseSkillMarkdown('---\nname: triage\ndescription: "   "\n---\n')).to.throw(SkillError, /description/)
    expect(() => parseSkillMarkdown('---\nname: triage\n---\nBody\n')).to.throw(SkillError, /description/)
  })
})

describe('installFromGitHub', () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skills-gh-'))
  const agentName = 'email-agent'

  before(() => {
    const agent = path.join(agentsDir, agentName)
    fs.mkdirSync(agent, {recursive: true})
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: email-agent\ndescription: Mail\n')
  })

  after(() => {
    fs.rmSync(agentsDir, {recursive: true, force: true})
  })

  function fixture(layout: (root: string) => void): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-src-'))
    layout(root)
    return root
  }

  it('copies a root skill, skips .git, and records the github source', () => {
    const src = fixture((root) => {
      fs.mkdirSync(path.join(root, '.git'))
      fs.writeFileSync(path.join(root, '.git', 'config'), 'gitdir\n')
      fs.mkdirSync(path.join(root, 'scripts'))
      fs.writeFileSync(path.join(root, 'scripts', 'run.sh'), 'echo hi\n')
      fs.writeFileSync(path.join(root, 'SKILL.md'), skillMarkdown('triage', 'Sort incoming mail into buckets', '# Triage\n'))
    })
    let cloned: {url: string; ref?: string} | undefined
    const entry = installFromGitHub({
      agentName,
      repo: 'owner/repo',
      ref: 'main',
      sourceLabel: 'owner/repo@main',
      agentsDir,
      clone: (url, dest, ref) => {
        cloned = {url, ref}
        fs.cpSync(src, dest, {recursive: true})
      },
    })
    expect(cloned).to.deep.equal({url: 'https://github.com/owner/repo.git', ref: 'main'})
    expect(entry.source).to.deep.equal({type: 'github', repo: 'owner/repo', ref: 'main'})
    const installed = path.join(agentsDir, agentName, 'skills', 'triage')
    expect(fs.existsSync(path.join(installed, 'SKILL.md'))).to.equal(true)
    expect(fs.readFileSync(path.join(installed, 'scripts', 'run.sh'), 'utf8')).to.equal('echo hi\n')
    expect(fs.existsSync(path.join(installed, '.git'))).to.equal(false)
    fs.rmSync(src, {recursive: true, force: true})
  })

  it('installs the only nested SKILL.md and records its subpath', () => {
    const src = fixture((root) => {
      const dir = path.join(root, 'skills', 'triage')
      fs.mkdirSync(dir, {recursive: true})
      fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMarkdown('nested', 'Nested skill', 'Do the nested thing.'))
    })
    const entry = installFromGitHub({
      agentName,
      repo: 'owner/repo',
      sourceLabel: 'owner/repo',
      agentsDir,
      clone: (_url, dest) => fs.cpSync(src, dest, {recursive: true}),
    })
    expect(entry.name).to.equal('nested')
    expect(entry.source).to.deep.equal({type: 'github', repo: 'owner/repo', subpath: 'skills/triage'})
    fs.rmSync(src, {recursive: true, force: true})
  })

  it('lists multiple skills and does not write the agent', () => {
    const src = fixture((root) => {
      for (const name of ['zeta', 'alpha']) {
        const dir = path.join(root, 'skills', name)
        fs.mkdirSync(dir, {recursive: true})
        fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMarkdown(name, `${name} skill`, `Body ${name}`))
      }
    })
    const before = fs.readFileSync(path.join(agentsDir, agentName, 'agent.yaml'), 'utf8')
    try {
      installFromGitHub({
        agentName,
        repo: 'owner/repo',
        sourceLabel: 'owner/repo',
        agentsDir,
        clone: (_url, dest) => fs.cpSync(src, dest, {recursive: true}),
      })
      expect.fail('expected multiple skills')
    } catch (err) {
      expect(err).to.be.instanceOf(SkillError)
      const skillErr = err as SkillError
      expect(skillErr.code).to.equal('multiple')
      const choices = skillErr.details as Array<{name: string}>
      expect(choices.map((choice) => choice.name)).to.deep.equal(['alpha', 'zeta'])
    }
    expect(fs.readFileSync(path.join(agentsDir, agentName, 'agent.yaml'), 'utf8')).to.equal(before)
    expect(fs.existsSync(path.join(agentsDir, agentName, 'skills', 'alpha'))).to.equal(false)
    expect(fs.existsSync(path.join(agentsDir, agentName, 'skills', 'zeta'))).to.equal(false)
    fs.rmSync(src, {recursive: true, force: true})
  })

  it('errors when the repo has no SKILL.md', () => {
    const src = fixture((root) => {
      fs.writeFileSync(path.join(root, 'README.md'), 'no skill\n')
    })
    expect(() => installFromGitHub({
      agentName,
      repo: 'owner/repo',
      sourceLabel: 'owner/repo',
      agentsDir,
      clone: (_url, dest) => fs.cpSync(src, dest, {recursive: true}),
    })).to.throw(SkillError, 'No SKILL.md in owner/repo.')
    fs.rmSync(src, {recursive: true, force: true})
  })

  it('installs a folded description from a local github fixture', () => {
    const src = fixture((root) => {
      fs.writeFileSync(path.join(root, 'SKILL.md'), FOLDED_DESCRIPTION)
    })
    const entry = installFromGitHub({
      agentName,
      repo: 'owner/fold',
      sourceLabel: 'owner/fold',
      agentsDir,
      clone: (_url, dest) => fs.cpSync(src, dest, {recursive: true}),
    })
    expect(entry.description).to.equal('Sort incoming mail into buckets')
    const config = yaml.parse(fs.readFileSync(path.join(agentsDir, agentName, 'agent.yaml'), 'utf8'))
    const stored = config.skills.find((skill: {name: string}) => skill.name === 'triage-fold')
    expect(stored.description).to.equal('Sort incoming mail into buckets')
    expect(stored.description).to.not.include('\n')
    fs.rmSync(src, {recursive: true, force: true})
  })

  it('installs a literal description as one line from a local github fixture', () => {
    const src = fixture((root) => {
      fs.writeFileSync(path.join(root, 'SKILL.md'), LITERAL_DESCRIPTION)
    })
    const entry = installFromGitHub({
      agentName,
      repo: 'owner/literal',
      sourceLabel: 'owner/literal',
      agentsDir,
      clone: (_url, dest) => fs.cpSync(src, dest, {recursive: true}),
    })
    expect(entry.description).to.equal(
      'Sort incoming mail into buckets. Use when the user asks to triage an inbox.',
    )
    const config = yaml.parse(fs.readFileSync(path.join(agentsDir, agentName, 'agent.yaml'), 'utf8'))
    const stored = config.skills.find((skill: {name: string}) => skill.name === 'triage-lit')
    expect(stored.description).to.equal(
      'Sort incoming mail into buckets. Use when the user asks to triage an inbox.',
    )
    fs.rmSync(src, {recursive: true, force: true})
  })
})

describe('installFromGitHub agent skills directories', () => {
  const agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skills-agentskills-'))
  const agentName = 'email-agent'

  before(() => {
    const agent = path.join(agentsDir, agentName)
    fs.mkdirSync(agent, {recursive: true})
    fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: email-agent\ndescription: Mail\n')
  })

  after(() => {
    fs.rmSync(agentsDir, {recursive: true, force: true})
  })

  const cases: Array<{title: string; name: string; filename?: string; markdown: string; description: string}> = [
    {
      title: 'a frontmatter-only file',
      name: 'skill-name',
      markdown: minimalMarkdown(),
      description: 'A description of what this skill does and when to use it.',
    },
    {
      title: 'a folded description',
      name: 'folded-skill',
      markdown: foldedMarkdown('folded-skill'),
      description: WRAPPED,
    },
    {
      title: 'a literal description of two sentences',
      name: 'literal-skill',
      markdown: literalMarkdown('literal-skill'),
      description: WRAPPED,
    },
    {
      title: 'skill.md',
      name: 'lower-skill',
      filename: 'skill.md',
      markdown: minimalMarkdown('lower-skill'),
      description: 'A description of what this skill does and when to use it.',
    },
    {
      title: 'license and metadata',
      name: 'pdf-processing',
      markdown: metadataMarkdown(),
      description: 'Extract PDF text, fill forms, merge files. Use when handling PDFs.',
    },
    {
      title: 'a one-line skill with a body',
      name: 'triage',
      markdown: oneLineMarkdown(),
      description: 'Sort incoming mail into buckets',
    },
    {
      title: 'a 1024-character description',
      name: 'long-desc',
      markdown: longMarkdown(),
      description: LONG_DESCRIPTION,
    },
  ]

  for (const testCase of cases) {
    it(`installs ${testCase.title}`, () => {
      const filename = testCase.filename ?? 'SKILL.md'
      const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-src-'))
      fs.writeFileSync(path.join(src, filename), testCase.markdown)
      fs.mkdirSync(path.join(src, 'scripts'))
      fs.writeFileSync(path.join(src, 'scripts', 'run.sh'), 'echo hi\n')
      const entry = installFromGitHub({
        agentName,
        repo: 'owner/repo',
        sourceLabel: 'owner/repo',
        agentsDir,
        clone: (_url, dest) => fs.cpSync(src, dest, {recursive: true}),
      })
      expect(entry.description).to.equal(testCase.description)
      expect(entry.description).to.have.length(testCase.description.length)
      const installed = path.join(agentsDir, agentName, 'skills', testCase.name)
      expect(fs.readdirSync(installed).filter((name) => name.toLowerCase() === 'skill.md')).to.deep.equal([filename])
      expect(fs.readFileSync(path.join(installed, filename), 'utf8')).to.equal(testCase.markdown)
      expect(fs.readFileSync(path.join(installed, 'scripts', 'run.sh'), 'utf8')).to.equal('echo hi\n')
      const config = yaml.parse(fs.readFileSync(path.join(agentsDir, agentName, 'agent.yaml'), 'utf8'))
      const recorded = config.skills.find((skill: {name: string}) => skill.name === testCase.name)
      expect(recorded.description).to.equal(testCase.description)
      fs.rmSync(src, {recursive: true, force: true})
    })
  }

  it('rejects a blank description and writes nothing new', () => {
    const before = fs.readFileSync(path.join(agentsDir, agentName, 'agent.yaml'), 'utf8')
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-skill-blank-'))
    fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: blank-desc\ndescription: "   "\n---\n')
    expect(() => installFromGitHub({
      agentName,
      repo: 'owner/repo',
      sourceLabel: 'owner/repo',
      agentsDir,
      clone: (_url, dest) => fs.cpSync(src, dest, {recursive: true}),
    })).to.throw(SkillError, /description/)
    expect(fs.readFileSync(path.join(agentsDir, agentName, 'agent.yaml'), 'utf8')).to.equal(before)
    expect(fs.existsSync(path.join(agentsDir, agentName, 'skills', 'blank-desc'))).to.equal(false)
    fs.rmSync(src, {recursive: true, force: true})
  })
})

describe('duplicate message', () => {
  it('matches the modal copy', () => {
    expect(duplicateSkillMessage('triage', 'email-agent')).to.equal(
      "Skill 'triage' is already on 'email-agent'. Remove it with /skills first.",
    )
    expect(GITHUB_SOURCE_HINT).to.include('owner/name')
  })
})
