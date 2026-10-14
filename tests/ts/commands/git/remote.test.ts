import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'
import GitRemote from '../../../../typescript/cast-cli/src/commands/git/remote'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {cwd, encoding: 'utf8'})
}

function createCommandInstance(argv: string[]): any {
  const instance: any = new GitRemote(argv, {color: false} as any)
  instance.config = {
    runHook: async () => {},
    name: 'git:remote',
    bin: 'cast',
  }
  instance.args = {
    agent: argv[2],
    action: argv[3],
    name: argv[4],
    url: argv[5],
  }
  instance.flags = {visibility: 'private'}
  instance.parse = async () => ({args: instance.args, flags: instance.flags})
  return instance
}

function capture(instance: any): {logs: string[]; errors: string[]} {
  const logs: string[] = []
  const errors: string[] = []
  instance.log = (msg?: string) => {
    logs.push(msg ?? '')
  }
  instance.error = (msg?: any) => {
    const text = typeof msg === 'string' ? msg : (msg?.message ?? String(msg))
    errors.push(text)
    const error = new Error(text) as Error & {oclif?: {exit: number}}
    error.oclif = {exit: 2}
    throw error
  }
  return {logs, errors}
}

interface AgentRepo {
  agentName: string
  agentDir: string
  configPath: string
}

