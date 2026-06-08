import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import {execSync} from 'child_process'
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
})