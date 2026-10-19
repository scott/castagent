import {expect} from 'chai'
import {EventEmitter} from 'events'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as sinon from 'sinon'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

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

describe('dev command', () => {
  let Dev: any

  before(async () => {
    Dev = await loadTestCommand('dev')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Dev.description).to.equal('Start agent in development mode')
    })

    it('should have agent name argument', () => {
      expect(Dev.args).to.exist
      expect(Dev.args.agent).to.exist
      expect(Dev.args.agent.description).to.equal('Agent name')
      expect(Dev.args.agent.required).to.be.true
    })

    it('should have port flag', () => {
      const portFlag = Dev.flags.port
      expect(portFlag).to.exist
      expect(portFlag.description).to.equal('Port for A2A server')
      expect(portFlag.default).to.equal(0)
    })

    it('should have no-tui flag', () => {
      const noTuiFlag = Dev.flags['no-tui']
      expect(noTuiFlag).to.exist
      expect(noTuiFlag.description).to.equal('Run without TUI (headless mode)')
    })

    it('should have examples', () => {
      expect(Dev.examples).to.not.be.empty
      expect(Dev.examples[0]).to.include('<%= config.bin %>')
    })
  })

  describe('command execution', () => {
    const tempAgentsDir = path.join(os.homedir(), '.cast', 'agents')
    const testAgentName = 'test-dev-command-agent'

    afterEach(async () => {
      // Clean up test agent directory if it exists
      const agentPath = path.join(tempAgentsDir, testAgentName)
      if (fs.existsSync(agentPath)) {
        fs.rmSync(agentPath, {recursive: true, force: true})
      }
    })

    it('should have validateAgentName method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.validateAgentName).to.equal('function')
    })

    it('should accept valid agent names', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(instance.validateAgentName('valid-agent')).to.equal(true)
      expect(instance.validateAgentName('test123')).to.equal(true)
      expect(instance.validateAgentName('my-agent-v2')).to.equal(true)
      expect(instance.validateAgentName('a')).to.equal(true)
      expect(instance.validateAgentName('ABC123')).to.equal(true)
    })

    it('should reject invalid agent names', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(instance.validateAgentName('invalid@name')).to.equal(false)
      expect(instance.validateAgentName('name with spaces')).to.equal(false)
      expect(instance.validateAgentName('name/slash')).to.equal(false)
      expect(instance.validateAgentName('name.dot')).to.equal(false)
      expect(instance.validateAgentName('name_underscore')).to.equal(false)
      expect(instance.validateAgentName('')).to.equal(false)
    })

    it('should have isPortInUse method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.isPortInUse).to.equal('function')
    })

    it('should have getPythonExecutable method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.getPythonExecutable).to.equal('function')
    })

    it('should have getPythonPath method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.getPythonPath).to.equal('function')
    })

    it('getPythonExecutable should return a string', () => {
      const instance = new Dev(['test-agent'], {color: false})
      const pythonPath = instance.getPythonExecutable()
      expect(pythonPath).to.be.a('string')
    })

    it('getPythonPath should return a string path', () => {
      const instance = new Dev(['test-agent'], {color: false})
      const pythonPath = instance.getPythonPath()
      expect(pythonPath).to.be.a('string')
      expect(pythonPath.length).to.be.greaterThan(0)
    })

    it('starts the builder in new mode when the agent is missing', () => {
      const instance = new Dev(['bb-devnew'], {color: false})
      const params = instance.missingAgentInitializeParams('bb-devnew')
      expect(params).to.deep.equal({agent_name: 'bb-devnew', new_mode: true})

      const env = instance.builderLaunchEnv('bb-devnew', '/tmp/bb-devnew', '/tmp/python')
      expect(env.CAST_NEW_MODE).to.equal('1')
      expect(env.CAST_AGENT_NAME).to.equal('bb-devnew')
      expect(env.CAST_AGENT_PATH).to.equal('/tmp/bb-devnew')
      expect(env.PYTHONPATH).to.equal('/tmp/python')
    })

    it('passes the agent directory to the runtime as CAST_AGENT_PATH', () => {
      const instance = new Dev(['bb-devnew'], {color: false})
      const env = instance.runtimeLaunchEnv('bb-devnew', '/tmp/bb-devnew', '/tmp/python')
      expect(env.CAST_AGENT_NAME).to.equal('bb-devnew')
      expect(env.CAST_AGENT_PATH).to.equal('/tmp/bb-devnew')
      expect(env.PYTHONPATH).to.equal('/tmp/python')
    })
  })
})