function createAgentRepo(yamlBody: string): AgentRepo {
  const agentName = `test-git-remote-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
  fs.mkdirSync(agentDir, {recursive: true})
  const configPath = path.join(agentDir, 'agent.yaml')
  fs.writeFileSync(configPath, yamlBody)
  git(agentDir, ['init', '-b', 'main'])
  git(agentDir, ['config', 'user.email', 'test@test.com'])
  git(agentDir, ['config', 'user.name', 'Test'])
  return {agentName, agentDir, configPath}
}

function removeAgent(repo: AgentRepo): void {
  fs.rmSync(repo.agentDir, {recursive: true, force: true})
}

const AGENT_YAML = `# agent identity
name: bb-git
description: keep me
repository:
  remote: origin
  url: https://github.com/scott/bb-nope.git
  branch: main
tools:
  builtin:
    - bash
`

describe('Git Remote Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitRemote.description).to.equal('Manage Git remotes for an agent')
    })

    it('should require agent argument', () => {
      expect(GitRemote.args).to.have.property('agent')
      expect(GitRemote.args.agent.required).to.be.true
      expect(GitRemote.args.agent.description).to.equal('Agent name')
    })

    it('should require action argument', () => {
      expect(GitRemote.args).to.have.property('action')
      expect(GitRemote.args.action.required).to.be.true
    })

    it('should have optional name argument', () => {
      expect(GitRemote.args).to.have.property('name')
      expect(GitRemote.args.name.required).to.be.false
    })

    it('should have optional url argument', () => {
      expect(GitRemote.args).to.have.property('url')
      expect(GitRemote.args.url.required).to.be.false
    })

    it('should have --visibility flag with options', () => {
      expect(GitRemote.flags).to.have.property('visibility')
      expect(GitRemote.flags.visibility.options).to.deep.equal(['private', 'public'])
      expect(GitRemote.flags.visibility.default).to.equal('private')
    })

    it('should have examples', () => {
      expect(GitRemote.examples).to.be.an('array')
      expect(GitRemote.examples.length).to.be.greaterThan(0)
      expect(GitRemote.examples.join('\n')).to.include('set-url')
    })

    it('should list set-url as an action', () => {
      expect(GitRemote.args.action.description).to.include('set-url')
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitRemote(['git', 'remote', 'test-agent', 'list'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('supported actions', () => {
    it('should support list action', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should support add action', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should support create action', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should support remove action', () => {
      expect(GitRemote).to.be.a('function')
    })
  })

  describe('list action', () => {
    it('should display all remotes', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should show fetch and push URLs', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should show helpful message when no remotes', () => {
      expect(GitRemote).to.be.a('function')
    })
  })

  describe('add action', () => {
    it('should require name and url arguments', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should use git.addRemote()', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should error if remote already exists', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should update agent.yaml with repository URL', () => {
      expect(GitRemote).to.be.a('function')
    })
  })

  describe('create action', () => {
    it('should use GitHub CLI (gh) to create repo', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should check if gh is installed', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should check if gh is authenticated', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should support --visibility flag', () => {
      expect(GitRemote.flags.visibility.options).to.include('private')
      expect(GitRemote.flags.visibility.options).to.include('public')
    })

    it('should push to newly created remote', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should error if gh not installed', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should error if not authenticated', () => {
      expect(GitRemote).to.be.a('function')
    })
  })

  describe('remove action', () => {
    it('should require name argument', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should use git.removeRemote()', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should error if remote does not exist', () => {
      expect(GitRemote).to.be.a('function')
    })
  })

  describe('repository.url', () => {
    it('clears repository.url when remove drops the remote it came from', async () => {
      const repo = createAgentRepo(AGENT_YAML)
      git(repo.agentDir, ['remote', 'add', 'origin', 'https://github.com/scott/bb-nope.git'])
      const instance = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
      const {logs} = capture(instance)

      try {
        await instance.run()
        const raw = fs.readFileSync(repo.configPath, 'utf8')
        const config = yaml.parse(raw)
        expect(logs.join('\n')).to.include("Removed remote 'origin'")
        expect(git(repo.agentDir, ['remote'])).to.equal('')
        expect(config.repository.url).to.equal(undefined)
        expect(raw).to.not.include('bb-nope')
        expect(config.repository.remote).to.equal('origin')
        expect(config.repository.branch).to.equal('main')
        expect(config.description).to.equal('keep me')
        expect(config.tools.builtin).to.deep.equal(['bash'])
        expect(raw).to.include('# agent identity')
      } finally {
        removeAgent(repo)
      }
    })

    it('clears repository.url after add then remove', async () => {
      const repo = createAgentRepo([
        'name: bb-git',
        'repository:',
        '  remote: origin',
        '  branch: main',
        '',
      ].join('\n'))
      const url = 'https://github.com/scott/bb-nope.git'
      const add = createCommandInstance(['git', 'remote', repo.agentName, 'add', 'origin', url])
      capture(add)

      try {
        await add.run()
        expect(yaml.parse(fs.readFileSync(repo.configPath, 'utf8')).repository.url).to.equal(url)

        const remove = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
        capture(remove)
        await remove.run()

        const config = yaml.parse(fs.readFileSync(repo.configPath, 'utf8'))
        expect(config.repository.url).to.equal(undefined)
        expect(config.repository.remote).to.equal('origin')
        expect(config.repository.branch).to.equal('main')
        expect(git(repo.agentDir, ['remote'])).to.equal('')
      } finally {
        removeAgent(repo)
      }
    })

    it('clears repository.url when the git remote embeds credentials', async () => {
      const repo = createAgentRepo(AGENT_YAML)
      git(repo.agentDir, ['remote', 'add', 'origin', 'https://user:secret@github.com/scott/bb-nope.git'])
      const instance = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
      capture(instance)

      try {
        await instance.run()
        const raw = fs.readFileSync(repo.configPath, 'utf8')
        const config = yaml.parse(raw)
        expect(config.repository.url).to.equal(undefined)
        expect(raw).to.not.include('bb-nope')
        expect(raw).to.not.include('secret')
        expect(config.repository.remote).to.equal('origin')
        expect(config.repository.branch).to.equal('main')
      } finally {
        removeAgent(repo)
      }
    })

    it('clears repository.url when only the .git suffix differs', async () => {
      const repo = createAgentRepo([
        'name: bb-git',
        'repository:',
        '  remote: origin',
        '  url: https://github.com/scott/bb-nope',
        '  branch: main',
        '',
      ].join('\n'))
      git(repo.agentDir, ['remote', 'add', 'origin', 'https://github.com/scott/bb-nope.git/'])
      const instance = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
      capture(instance)

      try {
        await instance.run()
        const config = yaml.parse(fs.readFileSync(repo.configPath, 'utf8'))
        expect(config.repository.url).to.equal(undefined)
        expect(config.repository.branch).to.equal('main')
      } finally {
        removeAgent(repo)
      }
    })

    it('keeps repository.url when a different remote is removed', async () => {
      const repo = createAgentRepo(AGENT_YAML)
      git(repo.agentDir, ['remote', 'add', 'origin', 'https://github.com/scott/bb-nope.git'])
      git(repo.agentDir, ['remote', 'add', 'upstream', 'https://github.com/other/fork.git'])
      const before = fs.readFileSync(repo.configPath, 'utf8')
      const instance = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'upstream'])
      capture(instance)

      try {
        await instance.run()
        expect(fs.readFileSync(repo.configPath, 'utf8')).to.equal(before)
        expect(git(repo.agentDir, ['remote']).trim().split('\n')).to.deep.equal(['origin'])
      } finally {
        removeAgent(repo)
      }
    })

    it('keeps repository.url when another remote still uses it', async () => {
      const repo = createAgentRepo(AGENT_YAML)
      const url = 'https://github.com/scott/bb-nope.git'
      git(repo.agentDir, ['remote', 'add', 'origin', url])
      git(repo.agentDir, ['remote', 'add', 'mirror', url])
      const before = fs.readFileSync(repo.configPath, 'utf8')
      const instance = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
      capture(instance)

      try {
        await instance.run()
        expect(fs.readFileSync(repo.configPath, 'utf8')).to.equal(before)
        expect(yaml.parse(before).repository.url).to.equal(url)
        expect(git(repo.agentDir, ['remote']).trim()).to.equal('mirror')
      } finally {
        removeAgent(repo)
      }
    })

    it('leaves agent.yaml unchanged when repository.url is absent', async () => {
      const body = [
        'name: bb-git',
        'repository:',
        '  remote: origin',
        '  branch: main',
        '',
      ].join('\n')
      const repo = createAgentRepo(body)
      git(repo.agentDir, ['remote', 'add', 'origin', 'https://github.com/scott/bb-nope.git'])
      const instance = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
      capture(instance)

      try {
        await instance.run()
        expect(fs.readFileSync(repo.configPath, 'utf8')).to.equal(body)
        expect(git(repo.agentDir, ['remote'])).to.equal('')
      } finally {
        removeAgent(repo)
      }
    })

    it('does not change agent.yaml when the remote is missing', async () => {
      const repo = createAgentRepo(AGENT_YAML)
      const before = fs.readFileSync(repo.configPath, 'utf8')
      const instance = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
      const {errors} = capture(instance)

      try {
        await instance.run()
        expect.fail('expected a missing remote to fail')
      } catch (error: any) {
        expect(String(error.message)).to.include('does not exist')
        expect(errors.join('\n')).to.include('does not exist')
        expect(fs.readFileSync(repo.configPath, 'utf8')).to.equal(before)
      } finally {
        removeAgent(repo)
      }
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should error if not a git repo', () => {
      expect(GitRemote).to.be.a('function')
    })

    it('should error for unknown action', () => {
      expect(GitRemote).to.be.a('function')
    })
  })
})

interface RepoContext {
  agentName: string
  agentDir: string
}

function createSetUrlRepo(remoteUrl = 'https://example.com/original.git'): RepoContext {
  const agentName = `test-remote-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

  fs.mkdirSync(agentDir, {recursive: true})
  fs.writeFileSync(path.join(agentDir, 'agent.yaml'), [
    'name: test-agent',
    'description: remote url tests',
    'repository:',
    '  remote: origin',
    `  url: ${remoteUrl}`,
    '  branch: main',
    '',
  ].join('\n'))

  git(agentDir, ['init', '-b', 'main'])
  git(agentDir, ['remote', 'add', 'up', remoteUrl])

  return {agentName, agentDir}
}

