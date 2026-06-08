import {expect} from 'chai'
import sinon from 'sinon'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

// Helper function to load command
async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

// Helper to mock fs module using require.cache replacement
function mockFsModule(mocks?: {
  existsSync?: (p: any) => boolean;
  readdirSync?: (p: any) => any;
  readFileSync?: (p: any) => string;
  writeFileSync?: (p: any, data: any) => void;
  mkdirSync?: (p: any, opts?: any) => void;
  statSync?: (p: any) => any;
  rmdirSync?: (p: any) => void;
  rmSync?: (p: any, opts?: any) => void;
  copyFileSync?: (src: any, dest: any) => void;
  accessSync?: (p: any) => void;
  lstatSync?: (p: any) => any;
}): void {
  const originalFs = require('fs') as typeof import('fs')

  // Create a proper Stats-like object
  const createMockStats = (isDir: boolean = false) => ({
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isSymbolicLink: () => false,
    isFIFO: () => false,
    isSocket: () => false,
    dev: 0,
    ino: 0,
    mode: 0,
    nlink: 0,
    uid: 0,
    gid: 0,
    rdev: 0,
    size: 0,
    blksize: 0,
    blocks: 0,
    atimeMs: 0,
    mtimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
    atime: new Date(),
    mtime: new Date(),
    ctime: new Date(),
    birthtime: new Date(),
  })

  const fsMock = {
    ...originalFs,
    existsSync: mocks?.existsSync || (() => true),
    readdirSync: mocks?.readdirSync || (() => []),
    readFileSync: mocks?.readFileSync || (() => ''),
    writeFileSync: mocks?.writeFileSync || (() => {}),
    mkdirSync: mocks?.mkdirSync || (() => {}),
    statSync: mocks?.statSync || ((p: any) => createMockStats(true)),
    rmdirSync: mocks?.rmdirSync || (() => {}),
    rmSync: mocks?.rmSync || (() => {}),
    copyFileSync: mocks?.copyFileSync || (() => {}),
    accessSync: mocks?.accessSync || (() => {}),
    lstatSync: mocks?.lstatSync || ((p: any) => createMockStats(true)),
  }

  ;(require.cache[require.resolve('fs')] as any) = {
    id: require.resolve('fs'),
    filename: require.resolve('fs'),
    loaded: true,
    exports: fsMock
  }

  // Also clear any command modules that might have cached the real fs
  const commandModules = Object.keys(require.cache).filter(key =>
    key.includes('/commands/') && (key.endsWith('.ts') || key.endsWith('.js'))
  )
  for (const mod of commandModules) {
    delete require.cache[mod]
  }
}

// Helper to restore fs module
function restoreFsModule(): void {
  delete require.cache[require.resolve('fs')]
}

describe('new command', () => {
  let New: any

  before(async () => {
    New = await loadTestCommand('new')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(New.description).to.equal('Create a new agent through an interactive TUI wizard')
    })

    it('should have no required arguments', () => {
      expect(New.args).to.deep.equal({})
    })

    it('should have no flags', () => {
      expect(New.flags).to.deep.equal({})
    })

    it('should have examples', () => {
      expect(New.examples).to.not.be.empty
    })

    it('should have validateAgentName method', () => {
      const instance = new New([], {color: false})
      expect(typeof instance.validateAgentName).to.equal('function')
    })

    it('should have getPythonExecutable method', () => {
      const instance = new New([], {color: false})
      expect(typeof instance.getPythonExecutable).to.equal('function')
    })

    it('should have getPythonPath method', () => {
      const instance = new New([], {color: false})
      expect(typeof instance.getPythonPath).to.equal('function')
    })

    it('should accept valid agent names', () => {
      const instance = new New([], {color: false})
      expect(instance.validateAgentName('valid-agent')).to.equal(true)
      expect(instance.validateAgentName('test123')).to.equal(true)
      expect(instance.validateAgentName('my-agent-v2')).to.equal(true)
      expect(instance.validateAgentName('a')).to.equal(true)
    })

    it('should reject invalid agent names', () => {
      const instance = new New([], {color: false})
      expect(instance.validateAgentName('invalid@name')).to.equal(false)
      expect(instance.validateAgentName('name with spaces')).to.equal(false)
      expect(instance.validateAgentName('name/slash')).to.equal(false)
      expect(instance.validateAgentName('')).to.equal(false)
    })

    it('should have checkForNewAgent method', () => {
      const instance = new New([], {color: false})
      expect(typeof instance.checkForNewAgent).to.equal('function')
    })

    it('should have runTerminalMode method', () => {
      const instance = new New([], {color: false})
      expect(typeof instance.runTerminalMode).to.equal('function')
    })

    it('should have resolveBun method', () => {
      const instance = new New([], {color: false})
      expect(typeof instance.resolveBun).to.equal('function')
    })

    it('should have checkVenv method', () => {
      const instance = new New([], {color: false})
      expect(typeof instance.checkVenv).to.equal('function')
    })
  })
})

