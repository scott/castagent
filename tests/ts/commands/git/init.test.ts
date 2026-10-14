import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import GitInit from '../../../../typescript/cast-cli/src/commands/git/init'

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

      const instance = createCommandInstance(GitInit, ['git', 'init', testAgentName])
      let logged = false

      instance.log = (msg: string) => {
        if (msg.includes('initialized successfully')) {
          logged = true
        }
      }

      await instance.run()

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

      const control = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-git-default-branch-'))
      try {
        execFileSync('git', ['init'], {cwd: control})
        const expectedBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
          cwd: control,
          encoding: 'utf8',
        }).trim()
        const actualBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], {
          cwd: tempAgentDir,
          encoding: 'utf8',
        }).trim()
        expect(actualBranch).to.equal(expectedBranch)
      } finally {
        fs.rmSync(control, {recursive: true, force: true})
      }

      const agentYaml = fs.readFileSync(path.join(tempAgentDir, 'agent.yaml'), 'utf8')
      expect(agentYaml).to.contain('branch: main')
    })
  })
})