function removeRepo(ctx: RepoContext): void {
  fs.rmSync(ctx.agentDir, {recursive: true, force: true})
}

function remoteUrl(agentDir: string, name: string, push = false): string {
  const args = push ? ['remote', 'get-url', '--push', name] : ['remote', 'get-url', name]
  return git(agentDir, args).trim()
}

function repositoryUrl(agentDir: string): string {
  const config = yaml.parse(fs.readFileSync(path.join(agentDir, 'agent.yaml'), 'utf8'))
  return config?.repository?.url
}

describe('Git Remote set-url', () => {
  const repos: RepoContext[] = []

  afterEach(() => {
    while (repos.length > 0) {
      const ctx = repos.pop()
      if (ctx) removeRepo(ctx)
    }
  })

  it('updates an existing remote URL and agent.yaml', async () => {
    const ctx = createSetUrlRepo()
    repos.push(ctx)
    const next = 'https://example.com/x.git'
    const instance = createCommandInstance(['git', 'remote', ctx.agentName, 'set-url', 'up', next])
    const {logs, errors} = capture(instance)

    await instance.run()

    expect(errors).to.deep.equal([])
    expect(logs.join('\n')).to.include(`Updated remote 'up'`)
    expect(logs.join('\n')).to.include(next)
    expect(remoteUrl(ctx.agentDir, 'up')).to.equal(next)
    expect(remoteUrl(ctx.agentDir, 'up', true)).to.equal(next)
    expect(repositoryUrl(ctx.agentDir)).to.equal(next)

    const config = yaml.parse(fs.readFileSync(path.join(ctx.agentDir, 'agent.yaml'), 'utf8'))
    expect(config.name).to.equal('test-agent')
    expect(config.repository.remote).to.equal('origin')
    expect(config.repository.branch).to.equal('main')
  })

  it('points add at set-url when the remote already exists', async () => {
    const ctx = createSetUrlRepo()
    repos.push(ctx)
    const original = 'https://example.com/original.git'
    const instance = createCommandInstance([
      'git', 'remote', ctx.agentName, 'add', 'up', 'https://example.com/x.git',
    ])
    const {errors} = capture(instance)

    try {
      await instance.run()
      expect.fail('add should reject an existing remote')
    } catch (error: any) {
      expect(error.message).to.include("Remote 'up' already exists")
      expect(error.message).to.include("set-url")
    }

    expect(errors[0]).to.include("Use 'remove' to delete it first, or use 'set-url' to update it.")
    expect(remoteUrl(ctx.agentDir, 'up')).to.equal(original)
    expect(repositoryUrl(ctx.agentDir)).to.equal(original)
  })

  it('rejects set-url for a remote that does not exist', async () => {
    const ctx = createSetUrlRepo()
    repos.push(ctx)
    const original = 'https://example.com/original.git'
    const instance = createCommandInstance([
      'git', 'remote', ctx.agentName, 'set-url', 'missing', 'https://example.com/x.git',
    ])
    const {errors} = capture(instance)

    try {
      await instance.run()
      expect.fail('set-url should reject a missing remote')
    } catch (error: any) {
      expect(error.message).to.include("Remote 'missing' does not exist")
      expect(error.message).to.include("Use 'add' to create it.")
    }

    expect(errors).to.have.length(1)
    expect(remoteUrl(ctx.agentDir, 'up')).to.equal(original)
    expect(repositoryUrl(ctx.agentDir)).to.equal(original)
    expect(() => remoteUrl(ctx.agentDir, 'missing')).to.throw()
  })

  it('requires a remote name and url', async () => {
    const ctx = createSetUrlRepo()
    repos.push(ctx)

    const missingName = createCommandInstance(['git', 'remote', ctx.agentName, 'set-url'])
    capture(missingName)
    try {
      await missingName.run()
      expect.fail('set-url should require a name')
    } catch (error: any) {
      expect(error.message).to.include('Remote name required')
      expect(error.message).to.include('set-url <name> <url>')
    }

    const missingUrl = createCommandInstance(['git', 'remote', ctx.agentName, 'set-url', 'up'])
    capture(missingUrl)
    try {
      await missingUrl.run()
      expect.fail('set-url should require a url')
    } catch (error: any) {
      expect(error.message).to.include('Remote URL required')
      expect(error.message).to.include('set-url <name> <url>')
    }
  })

  it('rejects an unknown action and lists set-url', async () => {
    const ctx = createSetUrlRepo()
    repos.push(ctx)
    const instance = createCommandInstance(['git', 'remote', ctx.agentName, 'rename', 'up'])
    capture(instance)

    try {
      await instance.run()
      expect.fail('rename is not a remote action')
    } catch (error: any) {
      expect(error.message).to.include("Unknown action 'rename'")
      expect(error.message).to.include('list, add, create, remove, set-url')
    }
  })
})