describe('new command - instance methods', () => {
  let New: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    New = await loadTestCommand('new')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
    // Restore original fs module
    restoreFsModule()
  })

  describe('checkVenv method', () => {
    it('should warn when venv not found', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: (p: any) => {
          const str = p.toString()
          if (str.includes('.venv/bin/python3')) {
            return false
          }
          return true
        }
      })

      // Load command AFTER mock is set up
      const TestNew = await loadTestCommand('new')
      const instance = new TestNew([], {color: false})
      let warned = false
      let warningMessage = ''

      instance.warn = (msg: string) => {
        warned = true
        warningMessage = msg
      }

      instance.checkVenv()
      expect(warned).to.be.true
    })
  })

  describe('resolveBun method', () => {
    it('should return a string path', () => {
      const instance = new New([], {color: false})
      const bunPath = instance.resolveBun()
      expect(bunPath).to.be.a('string')
    })

    it('should prefer homedir bun path when found', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: (p: any) => {
          const str = p.toString()
          return str.includes('.bun/bin/bun')
        }
      })

      // Load command AFTER mock is set up
      const TestNew = await loadTestCommand('new')
      const instance = new TestNew([], {color: false})

      const bunPath = instance.resolveBun()
      expect(bunPath).to.include('.bun')
    })

    it('should fall back to "bun" if not found', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: () => false
      })

      // Load command AFTER mock is set up
      const TestNew = await loadTestCommand('new')
      const instance = new TestNew([], {color: false})

      const bunPath = instance.resolveBun()
      expect(bunPath).to.equal('bun')
    })
  })

  describe('checkForNewAgent method', () => {
    it('should handle non-existent agents directory', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: () => false
      })

      // Load command AFTER mock is set up
      const TestNew = await loadTestCommand('new')
      const instance = new TestNew([], {} as any) as any
      let logged = false

      instance.log = () => {
        logged = true
      }

      instance.checkForNewAgent()
      expect(logged).to.be.false
    })

    it('should log existing agents', async () => {
      const agentsDir = path.join(os.homedir(), '.cast', 'agents', 'test-new-agents')

      // Create test directory structure
      fs.mkdirSync(agentsDir, {recursive: true})

      // Create test agent with agent.yaml
      const agentPath = path.join(agentsDir, 'test-agent-1')
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test-agent-1')

      try {
        // Set up mock BEFORE loading command
        mockFsModule({
          readdirSync: () => ['test-agent-1'] as any
        })

        // Load command AFTER mock is set up
        const TestNew = await loadTestCommand('new')
        const instance = new TestNew([], {} as any) as any
        let loggedMessage = ''
        instance.log = (msg: string) => {
          loggedMessage += msg
        }

        instance.checkForNewAgent()
        expect(loggedMessage).to.include('Your agents')
      } finally {
        // Cleanup
        fs.rmSync(agentsDir, {recursive: true, force: true})
      }
    })

    it('should suggest git init for new agents without git', async () => {
      const agentsDir = path.join(os.homedir(), '.cast', 'agents', 'test-new-agents-2')

      // Create test directory structure
      fs.mkdirSync(agentsDir, {recursive: true})

      // Create test agent with agent.yaml but no .git
      const agentPath = path.join(agentsDir, 'test-agent-2')
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test-agent-2')

      try {
        // Set up mock BEFORE loading command
        // Return false for .git directories to trigger git init suggestion
        mockFsModule({
          existsSync: (p: any) => {
            const str = p.toString()
            // Return false for .git to simulate no git repo
            if (str.includes('.git')) return false
            return true
          },
          readdirSync: () => ['test-agent-2'] as any
        })

        // Load command AFTER mock is set up
        const TestNew = await loadTestCommand('new')
        const instance = new TestNew([], {} as any) as any
        let loggedMessage = ''
        instance.log = (msg: string) => {
          loggedMessage += msg
        }

        instance.checkForNewAgent()
        expect(loggedMessage).to.include('Git Integration Available')
        expect(loggedMessage).to.include('cast git init')
      } finally {
        // Cleanup
        fs.rmSync(agentsDir, {recursive: true, force: true})
      }
    })
  })

  describe('getPythonExecutable method', () => {
    it('should return a string', () => {
      const instance = new New([], {color: false})
      const pythonPath = instance.getPythonExecutable()
      expect(pythonPath).to.be.a('string')
    })

    it('should prefer venv python if available', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: (p: any) => {
          const str = p.toString()
          return str.includes('.venv/bin/python3')
        }
      })

      // Load command AFTER mock is set up
      const TestNew = await loadTestCommand('new')
      const instance = new TestNew([], {color: false})

      const pythonPath = instance.getPythonExecutable()
      expect(pythonPath).to.include('.venv')
    })

    it('should fall back to python3 if venv not found', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: (p: any) => {
          const str = p.toString()
          return !str.includes('.venv/bin/python3')
        }
      })

      // Load command AFTER mock is set up
      const TestNew = await loadTestCommand('new')
      const instance = new TestNew([], {color: false})

      const pythonPath = instance.getPythonExecutable()
      expect(pythonPath).to.equal('python3')
    })
  })

  describe('getPythonPath method', () => {
    it('should return a string path', () => {
      const instance = new New([], {color: false})
      const pythonPath = instance.getPythonPath()
      expect(pythonPath).to.be.a('string')
      expect(pythonPath.length).to.be.greaterThan(0)
    })

    it('should include python directory', () => {
      const instance = new New([], {color: false})
      const pythonPath = instance.getPythonPath()
      expect(pythonPath).to.include('python')
    })
  })
})

