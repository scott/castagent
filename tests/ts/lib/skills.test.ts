import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  GITHUB_SOURCE_HINT,
  SkillError,
  duplicateSkillMessage,
  installFromGitHub,
  parseGitHubSource,
  parseSkillMarkdown,
  readSkillBody,
  renderSkillMarkdown,
  resolveFolderInput,
} from '../../../typescript/cast-cli/src/lib/skills'

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

  it('rejects a bad skill name', () => {
    expect(() => skillMarkdown('Triage', 'Sort mail', 'body')).to.throw(SkillError, /invalid/)
  })

  it('reads stdin when the body flag is -', () => {
    expect(readSkillBody('-', () => '# From stdin\n')).to.equal('# From stdin\n')
    expect(readSkillBody('# Inline\n', () => 'ignored')).to.equal('# Inline\n')
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
})

describe('duplicate message', () => {
  it('matches the modal copy', () => {
    expect(duplicateSkillMessage('triage', 'email-agent')).to.equal(
      "Skill 'triage' is already on 'email-agent'. Remove it with /skills first.",
    )
    expect(GITHUB_SOURCE_HINT).to.include('owner/name')
  })
})
