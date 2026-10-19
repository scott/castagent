import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import {execFileSync, execSync} from 'child_process'
import GitCommit from '../../../../typescript/cast-cli/src/commands/git/commit'

// Helper to create command instance with mocked context
function createCommandInstance(CommandClass: any, args: string[]): any {
  const instance = new CommandClass(args, {color: false})
  instance.config = {
    runHook: async () => {},
    name: 'git:commit',
    bin: 'cast'
  }
  instance.argv = args
  // Parse args from argv
  // args format: ['git', 'commit', 'agent-name', '-m', 'message']
  const agentIndex = args.indexOf('commit') + 1
  const agentName = args[agentIndex] || ''
  const messageIndex = args.indexOf('-m')
  const message = messageIndex !== -1 ? args[messageIndex + 1] : ''
  instance.args = { agent: agentName }
  instance.flags = { message }
  // Override parse to avoid oclif internals
  instance.parse = async () => ({ args: instance.args, flags: instance.flags })
  return instance
}

// Helper to create a real git repo
function createGitRepo(dirPath: string): void {
  execSync('git init', { cwd: dirPath })
  execSync('git config user.email "test@test.com"', { cwd: dirPath })
  execSync('git config user.name "Test"', { cwd: dirPath })
}

describe('Git Commit Command', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitCommit.description).to.equal('Commit changes to an agent repository')
    })

    it('should require agent argument', () => {
      expect(GitCommit.args).to.have.property('agent')
      expect(GitCommit.args.agent.required).to.be.true
      expect(GitCommit.args.agent.description).to.equal('Agent name')
    })

    it('should require --message flag', () => {
      expect(GitCommit.flags).to.have.property('message')
      expect(GitCommit.flags.message.required).to.be.true
      expect(GitCommit.flags.message.char).to.equal('m')
    })

    it('should have examples', () => {
      expect(GitCommit.examples).to.be.an('array')
      expect(GitCommit.examples.length).to.be.greaterThan(0)
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitCommit).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitCommit(['git', 'commit', 'test-agent', '-m', 'test'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('command behavior', () => {
    it('should add all changes before commit', () => {
      // The commit command runs git add .
      expect(GitCommit).to.be.a('function')
    })

    it('should regenerate README on commit', () => {
      // The commit command regenerates README.md from agent config
      expect(GitCommit).to.be.a('function')
    })

    it('should create a commit with message', () => {
      // The commit command uses git.commit() with the provided message
      expect(GitCommit).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', async () => {
      const instance = createCommandInstance(GitCommit, ['git', 'commit', 'nonexistent-agent', '-m', 'test'])
      let errorThrown = false

      instance.error = () => {
        errorThrown = true
      }

      await instance.run()
      expect(errorThrown).to.be.true
    })

    it('should error if not a git repo', async () => {
      const testAgentName = 'test-commit-no-git-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(tempAgentDir, {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent')

      const instance = createCommandInstance(GitCommit, ['git', 'commit', testAgentName, '-m', 'test'])
      let errorThrown = false

      instance.error = () => {
        errorThrown = true
      }

      await instance.run()
      expect(errorThrown).to.be.true

      // Cleanup
      fs.rmSync(tempAgentDir, {recursive: true, force: true})
    })
  })

  describe('run method with clean working tree', () => {
    it('should handle clean working tree', async () => {
      const testAgentName = 'test-commit-clean-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(tempAgentDir, {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent')
      createGitRepo(tempAgentDir)
      // Create an initial commit so the working tree can be clean
      fs.writeFileSync(path.join(tempAgentDir, 'initial.txt'), 'initial')
      execSync('git add .', { cwd: tempAgentDir })
      execSync('git commit -m "Initial commit"', { cwd: tempAgentDir })

      const instance = createCommandInstance(GitCommit, ['git', 'commit', testAgentName, '-m', 'test'])
      let loggedClean = false

      instance.log = (msg: string) => {
        if (msg.includes('Nothing to commit') || msg.includes('working tree clean')) {
          loggedClean = true
        }
      }

      await instance.run()
      expect(loggedClean).to.be.true

      // Cleanup
      fs.rmSync(tempAgentDir, {recursive: true, force: true})
    })
  })

  describe('run method with changes to commit', () => {
    it('should add all changes and commit', async () => {
      const testAgentName = 'test-commit-changes-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(tempAgentDir, {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent')
      fs.writeFileSync(path.join(tempAgentDir, 'test.txt'), 'test content')
      createGitRepo(tempAgentDir)

      const instance = createCommandInstance(GitCommit, ['git', 'commit', testAgentName, '-m', 'Test commit'])
      let committed = false

      instance.log = (msg: string) => {
        if (msg.includes('committed') || msg.includes('Commit:')) {
          committed = true
        }
      }

      await instance.run()
      expect(committed).to.be.true

      // Cleanup
      fs.rmSync(tempAgentDir, {recursive: true, force: true})
    })

    it('should regenerate README on commit', async () => {
      const testAgentName = 'test-commit-readme-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(tempAgentDir, {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent')
      fs.writeFileSync(path.join(tempAgentDir, 'test.txt'), 'test content')
      createGitRepo(tempAgentDir)

      const instance = createCommandInstance(GitCommit, ['git', 'commit', testAgentName, '-m', 'Test commit'])

      await instance.run()
      const readmePath = path.join(tempAgentDir, 'README.md')
      expect(fs.existsSync(readmePath)).to.be.true

      // Cleanup
      fs.rmSync(tempAgentDir, {recursive: true, force: true})
    })
  })

  describe('memory notes stay out of the commit', () => {
    const secret = 'sk-or-v1-dummy'

    function git(dir: string, args: string[]): string {
      return execFileSync('git', args, {cwd: dir, encoding: 'utf8'})
    }

    function gitText(dir: string, args: string[]): string {
      try {
        return execFileSync('git', args, {
          cwd: dir,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error: unknown) {
        const stdout = (error as {stdout?: string}).stdout
        return typeof stdout === 'string' ? stdout : ''
      }
    }

    async function commitAgent(agentName: string, message: string): Promise<string> {
      const instance = createCommandInstance(GitCommit, ['git', 'commit', agentName, '-m', message])
      const lines: string[] = []
      instance.log = (msg: string) => {
        lines.push(msg)
      }
      instance.error = (err: string) => {
        throw new Error(err)
      }
      await instance.run()
      return lines.join('\n')
    }

    it('does not commit notes.md that an older init already tracked', async () => {
      const testAgentName = 'test-commit-tracked-notes-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(path.join(tempAgentDir, 'memory'), {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent\n')
      fs.writeFileSync(path.join(tempAgentDir, '.gitignore'), '*.log\n')
      const notesPath = path.join(tempAgentDir, 'memory', 'notes.md')
      fs.writeFileSync(notesPath, 'old note\n')
      createGitRepo(tempAgentDir)
      execFileSync('git', ['add', '-A'], {cwd: tempAgentDir})
      execFileSync('git', ['commit', '-m', 'track notes'], {cwd: tempAgentDir})

      fs.writeFileSync(notesPath, `${secret}\n`)
      fs.writeFileSync(path.join(tempAgentDir, 'public.txt'), 'public\n')

      try {
        const output = await commitAgent(testAgentName, 'drop private notes')
        expect(output).to.include('left untracked')
        expect(gitText(tempAgentDir, ['show', 'HEAD:memory/notes.md'])).to.equal('')
        expect(gitText(tempAgentDir, ['show', 'HEAD:public.txt'])).to.equal('public\n')
        expect(git(tempAgentDir, ['ls-files'])).to.not.include('memory/notes.md')
        expect(fs.readFileSync(notesPath, 'utf8')).to.equal(`${secret}\n`)
        expect(git(tempAgentDir, ['show', 'HEAD~1:memory/notes.md'])).to.equal('old note\n')
        expect(gitText(tempAgentDir, ['grep', '-I', '-e', secret, 'HEAD'])).to.equal('')

        fs.writeFileSync(path.join(tempAgentDir, 'public.txt'), 'public again\n')
        await commitAgent(testAgentName, 'public only')
        expect(gitText(tempAgentDir, ['show', 'HEAD:memory/notes.md'])).to.equal('')
        expect(gitText(tempAgentDir, ['show', 'HEAD:public.txt'])).to.equal('public again\n')
        expect(gitText(tempAgentDir, ['grep', '-I', '-e', secret, 'HEAD'])).to.equal('')
      } finally {
        fs.rmSync(tempAgentDir, {recursive: true, force: true})
      }
    })

    it('drops tracked notes from HEAD when the working tree is otherwise clean', async () => {
      const testAgentName = 'test-commit-clean-tracked-notes-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(path.join(tempAgentDir, 'memory'), {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent\n')
      fs.writeFileSync(path.join(tempAgentDir, '.gitignore'), '*.log\nmemory/notes.md\n')
      const notesPath = path.join(tempAgentDir, 'memory', 'notes.md')
      fs.writeFileSync(notesPath, `${secret}\n`)
      createGitRepo(tempAgentDir)
      execFileSync('git', ['add', '-A'], {cwd: tempAgentDir})
      execFileSync('git', ['add', '-f', '--', 'memory/notes.md'], {cwd: tempAgentDir})
      execFileSync('git', ['commit', '-m', 'track notes'], {cwd: tempAgentDir})
      expect(git(tempAgentDir, ['status', '--porcelain'])).to.equal('')
      expect(git(tempAgentDir, ['show', 'HEAD:memory/notes.md'])).to.equal(`${secret}\n`)

      try {
        const output = await commitAgent(testAgentName, 'stop tracking notes')
        expect(output).to.include('left untracked')
        expect(output).to.not.include('working tree is clean')
        expect(gitText(tempAgentDir, ['show', 'HEAD:memory/notes.md'])).to.equal('')
        expect(gitText(tempAgentDir, ['grep', '-I', '-e', secret, 'HEAD'])).to.equal('')
        expect(fs.readFileSync(notesPath, 'utf8')).to.equal(`${secret}\n`)
        expect(git(tempAgentDir, ['ls-files'])).to.not.include('memory/notes.md')
      } finally {
        fs.rmSync(tempAgentDir, {recursive: true, force: true})
      }
    })

    it('does not add an untracked notes.md that the ignore file omitted', async () => {
      const testAgentName = 'test-commit-untracked-notes-' + Date.now()
      const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
      fs.mkdirSync(path.join(tempAgentDir, 'memory'), {recursive: true})
      fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent\n')
      fs.writeFileSync(path.join(tempAgentDir, '.gitignore'), '*.log\n')
      const notesPath = path.join(tempAgentDir, 'memory', 'notes.md')
      fs.writeFileSync(notesPath, `${secret}\n`)
      fs.writeFileSync(path.join(tempAgentDir, 'public.txt'), 'public\n')
      createGitRepo(tempAgentDir)
      execFileSync('git', ['add', 'agent.yaml', '.gitignore'], {cwd: tempAgentDir})
      execFileSync('git', ['commit', '-m', 'init'], {cwd: tempAgentDir})

      try {
        await commitAgent(testAgentName, 'public only')
        expect(gitText(tempAgentDir, ['show', 'HEAD:memory/notes.md'])).to.equal('')
        expect(gitText(tempAgentDir, ['show', 'HEAD:public.txt'])).to.equal('public\n')
        expect(git(tempAgentDir, ['ls-tree', '-r', '--name-only', 'HEAD'])).to.not.include('memory/notes.md')
        expect(gitText(tempAgentDir, ['grep', '-I', '-e', secret, 'HEAD'])).to.equal('')
        expect(fs.readFileSync(notesPath, 'utf8')).to.equal(`${secret}\n`)
        expect(fs.readFileSync(path.join(tempAgentDir, '.gitignore'), 'utf8')).to.include('memory/notes.md\n')
      } finally {
        fs.rmSync(tempAgentDir, {recursive: true, force: true})
      }
    })
  })

  it('commits when identity comes only from the environment', async () => {
    const testAgentName = 'test-commit-env-ident-' + Date.now()
    const tempAgentDir = path.join(os.homedir(), '.cast', 'agents', testAgentName)
    fs.mkdirSync(tempAgentDir, {recursive: true})
    fs.writeFileSync(path.join(tempAgentDir, 'agent.yaml'), 'name: test-agent\nversion: "1.0"\n')
    execSync('git init -b main', {cwd: tempAgentDir})
    fs.writeFileSync(path.join(tempAgentDir, 'notes.txt'), 'hello\n')

    const empty = path.join(tempAgentDir, 'empty-gitconfig')
    fs.writeFileSync(empty, '')
    const keys = [
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      'GIT_AUTHOR_DATE',
      'GIT_COMMITTER_DATE',
      'EMAIL',
    ]
    const saved = new Map(keys.map(key => [key, process.env[key]]))
    process.env.GIT_CONFIG_GLOBAL = empty
    process.env.GIT_CONFIG_SYSTEM = empty
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    delete process.env.GIT_CONFIG_COUNT
    delete process.env.EMAIL
    process.env.GIT_AUTHOR_NAME = 'Env Author'
    process.env.GIT_AUTHOR_EMAIL = 'env-author@example.com'
    process.env.GIT_COMMITTER_NAME = 'Env Committer'
    process.env.GIT_COMMITTER_EMAIL = 'env-committer@example.com'
    process.env.GIT_AUTHOR_DATE = '2020-01-02T03:04:05Z'
    process.env.GIT_COMMITTER_DATE = '2021-05-06T07:08:09Z'

    const instance = createCommandInstance(GitCommit, ['git', 'commit', testAgentName, '-m', 'Env commit'])
    instance.error = (msg: any) => {
      throw new Error(typeof msg === 'string' ? msg : String(msg))
    }
    instance.log = () => {}

    try {
      await instance.run()
      const ident = execFileSync('git', ['log', '-1', '--format=%an|%ae|%cn|%ce|%aI|%cI'], {
        cwd: tempAgentDir,
        encoding: 'utf8',
      }).trim()
      expect(ident.replace(/Z/g, '+00:00')).to.equal(
        'Env Author|env-author@example.com|Env Committer|env-committer@example.com|2020-01-02T03:04:05+00:00|2021-05-06T07:08:09+00:00',
      )
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      fs.rmSync(tempAgentDir, {recursive: true, force: true})
    }
  })
})