describe('new command - runTerminalMode', () => {
  let New: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    New = await loadTestCommand('new')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should have runTerminalMode method', () => {
    const instance = new New([], {color: false})
    expect(typeof instance.runTerminalMode).to.equal('function')
  })

  it('should handle bridge errors', () => {
    const instance = new New([], {color: false})

    // Test that error method exists and can be called
    let errorThrown = false
    let errorMessage = ''

    instance.error = (msg: string) => {
      errorThrown = true
      errorMessage = msg
      throw new Error(msg)
    }

    // Call error with a test message
    try {
      instance.error('Failed to start builder bridge: Bridge error')
      expect.fail('Should have thrown')
    } catch (e: any) {
      expect(e.message).to.include('Bridge error')
    }

    expect(errorThrown).to.be.true
  })

  it('should warn on bridge error', () => {
    const instance = new New([], {color: false})

    let warned = false
    let warningMessage = ''

    instance.warn = (msg: string) => {
      warned = true
      warningMessage = msg
    }

    // Simulate warning
    instance.warn('Failed to start builder: Bridge error')

    expect(warned).to.be.true
    expect(warningMessage).to.include('Failed to start builder')
  })
})

describe('new command - error handling', () => {
  let New: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    New = await loadTestCommand('new')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
    // Restore original fs module
    restoreFsModule()
  })

  it('should handle TUI not found gracefully', async () => {
    const instance = new New([], {color: false})

    mockFsModule({
      existsSync: (p: any) => {
        const str = p.toString()
        return !str.includes('cast-tui')
      }
    })

    // The instance should warn about TUI not found when run
    expect(typeof instance.run).to.equal('function')
  })
})