const GH_FAKE = `#!/usr/bin/env node
const {execFileSync} = require('child_process')
const fs = require('fs')
const args = process.argv.slice(2)

if (args[0] === '--version') process.exit(0)
if (args[0] === 'auth' && args[1] === 'status') {
  process.stdout.write('Logged in to github.com account scott\\n')
  process.exit(0)
}
if (args[0] === 'api' && args[1] === 'user') {
  if (process.env.GH_FAKE_API_FAIL === '1') {
    process.stderr.write('api failed\\n')
    process.exit(1)
  }
  process.stdout.write((process.env.GH_FAKE_LOGIN || 'scott') + '\\n')
  process.exit(0)
}
if (args[0] === 'repo' && args[1] === 'create') {
  if (process.env.GH_FAKE_LOG) fs.appendFileSync(process.env.GH_FAKE_LOG, JSON.stringify(args) + '\\n')
  if (process.env.GH_FAKE_CREATE_FAIL === '1') process.exit(2)
  const repo = args[2]
  let source = ''
  let remote = 'origin'
  for (let i = 3; i < args.length; i++) {
    if (args[i] === '--source') source = args[++i]
    else if (args[i] === '--remote') remote = args[++i]
  }
  const style = process.env.GH_FAKE_REMOTE_STYLE || 'https'
  if (style !== 'none') {
    let url = process.env.GH_FAKE_REMOTE_URL
    if (!url) {
      if (style === 'ssh') url = 'git@github.com:scott/' + repo + '.git'
      else if (style === 'creds') url = 'https://user:secret@github.com/scott/' + repo + '.git'
      else if (style === 'ssh-url') url = 'ssh://git@github.com/scott/' + repo + '.git'
      else url = 'https://github.com/scott/' + repo + '.git'
    }
    execFileSync('git', ['-C', source, 'remote', 'add', remote, url], {stdio: 'inherit'})
  }
  process.exit(0)
}
process.stderr.write('unexpected gh args: ' + args.join(' ') + '\\n')
process.exit(1)
`