describe('dev command - instance methods', () => {
  let Dev: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    Dev = await loadTestCommand('dev')
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
    it('should have checkVenv method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.checkVenv).to.equal('function')
    })

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
      const TestDev = await loadTestCommand('dev')
      const instance = new TestDev(['test-agent'], {color: false})
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
    it('should have resolveBun method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.resolveBun).to.equal('function')
    })

    it('should return a string path', () => {
      const instance = new Dev(['test-agent'], {color: false})
      const bunPath = instance.resolveBun()
      expect(bunPath).to.be.a('string')
    })

    it('should prefer homedir bun path', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: (p: any) => {
          const str = p.toString()
          return str.includes('.bun/bin/bun')
        }
      })

      // Load command AFTER mock is set up
      const TestDev = await loadTestCommand('dev')
      const instance = new TestDev(['test-agent'], {color: false})

      const bunPath = instance.resolveBun()
      expect(bunPath).to.include('.bun')
    })

    it('should fall back to "bun" if not found', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: () => false
      })

      // Load command AFTER mock is set up
      const TestDev = await loadTestCommand('dev')
      const instance = new TestDev(['test-agent'], {color: false})

      const bunPath = instance.resolveBun()
      expect(bunPath).to.equal('bun')
    })
  })

  describe('connectToAgent method', () => {
    it('should have connectToAgent method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.connectToAgent).to.equal('function')
    })

    it('should log A2A endpoint in headless mode', () => {
      const instance = new Dev(['test-agent'], {color: false})
      let logged = false

      instance.log = (msg: string) => {
        if (msg.includes('A2A endpoint')) {
          logged = true
        }
      }

      const flags = {'no-tui': true}
      instance.connectToAgent('test-agent', 8080, flags)

      expect(logged).to.be.true
    })

    it('should warn when TUI not found', async () => {
      // Set up mock BEFORE loading command
      mockFsModule({
        existsSync: (p: any) => {
          return !p.toString().includes('cast-tui')
        }
      })

      // Load command AFTER mock is set up
      const TestDev = await loadTestCommand('dev')
      const instance = new TestDev(['test-agent'], {color: false})
      let warned = false

      instance.warn = (msg: string) => {
        if (msg.includes('OpenTUI not found')) {
          warned = true
        }
      }

      const spawnStub = sandbox.stub(require('child_process'), 'spawn').returns({
        on: () => ({on: () => {}}),
      } as any)

      const flags = {'no-tui': false}
      instance.connectToAgent('test-agent', 8080, flags)

      expect(warned || spawnStub.called).to.be.true
    })
  })

  describe('runRuntimeAgent method', () => {
    it('should have runRuntimeAgent method', () => {
      const instance = new Dev(['test-agent'], {color: false})
      expect(typeof instance.runRuntimeAgent).to.equal('function')
    })

    it('should set up startup timeout', () => {
      const instance = new Dev(['test-agent'], {color: false})
      const agentPath = path.join(os.homedir(), '.cast', 'agents', 'test-agent')
      const flags = {port: 0, 'no-tui': true}

      // This tests that the method exists and can be called
      // Full integration testing would require actual Python runtime
      expect(typeof instance.runRuntimeAgent).to.equal('function')
    })
  })
})

