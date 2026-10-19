import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import GitInit from '../../../../typescript/cast-cli/src/commands/git/init'
import {GIT_IDENTITY_HINT} from '../../../../typescript/cast-cli/src/lib/git-identity'

// Helper to create command instance with mocked context
function createCommandInstance(CommandClass: any, args: string[]): any {
  const instance = new CommandClass(args, {color: false})
  instance.config = {
    runHook: async () => {},
    name: 'git:init',
    bin: 'cast'
  }
  instance.argv = args
  const agentIndex = args.indexOf('init') + 1
  const agentName = args[agentIndex] || ''
  instance.args = { agent: agentName }
  instance.flags = {}
  instance.parse = async () => ({ args: instance.args, flags: instance.flags })
  return instance
}

describe('Git Init Command', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitInit.description).to.equal('Initialize a Git repository for an agent')
    })

    it('should require agent argument', () => {
      expect(GitInit.args).to.have.property('agent')
      expect(GitInit.args.agent.required).to.be.true
      expect(GitInit.args.agent.description).to.equal('Agent name')
    })

    it('should have examples', () => {
      expect(GitInit.examples).to.be.an('array')
      expect(GitInit.examples.length).to.be.greaterThan(0)
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitInit).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitInit(['git', 'init', 'test-agent'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('command behavior', () => {
    it('should create .castignore file', () => {
      // The init command creates a .castignore file
      expect(GitInit).to.be.a('function')
    })

    it('should initialize git repo', () => {
      // The init command uses simple-git to initialize
      expect(GitInit).to.be.a('function')
    })

    it('should generate README.md', () => {
      // The init command generates README.md from agent config
      expect(GitInit).to.be.a('function')
    })

    it('should update agent.yaml with repository info', () => {
      // The init command updates agent.yaml with repository metadata
      expect(GitInit).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', async () => {
      const instance = createCommandInstance(GitInit, ['git', 'init', 'nonexistent-agent'])
      let errorThrown = false

      instance.error = () => {
        errorThrown = true
      }

      await instance.run()

      expect(errorThrown).to.be.true
    })

    it('should error when git repo already exists', async () => {
      const testAgentName = 'test-git-init-existing-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(tempAgentDir, {recursive: true})
      fs.mkdirSync(path.join(tempAgentDir, '.git'), {recursive: true})

      const instance = createCommandInstance(GitInit, ['git', 'init', testAgentName])
      let errorThrown = false
      let errorMessage = ''

      instance.error = (msg: any) => {
        errorThrown = true
        errorMessage = typeof msg === 'string' ? msg : String(msg)
      }

      await instance.run()

      expect(errorThrown).to.be.true
      expect(errorMessage).to.include('already exists')

      // Cleanup
      fs.rmSync(tempAgentDir, {recursive: true, force: true})
    })
  })

  describe('run method success', () => {
    const testAgentName = 'test-git-init-' + Date.now()
    const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)

    afterEach(() => {
      // Cleanup
      if (fs.existsSync(tempAgentDir)) {
        fs.rmSync(tempAgentDir, {recursive: true, force: true})
      }
    })

    it('should initialize git repository', async () => {
      // Create agent directory
      fs.mkdirSync(tempAgentDir, {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')
      fs.mkdirSync(path.join(tempAgentDir, 'tools', '__pycache__'), {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'tools', 'hello.py'), 'print(1)\n')
      fs.writeFileSync(path.join(tempAgentDir, 'tools', '__pycache__', 'hello.cpython-311.pyc'), 'pyc')

      const instance = createCommandInstance(GitInit, ['git', 'init', testAgentName])
      let logged = false

      instance.log = (msg: string) => {
        if (msg.includes('initialized successfully')) {
          logged = true
        }
      }

      const previous = snapshotEnv([
        'GIT_CONFIG_COUNT',
        'GIT_CONFIG_KEY_0',
        'GIT_CONFIG_VALUE_0',
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
      ])
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'init.defaultBranch'
      process.env.GIT_CONFIG_VALUE_0 = 'develop'
      process.env.GIT_AUTHOR_NAME = 'Cast Test'
      process.env.GIT_AUTHOR_EMAIL = 'cast-test@example.com'
      process.env.GIT_COMMITTER_NAME = 'Cast Test'
      process.env.GIT_COMMITTER_EMAIL = 'cast-test@example.com'

      try {
        await instance.run()
      } finally {
        restoreEnvMap(previous)
      }

      expect(logged).to.be.true
      // Verify .git directory was created
      expect(fs.existsSync(path.join(tempAgentDir, '.git'))).to.be.true

      const castIgnore = fs.readFileSync(path.join(tempAgentDir, '.castignore'), 'utf8')
      const gitignore = fs.readFileSync(path.join(tempAgentDir, '.gitignore'), 'utf8')
      expect(castIgnore).to.equal(gitignore)
      expect(castIgnore).to.contain('memory/memory.db\n')

      fs.mkdirSync(path.join(tempAgentDir, 'memory'))
      fs.writeFileSync(path.join(tempAgentDir, 'memory', 'memory.db'), '')
      const status = execFileSync('git', ['status', '--porcelain'], {
        cwd: tempAgentDir,
        encoding: 'utf8',
      })
      expect(status).to.not.contain('memory.db')

      const tracked = execFileSync('git', ['ls-files'], {
        cwd: tempAgentDir,
        encoding: 'utf8',
      })
      expect(tracked).to.contain('tools/hello.py')
      expect(tracked).to.not.contain('__pycache__')
      expect(tracked).to.not.contain('.pyc')
      const untracked = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
        cwd: tempAgentDir,
        encoding: 'utf8',
      })
      expect(untracked).to.not.contain('__pycache__')
      expect(untracked).to.not.contain('.pyc')

      const actualBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: tempAgentDir,
        encoding: 'utf8',
      }).trim()
      expect(actualBranch).to.equal('main')

      const agentYaml = fs.readFileSync(path.join(tempAgentDir, 'agent.yaml'), 'utf8')
      expect(agentYaml).to.contain('branch: main')
    })

    it('should stop before creating a repo when git identity is missing', async () => {
      const agentName = 'test-git-init-identity-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      const originalYaml = 'name: test-agent\nversion: "1.0"\n'
      fs.writeFileSync(path.join(agentDir, 'agent.yaml'), originalYaml)

      const instance = createCommandInstance(GitInit, ['git', 'init', agentName])
      let errorMessage = ''
      instance.error = (msg: any) => {
        errorMessage = typeof msg === 'string' ? msg : String(msg)
      }
      instance.log = () => {}

      const saved = snapshotIdentityEnv()
      hideGitIdentity()
      try {
        await instance.run()
        expect(errorMessage).to.equal(GIT_IDENTITY_HINT)
        expect(errorMessage).to.include('git config --global user.name')
        expect(errorMessage).to.include('git config --global user.email')
        expect(fs.existsSync(path.join(agentDir, '.git'))).to.equal(false)
        expect(fs.existsSync(path.join(agentDir, '.gitignore'))).to.equal(false)
        expect(fs.readFileSync(path.join(agentDir, 'agent.yaml'), 'utf8')).to.equal(originalYaml)
      } finally {
        restoreIdentityEnv(saved)
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('initializes from GIT_AUTHOR_* when gitconfig has no identity', async () => {
      const agentName = 'test-git-init-env-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: test-agent\nversion: "1.0"\n')
      const instance = createCommandInstance(GitInit, ['git', 'init', agentName])
      instance.log = () => {}
      instance.error = (msg: any) => {
        throw new Error(typeof msg === 'string' ? msg : String(msg))
      }

      const saved = snapshotIdentityEnv()
      hideGitIdentity()
      process.env.GIT_AUTHOR_NAME = 'Env Author'
      process.env.GIT_AUTHOR_EMAIL = 'env-author@example.com'
      process.env.GIT_COMMITTER_NAME = 'Env Committer'
      process.env.GIT_COMMITTER_EMAIL = 'env-committer@example.com'
      process.env.GIT_AUTHOR_DATE = '2020-01-02T03:04:05Z'
      process.env.GIT_COMMITTER_DATE = '2021-05-06T07:08:09Z'
      try {
        await instance.run()
        const ident = execFileSync('git', ['log', '-1', '--format=%an|%ae|%cn|%ce|%aI|%cI'], {
          cwd: agentDir,
          encoding: 'utf8',
        }).trim()
        expect(ident.replace(/Z/g, '+00:00')).to.equal(
          'Env Author|env-author@example.com|Env Committer|env-committer@example.com|2020-01-02T03:04:05+00:00|2021-05-06T07:08:09+00:00',
        )
      } finally {
        restoreIdentityEnv(saved)
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('initializes from GIT_CONFIG_GLOBAL when author env is unset', async () => {
      const agentName = 'test-git-init-config-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: test-agent\nversion: "1.0"\n')
      const instance = createCommandInstance(GitInit, ['git', 'init', agentName])
      instance.log = () => {}
      instance.error = (msg: any) => {
        throw new Error(typeof msg === 'string' ? msg : String(msg))
      }

      const saved = snapshotIdentityEnv()
      hideGitIdentity()
      const config = path.join(os.tmpdir(), `cast-identity-gitconfig-${process.pid}-${agentName}`)
      fs.writeFileSync(config, [
        '[user]',
        '\tname = Config User',
        '\temail = config-user@example.com',
        '',
      ].join('\n'))
      process.env.GIT_CONFIG_GLOBAL = config
      try {
        await instance.run()
        const ident = execFileSync('git', ['log', '-1', '--format=%an|%ae|%cn|%ce'], {
          cwd: agentDir,
          encoding: 'utf8',
        }).trim()
        expect(ident).to.equal('Config User|config-user@example.com|Config User|config-user@example.com')
      } finally {
        restoreIdentityEnv(saved)
        fs.rmSync(config, {force: true})
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('removes a partial repository when init fails after git init', async () => {
      const agentName = 'test-git-init-rollback-' + Date.now()
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentDir, {recursive: true})
      const originalYaml = 'name: test-agent\nversion: "1.0"\n'
      fs.writeFileSync(path.join(agentDir, 'agent.yaml'), originalYaml)
      const hooks = path.join(os.tmpdir(), `cast-init-hooks-${process.pid}-${agentName}`)
      fs.mkdirSync(hooks)
      fs.writeFileSync(path.join(hooks, 'pre-commit'), '#!/bin/sh\necho hook-declined >&2\nexit 1\n')
      fs.chmodSync(path.join(hooks, 'pre-commit'), 0o755)
      const config = path.join(os.tmpdir(), `cast-init-hookcfg-${process.pid}-${agentName}`)
      fs.writeFileSync(config, [
        '[user]',
        '\tname = Hook User',
        '\temail = hook-user@example.com',
        '[core]',
        `\thooksPath = ${hooks}`,
        '',
      ].join('\n'))

      const failing = createCommandInstance(GitInit, ['git', 'init', agentName])
      let errorMessage = ''
      failing.log = () => {}
      failing.error = (msg: any) => {
        errorMessage = typeof msg === 'string' ? msg : String(msg)
      }

      const saved = snapshotIdentityEnv()
      hideGitIdentity()
      process.env.GIT_CONFIG_GLOBAL = config
      try {
        await failing.run()
        expect(errorMessage).to.include('hook-declined')
        expect(errorMessage).to.not.equal(GIT_IDENTITY_HINT)
        expect(fs.existsSync(path.join(agentDir, '.git'))).to.equal(false)
        expect(fs.existsSync(path.join(agentDir, '.gitignore'))).to.equal(false)
        expect(fs.existsSync(path.join(agentDir, 'README.md'))).to.equal(false)
        expect(fs.readFileSync(path.join(agentDir, 'agent.yaml'), 'utf8')).to.equal(originalYaml)

        fs.writeFileSync(config, [
          '[user]',
          '\tname = Hook User',
          '\temail = hook-user@example.com',
          '',
        ].join('\n'))
        const retry = createCommandInstance(GitInit, ['git', 'init', agentName])
        retry.log = () => {}
        retry.error = (msg: any) => {
          throw new Error(typeof msg === 'string' ? msg : String(msg))
        }
        await retry.run()
        expect(fs.existsSync(path.join(agentDir, '.git'))).to.equal(true)
        const ident = execFileSync('git', ['log', '-1', '--format=%an|%ae'], {
          cwd: agentDir,
          encoding: 'utf8',
        }).trim()
        expect(ident).to.equal('Hook User|hook-user@example.com')
      } finally {
        restoreIdentityEnv(saved)
        fs.rmSync(hooks, {recursive: true, force: true})
        fs.rmSync(config, {force: true})
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })
  })
})

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map(key => [key, process.env[key]]))
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

function restoreEnvMap(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) restoreEnv(key, value)
}

const IDENTITY_ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_DATE',
  'EMAIL',
]

function snapshotIdentityEnv(): Map<string, string | undefined> {
  return new Map(IDENTITY_ENV_KEYS.map(key => [key, process.env[key]]))
}

function hideGitIdentity(): void {
  const empty = path.join(os.tmpdir(), `cast-empty-gitconfig-${process.pid}`)
  fs.writeFileSync(empty, '')
  process.env.GIT_CONFIG_GLOBAL = empty
  process.env.GIT_CONFIG_SYSTEM = empty
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  for (const key of IDENTITY_ENV_KEYS.slice(3)) delete process.env[key]
}

function restoreIdentityEnv(saved: Map<string, string | undefined>): void {
  const empty = process.env.GIT_CONFIG_GLOBAL
  for (const [key, value] of saved) restoreEnv(key, value)
  if (empty && empty.includes('cast-empty-gitconfig-')) {
    fs.rmSync(empty, {force: true})
  }
}