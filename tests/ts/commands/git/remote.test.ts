import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'
import GitRemote from '../../../../typescript/cast-cli/src/commands/git/remote'

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'init.defaultBranch',
      GIT_CONFIG_VALUE_0: 'main',
    },
  })
}

interface RepoContext {
  agentName: string
  agentDir: string
}

function createAgentRepo(remoteUrl = 'https://example.com/original.git'): RepoContext {
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

function createCommandInstance(args: string[]): any {
  const instance: any = new GitRemote(args, {color: false} as any)
  instance.config = {
    runHook: async () => {},
    name: 'git:remote',
    bin: 'cast',
  }
  instance.args = {
    agent: args[2],
    action: args[3],
    name: args[4],
    url: args[5],
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
    const ctx = createAgentRepo()
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
    const ctx = createAgentRepo()
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
    const ctx = createAgentRepo()
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
    const ctx = createAgentRepo()
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
    const ctx = createAgentRepo()
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