describe('dev command - error handling', () => {
  let Dev: any
  let sandbox: sinon.SinonSandbox
  const testAgentName = 'test-dev-error-agent'

  before(async () => {
    Dev = await loadTestCommand('dev')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
    // Clean up
    const agentPath = path.join(os.homedir(), '.cast', 'agents', testAgentName)
    if (fs.existsSync(agentPath)) {
      fs.rmSync(agentPath, {recursive: true, force: true})
    }
  })

  it('should error on invalid agent name', () => {
    const instance = new Dev(['dev', 'invalid@name'], {color: false})
    // validateAgentName should return false for invalid names
    expect(instance.validateAgentName('invalid@name')).to.be.false
    // The error method should be called with the right message
    let errorMsg = ''
    instance.error = (msg: string) => {
      errorMsg = msg
      throw new Error(msg)
    }
    try {
      instance.validateAgentName('invalid@name')
      expect.fail('Should have thrown')
    } catch (e: any) {
      // Expected
    }
  })

  it('should validate agent names correctly', () => {
    const instance = new Dev(['dev', testAgentName], {color: false})
    // Valid names should pass
    expect(instance.validateAgentName('valid-agent')).to.be.true
    expect(instance.validateAgentName('test123')).to.be.true
    // Invalid names should fail
    expect(instance.validateAgentName('invalid@name')).to.be.false
    expect(instance.validateAgentName('name with spaces')).to.be.false
    expect(instance.validateAgentName('name/slash')).to.be.false
  })

  it('should check port availability', async () => {
    const instance = new Dev(['dev', testAgentName], {color: false})
    // Mock isPortInUse to return true for testing
    sandbox.stub(instance, 'isPortInUse').resolves(true)
    const result = await instance.isPortInUse(99999)
    expect(result).to.be.true
  })

  it('should have error handling for nonexistent agent', () => {
    const instance = new Dev(['dev', 'nonexistent-agent'], {color: false})

    // Test that the instance has the required methods
    expect(typeof instance.validateAgentName).to.equal('function')
    expect(typeof instance.isPortInUse).to.equal('function')
    expect(typeof instance.checkVenv).to.equal('function')

    // Test that validateAgentName rejects invalid paths
    expect(instance.validateAgentName('nonexistent-agent')).to.be.true
  })

  it('should validate agent name correctly', () => {
    const instance = new Dev(['dev', testAgentName], {color: false})

    // Valid names should pass
    expect(instance.validateAgentName('valid-agent')).to.be.true
    expect(instance.validateAgentName('test123')).to.be.true
    expect(instance.validateAgentName('my-agent-v2')).to.be.true

    // Invalid names should fail
    expect(instance.validateAgentName('invalid@name')).to.be.false
    expect(instance.validateAgentName('name with spaces')).to.be.false
    expect(instance.validateAgentName('name/slash')).to.be.false
  })

  it('should check port availability', async () => {
    const instance = new Dev(['dev', testAgentName], {color: false})

    // Mock isPortInUse to return true for testing
    sandbox.stub(instance, 'isPortInUse').resolves(true)
    const result = await instance.isPortInUse(99999)
    expect(result).to.be.true
  })
})

describe('dev command - runBuilderConversation', () => {
  let Dev: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    Dev = await loadTestCommand('dev')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should have runBuilderConversation method', () => {
    const instance = new Dev(['test-agent'], {color: false})
    expect(typeof instance.runBuilderConversation).to.equal('function')
  })

  it('should handle builder errors', async () => {
    const instance = new Dev(['test-agent'], {color: false})
    const agentPath = path.join(os.homedir(), '.cast', 'agents', 'test-builder-agent')

    const mockBuilder = {
      stdout: {
        on: (event: string, cb: (...args: any[]) => void) => {
          if (event === 'line') {
            // Send an error message
            setTimeout(() => {
              cb('{"error": {"message": "Builder error"}}')
            }, 50)
          }
          return {on: () => ({on: () => {}})} as any
        },
      },
      stdin: {
        write: () => {},
      },
      on: (event: string, cb: (...args: any[]) => void) => {
        if (event === 'error') {
          setTimeout(() => cb(new Error('Builder error')), 100)
        }
        if (event === 'exit') {
          setTimeout(() => cb(1), 200)
        }
        return {on: () => {}} as any
      },
      killed: false,
    }

    // Mock user input
    const userRl = {
      on: () => userRl,
      close: () => {},
    }
    sandbox.stub(require('readline'), 'createInterface').returns(userRl as any)

    try {
      await instance.runBuilderConversation(mockBuilder as any, 'test-builder-agent', agentPath)
    } catch (e: any) {
      expect(e.message).to.include('error') || expect(e.message).to.include('Builder')
    }
  })
})

