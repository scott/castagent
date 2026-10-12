import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import simpleGit from 'simple-git'
import * as yaml from 'yaml'
import {
  AGENT_NAME_PATTERN,
  AgentImportError,
  GIT_CLONE_ARGS,
  authCloneMessage,
  cloneGitRepo,
  formatCloneError,
  importAgent,
  invalidGitUrlMessage,
  resolveAgentSource,
  resolveGitHubShorthand,
} from '../../../typescript/cast-cli/src/lib/agent-import'

describe('importAgent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-import-'))
  const agentsDir = path.join(root, 'agents')
  const previousAgents = process.env.CAST_AGENTS_DIR

  before(() => {
    process.env.CAST_AGENTS_DIR = agentsDir
  })

  after(() => {
    if (previousAgents === undefined) delete process.env.CAST_AGENTS_DIR
    else process.env.CAST_AGENTS_DIR = previousAgents
    fs.rmSync(root, {recursive: true, force: true})
  })

  beforeEach(() => {
    fs.rmSync(agentsDir, {recursive: true, force: true})
    fs.mkdirSync(agentsDir, {recursive: true})
  })

  function sourceDir(name: string, files: Record<string, string>): string {
    const dir = path.join(root, 'sources', name)
    fs.rmSync(dir, {recursive: true, force: true})
    fs.mkdirSync(dir, {recursive: true})
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(dir, rel)
      fs.mkdirSync(path.dirname(file), {recursive: true})
      fs.writeFileSync(file, content)
    }
    return dir
  }

  async function gitFixture(name: string): Promise<string> {
    const dir = sourceDir(name, {
      'agent.yaml': 'name: fixture\ndescription: from git\n',
      'instructions.md': 'hello\n',
    })
    const git = simpleGit(dir)
    await git.init()
    await git.addConfig('user.email', 'cast-test@example.com')
    await git.addConfig('user.name', 'cast-test')
    await git.add(['agent.yaml', 'instructions.md'])
    await git.commit('init fixture')
    return dir
  }

  it('copies a local directory and initializes git when the copy has none', async () => {
    const src = sourceDir('local-agent', {
      'agent.yaml': 'name: local-agent\ndescription: copied\n',
      'instructions.md': 'do the thing\n',
    })
    const yamlBefore = fs.readFileSync(path.join(src, 'agent.yaml'), 'utf8')

    const result = await importAgent(src, {agentsDir})

    expect(result.name).to.equal('local-agent')
    expect(result.kind).to.equal('local')
    expect(result.path).to.equal(path.join(agentsDir, 'local-agent'))
    expect(fs.readFileSync(path.join(result.path, 'agent.yaml'), 'utf8')).to.equal(yamlBefore)
    expect(fs.readFileSync(path.join(result.path, 'instructions.md'), 'utf8')).to.equal('do the thing\n')
    expect(fs.existsSync(path.join(result.path, '.git', 'HEAD'))).to.equal(true)
    expect(result.commitCount).to.equal(0)
  })

  it('imports a relative path', async () => {
    const previous = process.cwd()
    const work = path.join(root, 'rel-work')
    fs.mkdirSync(work, {recursive: true})
    process.chdir(work)
    try {
      fs.mkdirSync('demo-agent', {recursive: true})
      fs.writeFileSync(path.join('demo-agent', 'agent.yaml'), 'name: demo-agent\n')
      const result = await importAgent('./demo-agent', {agentsDir})
      expect(result.name).to.equal('demo-agent')
      expect(fs.existsSync(path.join(result.path, 'agent.yaml'))).to.equal(true)
    } finally {
      process.chdir(previous)
    }
  })

  it('uses an explicit name instead of the directory basename', async () => {
    const src = sourceDir('from-dir', {'agent.yaml': 'name: from-dir\n'})
    const result = await importAgent(src, {name: 'chosen-name', agentsDir})
    expect(result.name).to.equal('chosen-name')
    expect(fs.existsSync(path.join(agentsDir, 'chosen-name', 'agent.yaml'))).to.equal(true)
    expect(fs.existsSync(path.join(agentsDir, 'from-dir'))).to.equal(false)
  })

  it('does not modify an existing agent on name collision', async () => {
    const existing = path.join(agentsDir, 'demo')
    fs.mkdirSync(existing, {recursive: true})
    fs.writeFileSync(path.join(existing, 'agent.yaml'), 'name: old\n')
    fs.writeFileSync(path.join(existing, 'keep.txt'), 'original')
    const src = sourceDir('incoming', {
      'agent.yaml': 'name: new\n',
      'keep.txt': 'replaced\n',
    })

    try {
      await importAgent(src, {name: 'demo', agentsDir})
      expect.fail('expected a name collision')
    } catch (error) {
      expect(error).to.be.instanceOf(AgentImportError)
      const err = error as AgentImportError
      expect(err.code).to.equal('name-collision')
      expect(err.message).to.equal(
        "Agent 'demo' already exists. Use --force to overwrite or pick a different name.",
      )
    }

    expect(fs.readFileSync(path.join(existing, 'keep.txt'), 'utf8')).to.equal('original')
    expect(fs.readFileSync(path.join(existing, 'agent.yaml'), 'utf8')).to.equal('name: old\n')
    expect(fs.existsSync(path.join(agentsDir, '.demo.importing'))).to.equal(false)
    expect(fs.readdirSync(agentsDir)).to.deep.equal(['demo'])
  })

  it('overwrites an existing agent when force is set', async () => {
    const existing = path.join(agentsDir, 'demo')
    fs.mkdirSync(existing, {recursive: true})
    fs.writeFileSync(path.join(existing, 'agent.yaml'), 'name: old\n')
    fs.writeFileSync(path.join(existing, 'keep.txt'), 'original')
    const src = sourceDir('incoming-force', {
      'agent.yaml': 'name: new\n',
    })

    const result = await importAgent(src, {name: 'demo', force: true, agentsDir})
    expect(result.name).to.equal('demo')
    expect(fs.readFileSync(path.join(existing, 'agent.yaml'), 'utf8')).to.equal('name: new\n')
    expect(fs.existsSync(path.join(existing, 'keep.txt'))).to.equal(false)
    expect(fs.existsSync(path.join(agentsDir, '.demo.importing'))).to.equal(false)
    expect(fs.existsSync(path.join(agentsDir, '.demo.replacing'))).to.equal(false)
  })

  it('rejects a directory with no agent.yaml and leaves no target', async () => {
    const src = sourceDir('not-an-agent', {'README.md': 'nope\n'})
    try {
      await importAgent(src, {agentsDir})
      expect.fail('expected missing agent.yaml')
    } catch (error) {
      const err = error as AgentImportError
      expect(err.code).to.equal('missing-agent-yaml')
      expect(err.message).to.equal('Directory does not contain a Cast agent (missing agent.yaml).')
    }
    expect(fs.existsSync(path.join(agentsDir, 'not-an-agent'))).to.equal(false)
  })

  it('reports a missing path and does not create the agents directory entry', async () => {
    const missing = path.join(root, 'no-such-directory')
    try {
      await importAgent(missing, {agentsDir: path.join(root, 'unused-agents')})
      expect.fail('expected missing path')
    } catch (error) {
      const err = error as AgentImportError
      expect(err.code).to.equal('missing-path')
      expect(err.message).to.equal(`Path '${missing}' does not exist.`)
    }
    expect(fs.existsSync(path.join(root, 'unused-agents'))).to.equal(false)
  })

  it('rejects an invalid agent name before writing', async () => {
    const src = sourceDir('ok-src', {'agent.yaml': 'name: ok\n'})
    try {
      await importAgent(src, {name: 'bad_name', agentsDir})
      expect.fail('expected invalid name')
    } catch (error) {
      const err = error as AgentImportError
      expect(err.code).to.equal('invalid-name')
      expect(err.message).to.include('letters, numbers, and hyphens')
    }
    expect(fs.existsSync(path.join(agentsDir, 'bad_name'))).to.equal(false)
    expect(AGENT_NAME_PATTERN.test('bad_name')).to.equal(false)
    expect(AGENT_NAME_PATTERN.test('good-name')).to.equal(true)
  })

  it('keeps an existing .git directory on filesystem import', async () => {
    const src = sourceDir('with-git', {'agent.yaml': 'name: with-git\n'})
    fs.mkdirSync(path.join(src, '.git'))
    fs.writeFileSync(path.join(src, '.git', 'MARK'), 'keep-me')

    const result = await importAgent(src, {agentsDir})
    expect(fs.readFileSync(path.join(result.path, '.git', 'MARK'), 'utf8')).to.equal('keep-me')
  })

  describe('user/repo shorthand', () => {
    it('resolves user/repo to a GitHub git URL without a network call', () => {
      expect(resolveGitHubShorthand('octo/hello')).to.deep.equal({
        url: 'https://github.com/octo/hello.git',
        repo: 'hello',
      })
      expect(resolveGitHubShorthand('octo/hello.git')).to.deep.equal({
        url: 'https://github.com/octo/hello.git',
        repo: 'hello',
      })
      expect(resolveGitHubShorthand('https://github.com/octo/hello')).to.equal(null)
      expect(resolveGitHubShorthand('git@github.com:octo/hello.git')).to.equal(null)
      expect(resolveGitHubShorthand('./octo/hello')).to.equal(null)
      expect(resolveGitHubShorthand('octo/hello/extra')).to.equal(null)
      expect(resolveGitHubShorthand('not-a-url')).to.equal(null)
    })

    it('clones the resolved https URL when importing user/repo', async () => {
      const calls: Array<{url: string; dest: string}> = []
      const result = await importAgent('octo/hello', {
        agentsDir,
        cloneRepo: async (url, dest) => {
          calls.push({url, dest})
          fs.writeFileSync(path.join(dest, 'agent.yaml'), 'name: hello\n')
          fs.mkdirSync(path.join(dest, '.git'))
        },
      })
      expect(calls).to.have.length(1)
      expect(calls[0].url).to.equal('https://github.com/octo/hello.git')
      expect(result.name).to.equal('hello')
      expect(result.resolvedSource).to.equal('https://github.com/octo/hello.git')
      expect(result.kind).to.equal('git')
      const config = yaml.parse(fs.readFileSync(path.join(result.path, 'agent.yaml'), 'utf8'))
      expect(config.repository).to.deep.equal({
        remote: 'origin',
        url: 'https://github.com/octo/hello.git',
        branch: 'main',
      })
    })
  })

  describe('git clone behavior', () => {
    it('leaves https and ssh URLs unchanged', () => {
      const https = resolveAgentSource('https://github.com/user/my-agent.git')
      expect(https.kind).to.equal('git')
      expect(https.location).to.equal('https://github.com/user/my-agent.git')
      expect(https.defaultName).to.equal('my-agent')

      const httpsBare = resolveAgentSource('https://github.com/user/my-agent')
      expect(httpsBare.location).to.equal('https://github.com/user/my-agent')
      expect(httpsBare.defaultName).to.equal('my-agent')

      const ssh = resolveAgentSource('git@github.com:user/my-agent.git')
      expect(ssh.kind).to.equal('git')
      expect(ssh.location).to.equal('git@github.com:user/my-agent.git')
      expect(ssh.defaultName).to.equal('my-agent')
    })

    it('clones with --single-branch and records repository metadata', async () => {
      expect(GIT_CLONE_ARGS).to.deep.equal(['--single-branch'])
      const fixture = await gitFixture('remote-agent')
      const cloned = path.join(root, 'real-clone')
      fs.rmSync(cloned, {recursive: true, force: true})
      await cloneGitRepo(fixture, cloned)
      const configText = fs.readFileSync(path.join(cloned, '.git', 'config'), 'utf8')
      expect(configText).to.not.include('refs/heads/*')
      expect(fs.existsSync(path.join(cloned, 'agent.yaml'))).to.equal(true)

      const calls: string[] = []
      const result = await importAgent('https://github.com/user/my-agent.git', {
        agentsDir,
        cloneRepo: async (url, dest) => {
          calls.push(url)
          fs.cpSync(fixture, dest, {recursive: true})
        },
      })
      expect(calls).to.deep.equal(['https://github.com/user/my-agent.git'])
      expect(result.name).to.equal('my-agent')
      expect(result.commitCount).to.be.greaterThan(0)
      const config = yaml.parse(fs.readFileSync(path.join(result.path, 'agent.yaml'), 'utf8'))
      expect(config.repository.url).to.equal('https://github.com/user/my-agent.git')
      expect(config.repository.remote).to.equal('origin')
      expect(config.repository.branch).to.equal('main')
    })

    it('keeps the historical git collision message and does not clone', async () => {
      const existing = path.join(agentsDir, 'my-agent')
      fs.mkdirSync(existing, {recursive: true})
      fs.writeFileSync(path.join(existing, 'agent.yaml'), 'name: old\n')
      let called = false
      try {
        await importAgent('https://github.com/user/my-agent.git', {
          agentsDir,
          cloneRepo: async () => {
            called = true
          },
        })
        expect.fail('expected collision')
      } catch (error) {
        const err = error as AgentImportError
        expect(err.code).to.equal('name-collision')
        expect(err.message).to.equal(
          `Agent 'my-agent' already exists at ${existing}.\n` +
          `Remove it first with: cast delete my-agent\n` +
          `Or use a different name as the second argument.`,
        )
        expect(formatCloneError(err, {agentPath: existing, source: 'https://github.com/user/my-agent.git'})).to.equal(err.message)
      }
      expect(called).to.equal(false)
      expect(fs.readFileSync(path.join(existing, 'agent.yaml'), 'utf8')).to.equal('name: old\n')
    })

    it('removes a partial directory when the clone has no agent.yaml', async () => {
      try {
        await importAgent('https://github.com/user/empty.git', {
          name: 'empty-agent',
          agentsDir,
          cloneRepo: async (_url, dest) => {
            fs.writeFileSync(path.join(dest, 'README.md'), 'no agent\n')
          },
        })
        expect.fail('expected missing yaml')
      } catch (error) {
        const err = error as AgentImportError
        expect(err.code).to.equal('missing-agent-yaml')
        expect(err.message).to.equal(
          `Cloned repository does not contain a valid Cast agent.\n` +
          `Expected to find 'agent.yaml' in the root directory.`,
        )
      }
      expect(fs.existsSync(path.join(agentsDir, 'empty-agent'))).to.equal(false)
    })

    it('surfaces auth failures as a typed error and removes the partial directory', async () => {
      try {
        await importAgent('https://github.com/user/private.git', {
          name: 'private-agent',
          agentsDir,
          cloneRepo: async () => {
            throw new Error('Authentication failed for https://github.com/user/private.git')
          },
        })
        expect.fail('expected auth failure')
      } catch (error) {
        const err = error as AgentImportError
        expect(err.code).to.equal('auth')
        expect(err.message).to.include('Authentication failed')
        expect(formatCloneError(err, {agentPath: '', source: 'https://github.com/user/private.git'})).to.equal(authCloneMessage())
      }
      expect(fs.existsSync(path.join(agentsDir, 'private-agent'))).to.equal(false)
    })

    it('prefixes other git failures with Failed to clone', () => {
      const error = new AgentImportError('Repository not found', 'other', {sourceKind: 'git'})
      expect(formatCloneError(error, {agentPath: '', source: 'https://github.com/user/missing.git'})).to.equal(
        'Failed to clone: Repository not found',
      )
    })

    it('keeps the historical invalid URL message', () => {
      expect(formatCloneError(
        new AgentImportError('nope', 'invalid-source'),
        {agentPath: '', source: 'not-a-url'},
      )).to.equal(invalidGitUrlMessage('not-a-url'))
    })
  })
})