const PRESERVED_YAML = `# agent identity
name: "cast-email-assistant"
description: >
  A long description that should stay wrapped
  exactly like this.
repository:
  remote: origin
  branch: main
tools:
  builtin:
      - bash
      - "web"
  extra: 'keep-quotes'
`

function withCreateEnv(values: Record<string, string | undefined>): () => void {
  const keys = ['USER', 'GH_FAKE_REMOTE_STYLE', 'GH_FAKE_REMOTE_URL', 'GH_FAKE_LOGIN', 'GH_FAKE_API_FAIL', 'GH_FAKE_CREATE_FAIL', 'GH_FAKE_LOG']
  const previous = new Map<string, string | undefined>()
  for (const key of keys) previous.set(key, process.env[key])
  for (const key of keys) delete process.env[key]
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.env.USER = values.USER === undefined ? 'box' : values.USER
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

describe('Git Remote create repository.url', () => {
  let binDir = ''
  let previousPath = ''

  before(() => {
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-gh-fake-'))
    fs.writeFileSync(path.join(binDir, 'gh'), GH_FAKE, {mode: 0o755})
    previousPath = process.env.PATH || ''
    process.env.PATH = `${binDir}${path.delimiter}${previousPath}`
  })

  after(() => {
    process.env.PATH = previousPath
    fs.rmSync(binDir, {recursive: true, force: true})
  })

  async function runCreate(repo: AgentRepo, visibility = 'private'): Promise<{logs: string[]; errors: string[]}> {
    const instance = createCommandInstance(['git', 'remote', repo.agentName, 'create', 'origin'])
    instance.flags.visibility = visibility
    const captured = capture(instance)
    await instance.run()
    return captured
  }

  it('writes the GitHub owner from the created remote, not the local username', async () => {
    const repo = createAgentRepo(PRESERVED_YAML)
    const restore = withCreateEnv({})
    try {
      const {logs, errors} = await runCreate(repo, 'public')
      const raw = fs.readFileSync(repo.configPath, 'utf8')
      const url = `https://github.com/scott/${repo.agentName}`
      expect(errors).to.deep.equal([])
      expect(logs.join('\n')).to.include("GitHub repository created and remote 'origin' added!")
      expect(yaml.parse(raw).repository.url).to.equal(url)
      expect(raw).to.equal(PRESERVED_YAML.replace(
        '  branch: main\n',
        `  branch: main\n  url: ${url}\n`,
      ))
      expect(raw).to.not.include('github.com/box')
      expect(raw).to.not.include('github.com/ubuntu')
      expect(raw).to.not.include('github.com/you')
      expect(raw).to.not.include('x-access-token')
      const stored = fs.readFileSync(path.join(repo.agentDir, '.git', 'config'), 'utf8')
      expect(stored).to.include(`url = https://github.com/scott/${repo.agentName}.git`)
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('uses an ssh remote URL as the https GitHub owner', async () => {
    const repo = createAgentRepo(PRESERVED_YAML)
    const restore = withCreateEnv({GH_FAKE_REMOTE_STYLE: 'ssh'})
    try {
      await runCreate(repo)
      const raw = fs.readFileSync(repo.configPath, 'utf8')
      expect(yaml.parse(raw).repository.url).to.equal(`https://github.com/scott/${repo.agentName}`)
      expect(raw).to.include('description: >')
      expect(raw).to.include('      - bash')
      expect(raw).to.include("'keep-quotes'")
      expect(raw).to.not.include('github.com/box')
      expect(raw).to.not.include('x-access-token')
      const stored = fs.readFileSync(path.join(repo.agentDir, '.git', 'config'), 'utf8')
      expect(stored).to.include(`git@github.com:scott/${repo.agentName}.git`)
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('uses an ssh:// remote URL as the https GitHub owner', async () => {
    const repo = createAgentRepo('name: bb-git\nrepository:\n  remote: origin\n  branch: main\n')
    const restore = withCreateEnv({GH_FAKE_REMOTE_STYLE: 'ssh-url'})
    try {
      await runCreate(repo)
      const raw = fs.readFileSync(repo.configPath, 'utf8')
      expect(yaml.parse(raw).repository.url).to.equal(`https://github.com/scott/${repo.agentName}`)
      expect(raw).to.not.include('x-access-token')
      const stored = fs.readFileSync(path.join(repo.agentDir, '.git', 'config'), 'utf8')
      expect(stored).to.include(`ssh://git@github.com/scott/${repo.agentName}.git`)
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('drops credentials and a .git suffix from the created remote', async () => {
    const repo = createAgentRepo('name: bb-git\nrepository:\n  remote: origin\n  branch: main\n')
    const restore = withCreateEnv({GH_FAKE_REMOTE_STYLE: 'creds'})
    try {
      await runCreate(repo)
      const raw = fs.readFileSync(repo.configPath, 'utf8')
      expect(yaml.parse(raw).repository.url).to.equal(`https://github.com/scott/${repo.agentName}`)
      expect(raw).to.not.include('secret')
      expect(raw).to.not.include('.git')
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('keeps an enterprise host and owner from the remote URL', async () => {
    const repo = createAgentRepo('name: bb-git\nrepository:\n  remote: origin\n  branch: main\n')
    const remote = `https://git.example.com/acme/${repo.agentName}.git`
    const restore = withCreateEnv({GH_FAKE_REMOTE_URL: remote, GH_FAKE_API_FAIL: '1'})
    try {
      await runCreate(repo)
      expect(yaml.parse(fs.readFileSync(repo.configPath, 'utf8')).repository.url).to.equal(
        `https://git.example.com/acme/${repo.agentName}`,
      )
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('falls back to gh api user when create does not record a remote', async () => {
    const repo = createAgentRepo('name: bb-git\nrepository:\n  remote: origin\n  branch: main\n')
    const restore = withCreateEnv({GH_FAKE_REMOTE_STYLE: 'none', GH_FAKE_LOGIN: 'octocat'})
    try {
      await runCreate(repo)
      const raw = fs.readFileSync(repo.configPath, 'utf8')
      expect(yaml.parse(raw).repository.url).to.equal(`https://github.com/octocat/${repo.agentName}`)
      expect(raw).to.not.include('github.com/box')
      expect(git(repo.agentDir, ['remote'])).to.equal('')
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('replaces an existing repository.url without moving the other keys', async () => {
    const body = [
      '# keep',
      'name: "cast-email-assistant"',
      'repository:',
      '  remote: origin',
      "  url: 'https://github.com/box/old'",
      '  branch: main',
      'tools:',
      '  builtin:',
      '      - bash',
      '',
    ].join('\n')
    const repo = createAgentRepo(body)
    const restore = withCreateEnv({})
    try {
      await runCreate(repo)
      const raw = fs.readFileSync(repo.configPath, 'utf8')
      const url = `https://github.com/scott/${repo.agentName}`
      expect(raw).to.equal(body.replace("'https://github.com/box/old'", `'${url}'`))
      expect(raw).to.include('# keep')
      expect(raw).to.include('      - bash')
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('leaves agent.yaml unchanged when the GitHub owner cannot be determined', async () => {
    const body = 'name: bb-git\nrepository:\n  remote: origin\n  branch: main\n'
    const repo = createAgentRepo(body)
    const restore = withCreateEnv({GH_FAKE_REMOTE_STYLE: 'none', GH_FAKE_API_FAIL: '1'})
    const instance = createCommandInstance(['git', 'remote', repo.agentName, 'create', 'origin'])
    const {errors} = capture(instance)
    try {
      await instance.run()
      expect.fail('create should fail when the owner is unknown')
    } catch (error: any) {
      expect(error.message).to.include('Could not determine the GitHub repository URL')
      expect(error.message).to.include('repository.url was left unchanged')
      expect(errors.join('\n')).to.include('Could not determine the GitHub repository URL')
      expect(fs.readFileSync(repo.configPath, 'utf8')).to.equal(body)
      expect(fs.readFileSync(repo.configPath, 'utf8')).to.not.include('github.com/box')
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('does not rewrite agent.yaml when gh repo create fails', async () => {
    const repo = createAgentRepo(PRESERVED_YAML)
    const restore = withCreateEnv({GH_FAKE_CREATE_FAIL: '1'})
    const instance = createCommandInstance(['git', 'remote', repo.agentName, 'create', 'origin'])
    capture(instance)
    try {
      await instance.run()
      expect.fail('create should fail when gh exits non-zero')
    } catch (error: any) {
      expect(error.message).to.include('gh repo create failed with exit code 2')
      expect(fs.readFileSync(repo.configPath, 'utf8')).to.equal(PRESERVED_YAML)
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('passes --public through to gh', async () => {
    const repo = createAgentRepo('name: bb-git\nrepository:\n  remote: origin\n  branch: main\n')
    const logPath = path.join(binDir, 'gh-args.log')
    const restore = withCreateEnv({GH_FAKE_LOG: logPath})
    try {
      await runCreate(repo, 'public')
      const args = JSON.parse(fs.readFileSync(logPath, 'utf8').trim())
      expect(args).to.include('--public')
      expect(args).to.not.include('--private')
      expect(args).to.include('--remote')
      expect(args).to.include('origin')
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('clears the created repository.url when that remote is removed', async () => {
    const body = 'name: bb-git\nrepository:\n  remote: origin\n  branch: main\n'
    const repo = createAgentRepo(body)
    const restore = withCreateEnv({})
    try {
      await runCreate(repo)
      const created = `https://github.com/scott/${repo.agentName}`
      expect(yaml.parse(fs.readFileSync(repo.configPath, 'utf8')).repository.url).to.equal(created)

      const remove = createCommandInstance(['git', 'remote', repo.agentName, 'remove', 'origin'])
      capture(remove)
      await remove.run()

      const config = yaml.parse(fs.readFileSync(repo.configPath, 'utf8'))
      expect(config.repository.url).to.equal(undefined)
      expect(config.repository.remote).to.equal('origin')
      expect(config.repository.branch).to.equal('main')
    } finally {
      restore()
      removeAgent(repo)
    }
  })

  it('adds a remote URL without reformatting the rest of agent.yaml', async () => {
    const repo = createAgentRepo(PRESERVED_YAML)
    const url = 'https://github.com/scott/kept.git'
    const instance = createCommandInstance(['git', 'remote', repo.agentName, 'add', 'origin', url])
    capture(instance)
    try {
      await instance.run()
      const raw = fs.readFileSync(repo.configPath, 'utf8')
      expect(raw).to.equal(PRESERVED_YAML.replace(
        '  branch: main\n',
        `  branch: main\n  url: ${url}\n`,
      ))
    } finally {
      removeAgent(repo)
    }
  })
})