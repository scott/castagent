import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import GitPush from '../../../../typescript/cast-cli/src/commands/git/push'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'init.defaultBranch',
      GIT_CONFIG_VALUE_0: 'master',
    },
  })
}

function remoteHasRef(bareDir: string, branch: string): boolean {
  try {
    execFileSync('git', ['--git-dir', bareDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], {stdio: 'ignore'})
    return true
  } catch {
    return false
  }
}

function shortHead(repoDir: string, branch = 'HEAD'): string {
  return git(repoDir, ['rev-parse', '--short=7', branch]).trim()
}

interface RepoOptions {
  branch?: string
  yamlBranch?: string
  commit?: boolean
}

interface RepoContext {
  agentName: string
  agentDir: string
  bareDir: string
}

function createAgentRepo(options: RepoOptions = {}): RepoContext {
  const branch = options.branch ?? 'master'
  const agentName = `test-push-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
  const bareDir = path.join(os.tmpdir(), `${agentName}.git`)
  const yamlBranch = options.yamlBranch ?? 'main'

  fs.mkdirSync(agentDir, {recursive: true})
  fs.writeFileSync(path.join(agentDir, 'agent.yaml'), [
    'name: test-agent',
    'repository:',
    '  remote: origin',
    `  branch: ${yamlBranch}`,
    '',
  ].join('\n'))

  git(agentDir, ['init', '-b', branch])
  git(agentDir, ['config', 'user.email', 'test@test.com'])
  git(agentDir, ['config', 'user.name', 'Test'])

  if (options.commit !== false) {
    fs.writeFileSync(path.join(agentDir, 'test.txt'), 'test\n')
    git(agentDir, ['add', '.'])
    git(agentDir, ['commit', '-m', 'test'])
  }

  git(agentDir, ['init', '--bare', bareDir])
  git(agentDir, ['remote', 'add', 'origin', bareDir])

  return {agentName, agentDir, bareDir}
}

function removeRepo(ctx: RepoContext): void {
  fs.rmSync(ctx.agentDir, {recursive: true, force: true})
  fs.rmSync(ctx.bareDir, {recursive: true, force: true})
}

function createCommandInstance(args: string[], flags: {remote?: string; branch?: string} = {}): any {
  const instance: any = new GitPush(args, {color: false} as any)
  instance.config = {
    runHook: async () => {},
    name: 'git:push',
    bin: 'cast',
  }
  const agentIndex = args.indexOf('push') + 1
  const agentName = args[agentIndex] || ''
  instance.args = {agent: agentName}
  instance.flags = {
    remote: flags.remote ?? 'origin',
    branch: flags.branch,
  }
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

describe('Git Push Command', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitPush.description).to.equal('Push commits to the remote repository')
    })

    it('should require agent argument', () => {
      expect(GitPush.args).to.have.property('agent')
      expect(GitPush.args.agent.required).to.be.true
      expect(GitPush.args.agent.description).to.equal('Agent name')
    })

    it('should have --remote flag with default origin', () => {
      expect(GitPush.flags).to.have.property('remote')
      expect(GitPush.flags.remote.default).to.equal('origin')
    })

    it('should have --branch flag that defaults to the current branch', () => {
      expect(GitPush.flags).to.have.property('branch')
      expect(GitPush.flags.branch.default).to.equal(undefined)
      expect(GitPush.flags.branch.description).to.include('current branch')
    })

    it('should have examples', () => {
      expect(GitPush.examples).to.be.an('array')
      expect(GitPush.examples.length).to.be.greaterThan(0)
      expect(GitPush.examples.join('\n')).to.not.include('origin main')
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitPush).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitPush(['git', 'push', 'test-agent'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('error handling', () => {
    it('should error when agent does not exist', async () => {
      const instance = createCommandInstance(['git', 'push', 'nonexistent-agent'])
      const {errors} = capture(instance)

      try {
        await instance.run()
      } catch {
        // expected
      }

      expect(errors.join('\n')).to.include('not found')
    })

    it('should error when not a git repo', async () => {
      const agentName = 'test-push-no-git-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(tempAgentDir, {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent')

      const instance = createCommandInstance(['git', 'push', agentName])
      const {errors} = capture(instance)

      try {
        await instance.run()
      } catch {
        // expected
      }

      expect(errors.join('\n')).to.include('not a Git repository')
      fs.rmSync(tempAgentDir, {recursive: true, force: true})
    })

    it('should error when remote does not exist', async () => {
      const ctx = createAgentRepo()
      git(ctx.agentDir, ['remote', 'remove', 'origin'])
      const instance = createCommandInstance(['git', 'push', ctx.agentName])
      const {errors} = capture(instance)

      try {
        await instance.run()
      } catch {
        // expected
      } finally {
        removeRepo(ctx)
      }

      expect(errors.join('\n')).to.include('does not exist')
    })
  })

  describe('default branch', () => {
    it('pushes the checked-out branch when --branch is omitted', async () => {
      const ctx = createAgentRepo({branch: 'master', yamlBranch: 'main'})
      const instance = createCommandInstance(['git', 'push', ctx.agentName])
      const {logs} = capture(instance)

      try {
        await instance.run()
        const output = logs.join('\n')
        expect(output).to.include('Pushing to origin/master')
        expect(output).to.not.include('origin/main')
        expect(output).to.not.include('unknown')
        expect(output).to.include(shortHead(ctx.agentDir))
        expect(remoteHasRef(ctx.bareDir, 'master')).to.equal(true)
        expect(remoteHasRef(ctx.bareDir, 'main')).to.equal(false)
      } finally {
        removeRepo(ctx)
      }
    })

    it('pushes main when main is the current branch', async () => {
      const ctx = createAgentRepo({branch: 'main', yamlBranch: 'main'})
      const instance = createCommandInstance(['git', 'push', ctx.agentName])
      const {logs} = capture(instance)

      try {
        await instance.run()
        expect(logs.join('\n')).to.include('Pushing to origin/main')
        expect(logs.join('\n')).to.include(shortHead(ctx.agentDir))
        expect(remoteHasRef(ctx.bareDir, 'main')).to.equal(true)
      } finally {
        removeRepo(ctx)
      }
    })

    it('pushes a feature branch that is currently checked out', async () => {
      const ctx = createAgentRepo({branch: 'master'})
      git(ctx.agentDir, ['checkout', '-b', 'feature/widget'])
      fs.writeFileSync(path.join(ctx.agentDir, 'feature.txt'), 'feature\n')
      git(ctx.agentDir, ['add', 'feature.txt'])
      git(ctx.agentDir, ['commit', '-m', 'feature'])

      const instance = createCommandInstance(['git', 'push', ctx.agentName])
      const {logs} = capture(instance)

      try {
        await instance.run()
        expect(logs.join('\n')).to.include('Pushing to origin/feature/widget')
        expect(logs.join('\n')).to.include(shortHead(ctx.agentDir))
        expect(remoteHasRef(ctx.bareDir, 'feature/widget')).to.equal(true)
        expect(remoteHasRef(ctx.bareDir, 'master')).to.equal(false)
        expect(remoteHasRef(ctx.bareDir, 'main')).to.equal(false)
      } finally {
        removeRepo(ctx)
      }
    })

    it('pushes the branch named by --branch', async () => {
      const ctx = createAgentRepo({branch: 'master'})
      git(ctx.agentDir, ['checkout', '-b', 'feature/widget'])

      const instance = createCommandInstance(['git', 'push', ctx.agentName], {branch: 'master'})
      const {logs} = capture(instance)

      try {
        await instance.run()
        const output = logs.join('\n')
        expect(output).to.include('Pushing to origin/master')
        expect(output).to.not.include('unknown')
        expect(output).to.include(shortHead(ctx.agentDir, 'master'))
        expect(remoteHasRef(ctx.bareDir, 'master')).to.equal(true)
        expect(remoteHasRef(ctx.bareDir, 'feature/widget')).to.equal(false)
      } finally {
        removeRepo(ctx)
      }
    })

    it('fails when --branch names a branch that does not exist', async () => {
      const ctx = createAgentRepo({branch: 'master'})
      const instance = createCommandInstance(['git', 'push', ctx.agentName], {branch: 'main'})
      const {errors} = capture(instance)

      try {
        await instance.run()
        expect.fail('expected push of a missing branch to fail')
      } catch (error: any) {
        expect(String(error.message)).to.match(/refspec main|does not match any/)
        expect(errors.join('\n')).to.match(/main/)
        expect(remoteHasRef(ctx.bareDir, 'main')).to.equal(false)
        expect(remoteHasRef(ctx.bareDir, 'master')).to.equal(false)
      } finally {
        removeRepo(ctx)
      }
    })

    it('reports a later commit instead of an unknown hash', async () => {
      const ctx = createAgentRepo({branch: 'master'})
      const first = createCommandInstance(['git', 'push', ctx.agentName])
      capture(first)
      await first.run()

      fs.writeFileSync(path.join(ctx.agentDir, 'test.txt'), 'updated\n')
      git(ctx.agentDir, ['add', 'test.txt'])
      git(ctx.agentDir, ['commit', '-m', 'second'])
      const head = shortHead(ctx.agentDir)

      const second = createCommandInstance(['git', 'push', ctx.agentName])
      const {logs} = capture(second)

      try {
        await second.run()
        const output = logs.join('\n')
        expect(output).to.include('Pushing to origin/master')
        expect(output).to.include(head)
        expect(output).to.not.include('unknown')
        expect(git(ctx.bareDir, ['rev-parse', '--short=7', 'master']).trim()).to.equal(head)
      } finally {
        removeRepo(ctx)
      }
    })

    it('reports when the current branch is already up to date', async () => {
      const ctx = createAgentRepo({branch: 'master'})
      const first = createCommandInstance(['git', 'push', ctx.agentName])
      capture(first)
      await first.run()

      const second = createCommandInstance(['git', 'push', ctx.agentName])
      const {logs} = capture(second)

      try {
        await second.run()
        const output = logs.join('\n')
        expect(output).to.include('Pushing to origin/master')
        expect(output).to.include('Everything up-to-date at origin/master')
        expect(output).to.not.include('unknown')
      } finally {
        removeRepo(ctx)
      }
    })

    it('does not push when HEAD is detached', async () => {
      const ctx = createAgentRepo({branch: 'master'})
      git(ctx.agentDir, ['checkout', '--detach'])
      const instance = createCommandInstance(['git', 'push', ctx.agentName])
      const {logs, errors} = capture(instance)

      try {
        await instance.run()
        expect.fail('expected a detached HEAD to fail')
      } catch (error: any) {
        expect(String(error.message)).to.include('detached')
        expect(errors.join('\n')).to.include('detached')
        expect(errors.join('\n')).to.not.include('main')
        expect(logs.join('\n')).to.not.include('Pushing to')
        expect(remoteHasRef(ctx.bareDir, 'master')).to.equal(false)
        expect(remoteHasRef(ctx.bareDir, 'main')).to.equal(false)
      } finally {
        removeRepo(ctx)
      }
    })
  })
})