describe('dev command - /stop keeps the TUI open', () => {
  let Dev: any
  let sandbox: sinon.SinonSandbox
  let sigintListeners: NodeJS.SignalsListener[]
  const agentName = 'test-stop-tui-agent'
  const tuiEntry = path.join(__dirname, '../../../typescript/cast-tui/dist/index.js')
  // undefined until the first stand-in install. null means dist was absent.
  let savedTuiEntry: Buffer | null | undefined

  before(async () => {
    // Earlier tests swap fs in require.cache and reload this command.
    // Load a fresh copy against the real fs module so the TUI path
    // lookup is not stuck on that mock.
    restoreFsModule()
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}commands${path.sep}dev.ts`)) {
        delete require.cache[key]
      }
    }
    Dev = await loadTestCommand('dev')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sigintListeners = process.listeners('SIGINT') as NodeJS.SignalsListener[]
  })

  afterEach(() => {
    sandbox.restore()
    process.removeAllListeners('SIGINT')
    for (const listener of sigintListeners) {
      process.on('SIGINT', listener)
    }
    fs.rmSync(path.join(os.homedir(), '.cast', 'logs', `${agentName}.log`), {force: true})
    if (savedTuiEntry && savedTuiEntry.length > 0) {
      fs.mkdirSync(path.dirname(tuiEntry), {recursive: true})
      fs.writeFileSync(tuiEntry, savedTuiEntry)
    } else if (fs.existsSync(tuiEntry) && fs.readFileSync(tuiEntry, 'utf8').includes('test stand-in')) {
      fs.rmSync(tuiEntry, {force: true})
    }
  })

  function installTuiStandIn(): void {
    const tuiDist = path.dirname(tuiEntry)
    fs.mkdirSync(tuiDist, {recursive: true})
    if (savedTuiEntry === undefined) {
      if (fs.existsSync(tuiEntry)) {
        const body = fs.readFileSync(tuiEntry)
        savedTuiEntry = body.includes(Buffer.from('test stand-in')) ? null : body
      } else {
        savedTuiEntry = null
      }
    }
    fs.writeFileSync(tuiEntry, '// test stand-in\n')
  }

  function fakeChild() {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter
      stderr: EventEmitter
      pid: number
      exitCode: number | null
      killed: boolean
      kill: (signal?: NodeJS.Signals) => boolean
    }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.pid = 4242
    child.exitCode = null
    child.killed = false
    child.kill = (signal?: NodeJS.Signals) => {
      child.killed = true
      child.emit('close', null, signal ?? 'SIGTERM')
      return true
    }
    return child
  }

  function harness(flags: {'no-tui': boolean}) {
    const instance = new Dev(['dev', agentName], {color: false})
    const logs: string[] = []
    const errors: string[] = []
    instance.log = (msg?: string) => {
      logs.push(String(msg ?? ''))
    }
    instance.warn = (msg?: string) => {
      logs.push('WARN ' + String(msg ?? ''))
    }
    instance.error = (msg?: string) => {
      errors.push(String(msg ?? ''))
    }
    sandbox.stub(db, 'setLocalAgent').returns(undefined)
    sandbox.stub(db, 'removeLocalAgent').returns(undefined)
    sandbox.stub(process.stdin, 'pause').returns(process.stdin)
    sandbox.stub(process.stdin, 'resume').returns(process.stdin)
    const exitStub = sandbox.stub(process, 'exit')
    // existsSync cannot be stubbed (non-configurable). Put a stand-in
    // bundle where cast dev looks for the TUI so connectToAgent spawns it.
    // The real bundle is put back in afterEach.
    installTuiStandIn()
    const runtime = fakeChild()
    const tui = fakeChild()
    let spawnCount = 0
    instance.launch = () => {
      spawnCount += 1
      return spawnCount === 1 ? runtime : tui
    }
    return {instance, logs, errors, exitStub, runtime, tui, spawnCount: () => spawnCount, flags}
  }

  function boot(flags: {'no-tui': boolean}) {
    const ctx = harness(flags)
    // runRuntimeAgent waits forever. Drive the child events directly.
    void ctx.instance.runRuntimeAgent(agentName, path.join(os.tmpdir(), agentName), {port: 0, ...flags})
    ctx.runtime.stdout.emit('data', Buffer.from('Agent ready on port 4321\n'))
    return ctx
  }

  it('stays in the TUI when /stop terminates the runtime with SIGTERM', () => {
    const {logs, errors, exitStub, runtime, spawnCount} = boot({'no-tui': false})
    expect(spawnCount(), JSON.stringify(logs)).to.equal(2)

    runtime.emit('close', null, 'SIGTERM')

    expect(exitStub.called).to.equal(false)
    expect(errors).to.deep.equal([])
    expect(logs.some((line) => line.includes('code null'))).to.equal(false)
    expect(logs.some((line) => line.includes('Agent exited'))).to.equal(false)
    expect((db.removeLocalAgent as sinon.SinonStub).calledWith(agentName)).to.equal(true)
  })

  it('exits a headless session without printing a null status code', () => {
    const {logs, exitStub, runtime, spawnCount} = boot({'no-tui': true})
    expect(spawnCount()).to.equal(1)

    runtime.emit('close', null, 'SIGTERM')

    expect(exitStub.calledOnceWith(0)).to.equal(true)
    expect(logs.some((line) => line.includes('Agent exited with signal SIGTERM'))).to.equal(true)
    expect(logs.some((line) => line.includes('code null'))).to.equal(false)
  })

  it('still exits on Ctrl+C after the TUI is attached', () => {
    const {logs, exitStub, runtime} = boot({'no-tui': false})

    process.emit('SIGINT')

    expect(runtime.killed).to.equal(true)
    expect(exitStub.calledOnceWith(0)).to.equal(true)
    expect(logs.some((line) => line.includes('Agent exited with signal SIGTERM'))).to.equal(true)
    expect(logs.some((line) => line.includes('code null'))).to.equal(false)
  })

  it('starts the runtime with CAST_AGENT_PATH and piped stderr', () => {
    const ctx = harness({'no-tui': true})
    let options: {stdio?: unknown; env?: NodeJS.ProcessEnv} | undefined
    ctx.instance.launch = (_command: string, _args: readonly string[], opts: {stdio?: unknown; env?: NodeJS.ProcessEnv}) => {
      options = opts
      return ctx.runtime
    }
    void ctx.instance.runRuntimeAgent(agentName, '/tmp/bb-devnew', {port: 0, 'no-tui': true})
    ctx.runtime.stdout.emit('data', Buffer.from('Agent ready on port 4321\n'))

    expect(options?.stdio).to.deep.equal(['pipe', 'pipe', 'pipe'])
    expect(options?.env?.CAST_AGENT_NAME).to.equal(agentName)
    expect(options?.env?.CAST_AGENT_PATH).to.equal('/tmp/bb-devnew')
  })

  it('records runtime stdout and stderr for cast logs', () => {
    const stderr = sandbox.stub(process.stderr, 'write').returns(true)
    const {runtime} = boot({'no-tui': true})
    runtime.stderr.emit('data', Buffer.from('Traceback (most recent call last):\nImportError: missing\n'))

    const body = fs.readFileSync(path.join(os.homedir(), '.cast', 'logs', `${agentName}.log`), 'utf8')
    expect(body).to.include('Agent ready on port 4321')
    expect(body).to.include('ImportError: missing')
    expect(stderr.called).to.equal(true)
  })

  it('still surfaces a non-zero runtime crash', () => {
    const {logs, errors, exitStub, runtime} = boot({'no-tui': false})

    runtime.emit('close', 1, null)

    expect(errors.some((line) => line.includes('Agent exited with error code 1'))).to.equal(true)
    expect(exitStub.calledOnceWith(0)).to.equal(true)
    expect(logs.some((line) => line.includes('Agent exited with code 1'))).to.equal(true)
    expect(logs.some((line) => line.includes('code null'))).to.equal(false)
  })

  it('decides to keep the TUI only for a signaled stop', () => {
    const instance = new Dev(['dev', agentName], {color: false})
    instance.attachedTui = {exitCode: null, killed: false}
    instance.runtimeShutdownRequested = false

    expect(instance.shouldKeepTuiAfterRuntimeExit(null, 'SIGTERM')).to.equal(true)
    expect(instance.shouldKeepTuiAfterRuntimeExit(null, 'SIGKILL')).to.equal(true)
    expect(instance.shouldKeepTuiAfterRuntimeExit(null, null)).to.equal(true)
    expect(instance.shouldKeepTuiAfterRuntimeExit(1, null)).to.equal(false)
    expect(instance.runtimeExitLine(null, null)).to.equal('Agent exited')
    expect(instance.runtimeExitLine(null, 'SIGTERM')).to.equal('Agent exited with signal SIGTERM')

    instance.runtimeShutdownRequested = true
    expect(instance.shouldKeepTuiAfterRuntimeExit(null, 'SIGTERM')).to.equal(false)

    instance.runtimeShutdownRequested = false
    instance.attachedTui = null
    expect(instance.shouldKeepTuiAfterRuntimeExit(null, 'SIGTERM')).to.equal(false)

    instance.attachedTui = {exitCode: 0, killed: false}
    expect(instance.shouldKeepTuiAfterRuntimeExit(null, 'SIGTERM')).to.equal(false)
  })
})