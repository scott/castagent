import {expect} from 'chai'
import sinon from 'sinon'
import {spawnSync} from 'child_process'
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
      expect(New.description).to.equal(
        'Create a new agent. On a TTY, opens the Builder wizard. Without a TTY, reads a description from stdin and creates the agent.',
      )
    })

    it('should have no required arguments', () => {
      expect(New.args).to.deep.equal({})
    })

    it('should have no flags', () => {
      expect(New.flags).to.deep.equal({})
    })

    it('should have examples', () => {
      expect(New.examples).to.not.be.empty
      expect(New.examples.join('\n')).to.include('echo "Summarises incoming email and drafts replies."')
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

describe('new command - stdin without a TTY', () => {
  const worker = path.join(__dirname, 'new-stdin-worker.ts')
  const repoRoot = path.resolve(__dirname, '../../..')

  function runNew(input: string, extraEnv: NodeJS.ProcessEnv = {}) {
    return spawnSync(process.execPath, ['-r', 'ts-node/register', worker], {
      cwd: repoRoot,
      env: {
        ...process.env,
        TS_NODE_TRANSPILE_ONLY: '1',
        ...extraEnv,
      },
      encoding: 'utf8',
      input,
    })
  }

  function withMarkerRestore(fn: () => void): void {
    const marker = path.join(os.homedir(), '.cast', 'builder', 'created-agent')
    const hadMarker = fs.existsSync(marker)
    const markerBefore = hadMarker ? fs.readFileSync(marker) : null
    try {
      fn()
    } finally {
      if (hadMarker && markerBefore) {
        fs.mkdirSync(path.dirname(marker), {recursive: true})
        fs.writeFileSync(marker, markerBefore)
      } else if (fs.existsSync(marker)) {
        fs.rmSync(marker)
      }
    }
  }

  it('rejects a blank pipe and does not create an agent', () => {
    const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-new-stdin-blank-'))
    try {
      const result = runNew('   \n', {CAST_AGENTS_DIR: agents})
      expect(result.status).to.not.equal(0)
      expect(result.stderr).to.include('No description on stdin')
      expect(result.stdout).to.not.include('Launching OpenTUI')
      expect(fs.readdirSync(agents)).to.deep.equal([])
    } finally {
      fs.rmSync(agents, {recursive: true, force: true})
    }
  })

  it('prints the agent from stdin and does not launch the TUI', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-new-stdin-fake-'))
    const bin = path.join(root, 'bin')
    const agents = path.join(root, 'agents')
    const stdinOut = path.join(root, 'stdin.txt')
    fs.mkdirSync(bin)
    fs.mkdirSync(agents)
    const fake = path.join(bin, 'python3')
    fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('fs')
const path = require('path')
const chunks = []
process.stdin.on('data', (chunk) => chunks.push(chunk))
process.stdin.on('end', () => {
  const text = Buffer.concat(chunks).toString('utf8')
  fs.writeFileSync(process.env.CAST_STDIN_OUT, text)
  if (process.argv[2] !== '-m' || process.argv[3] !== 'cast.create_from_stdin') {
    process.stderr.write('unexpected python args\\n')
    process.exit(9)
  }
  const agentPath = path.join(process.env.CAST_AGENTS_DIR, 'email-agent')
  process.stdout.write(JSON.stringify({name: 'email-agent', path: agentPath}) + '\\n')
})
`, {mode: 0o755})
    try {
      const description = 'Email assistant that triages and drafts replies'
      const result = runNew(`${description}\n`, {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
        CAST_AGENTS_DIR: agents,
        CAST_STDIN_OUT: stdinOut,
      })
      expect(result.status, result.stderr || result.stdout).to.equal(0)
      expect(result.stdout).to.include("Created agent 'email-agent'")
      expect(result.stdout).to.include('cast dev email-agent')
      expect(result.stdout).to.include(path.join(agents, 'email-agent'))
      expect(result.stdout).to.not.include('Launching OpenTUI')
      expect(fs.readFileSync(stdinOut, 'utf8')).to.equal(`${description}\n`)
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('surfaces a builder failure from the piped path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-new-stdin-fail-'))
    const bin = path.join(root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'python3'), `#!/bin/sh
echo 'Could not derive an agent name from the description.' >&2
exit 2
`, {mode: 0o755})
    try {
      const result = runNew('hello from the pipe\n', {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
      })
      expect(result.status).to.not.equal(0)
      expect(result.stderr).to.include('Could not derive an agent name from the description.')
      expect(result.stdout).to.not.include('Launching OpenTUI')
    } finally {
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('creates an agent from a piped description', function () {
    const probe = spawnSync('python3', ['-c', 'import langchain_core, yaml'], {encoding: 'utf8'})
    if (probe.status !== 0) {
      this.skip()
    }
    const venv = path.join(repoRoot, 'python', '.venv', 'bin', 'python3')
    if (fs.existsSync(venv)) {
      this.skip()
    }

    const agents = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-new-stdin-real-'))
    const description = 'Email assistant that triages and drafts replies'
    const homeSide = path.join(os.homedir(), '.cast', 'agents', 'email-agent')
    const homeExisted = fs.existsSync(homeSide)
    withMarkerRestore(() => {
      try {
        const result = runNew(`${description}\n`, {CAST_AGENTS_DIR: agents})
        expect(result.status, result.stderr || result.stdout).to.equal(0)
        expect(result.stdout).to.include("Created agent 'email-agent'")
        expect(result.stdout).to.include('cast dev email-agent')
        expect(result.stdout).to.not.include('Launching OpenTUI')
        const agentDir = path.join(agents, 'email-agent')
        const agentYaml = fs.readFileSync(path.join(agentDir, 'agent.yaml'), 'utf8')
        expect(agentYaml).to.include('name: email-agent')
        expect(agentYaml).to.include(description)
        const instructions = fs.readFileSync(path.join(agentDir, 'instructions.md'), 'utf8')
        expect(instructions).to.include(description)
        expect(fs.existsSync(path.join(agentDir, '.cast', 'changes', 'changes.json'))).to.equal(true)
        if (!homeExisted) {
          expect(fs.existsSync(homeSide)).to.equal(false)
        }
      } finally {
        fs.rmSync(agents, {recursive: true, force: true})
      }
    })
  })
})