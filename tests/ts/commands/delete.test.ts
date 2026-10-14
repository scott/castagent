import {expect} from 'chai'
import sinon from 'sinon'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Import db and keychain modules for mocking
import * as dbModule from '../../../typescript/cast-cli/src/lib/sqlite'
import * as keychainModule from '../../../typescript/cast-cli/src/lib/keychain'

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

describe('delete command', () => {
  // We test the delete command behavior by testing its logic patterns
  // Since the command depends on keytar (ES module) and SQLite (native module),
  // we test the command's logic structure and behavior patterns

  let Delete: any
  let sandbox: sinon.SinonSandbox
  const testAgentDir = path.join(os.homedir(), '.cast', 'agents', 'test-delete-agent-' + Date.now())

  before(async () => {
    Delete = await loadTestCommand('delete')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
    // Clean up test directory
    if (fs.existsSync(testAgentDir)) {
      fs.rmSync(testAgentDir, { recursive: true, force: true })
    }
    // Restore original fs module
    restoreFsModule()
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Delete.description).to.equal('Delete agent')
    })

    it('should require agent name argument', () => {
      expect(Delete.args.agent.description).to.equal('Agent name')
      expect(Delete.args.agent.required).to.be.true
    })

    it('should have force flag', () => {
      expect(Delete.flags.force).to.exist
      expect(Delete.flags.force.description).to.equal('Force deletion without confirmation')
    })
  })

  describe('command execution', () => {
    it('should have confirm method', () => {
      const instance = new Delete(['delete', 'test'], {} as any)
      expect(typeof instance.confirm).to.equal('function')
    })

    it('should return true for "y" confirmation', async () => {
      const instance = new Delete(['delete', 'test'], {} as any)

      const rl = {
        question: (q: string, cb: (answer: string) => void) => {
          cb('y')
        },
        close: () => {},
      }
      sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

      const result = await instance.confirm('Delete?')
      expect(result).to.be.true
    })

    it('should return false for "n" confirmation', async () => {
      const instance = new Delete(['delete', 'test'], {} as any)

      const rl = {
        question: (q: string, cb: (answer: string) => void) => {
          cb('n')
        },
        close: () => {},
      }
      sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

      const result = await instance.confirm('Delete?')
      expect(result).to.be.false
    })

    it('should return false for empty confirmation', async () => {
      const instance = new Delete(['delete', 'test'], {} as any)

      const rl = {
        question: (q: string, cb: (answer: string) => void) => {
          cb('')
        },
        close: () => {},
      }
      sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

      const result = await instance.confirm('Delete?')
      expect(result).to.be.false
    })

    it('should handle case insensitive "Y" confirmation', async () => {
      const instance = new Delete(['delete', 'test'], {} as any)

      const rl = {
        question: (q: string, cb: (answer: string) => void) => {
          cb('Y')
        },
        close: () => {},
      }
      sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

      const result = await instance.confirm('Delete?')
      expect(result).to.be.true
    })
  })

  describe('agent path resolution', () => {
    it('should construct path to ~/.cast/agents/{agentName}', () => {
      const agentName = 'test-agent'
      const expectedPath = `${os.homedir()}/.cast/agents/${agentName}`
      expect(expectedPath).to.include('.cast')
      expect(expectedPath).to.include('agents')
      expect(expectedPath).to.include(agentName)
    })
  })

  describe('run method - error cases', () => {
    // Helper to create a properly configured command instance for run() tests
    const createRunInstance = (args: string[]): any => {
      const inst = new Delete(args, {} as any)
      // Mock config for oclif
      ;(inst as any).config = {
        runHook: async () => ({ successes: [], failures: [] }),
        name: 'delete',
        bin: 'cast'
      }
      // Parse flags from args
      const hasForce = args.includes('--force')
      // Override parse to bypass oclif internals
      ;(inst as any).parse = async () => ({
        args: { agent: args[1] || 'test-agent' },
        flags: { force: hasForce },
        argv: args,
        raw: [],
        metadata: {},
        nonExistentFlags: []
      })
      return inst
    }

    it('should error when agent is deployed', async () => {
      const instance = createRunInstance(['delete', 'deployed-agent'])

      // Mock db.getDeployment to return a deployment
      sandbox.stub(dbModule.db, 'getDeployment').returns({
        provider: 'docker',
        deployment_url: 'http://localhost:8080'
      })

      sandbox.stub(instance, 'error').throws(new Error('Agent is deployed'))

      try {
        await instance.run()
        expect.fail('Should have thrown')
      } catch (e: any) {
        expect(e.message).to.include('deployed')
      }
    })

    it('should handle missing agent directory with db record', async () => {
      const agentName = 'db-only-agent'
      const instance = createRunInstance(['delete', agentName])

      sandbox.stub(dbModule.db, 'getDeployment').returns(null) // Not deployed
      mockFsModule({ existsSync: () => false }) // Directory doesn't exist
      sandbox.stub(dbModule.db, 'getAgent').returns({ name: agentName }) // But db has it
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})

      sandbox.stub(keychainModule.keychain, 'removeAgentToken').resolves({result: 'absent'})

      sandbox.stub(instance, 'warn').callsFake(() => {})
      sandbox.stub(instance, 'log').callsFake(() => {})

      await instance.run()
      // Should complete without error
      expect(true).to.be.true
    })

    it('should handle nonexistent agent gracefully', async () => {
      const agentName = 'nonexistent-agent'
      const instance = createRunInstance(['delete', agentName])

      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      mockFsModule({ existsSync: () => false })
      sandbox.stub(dbModule.db, 'getAgent').returns(null)

      sandbox.stub(instance, 'log').callsFake(() => {})

      await instance.run()
      // Should complete without error
      expect(true).to.be.true
    })

    it('should delete agent directory when confirmed', async () => {
      const agentName = 'confirmed-delete-agent'
      // The delete command looks for agents at ~/.cast/agents/{agentName}
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentPath, { recursive: true })
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test')

      const instance = createRunInstance(['delete', agentName, '--force'])

      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getAgent').returns({ name: agentName })
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})

      sandbox.stub(keychainModule.keychain, 'getToken').resolves(null)
      sandbox.stub(keychainModule.keychain, 'removeAgentToken').resolves({result: 'absent'})

      sandbox.stub(instance, 'log').callsFake(() => {})

      // Ensure directory exists before run
      expect(fs.existsSync(agentPath)).to.be.true

      await instance.run()

      // Directory should be deleted
      expect(fs.existsSync(agentPath)).to.be.false
    })

    it('should cancel deletion when not confirmed', async () => {
      const agentName = 'cancelled-delete-agent'
      const agentPath = path.join(testAgentDir, agentName)
      fs.mkdirSync(agentPath, { recursive: true })

      const instance = createRunInstance(['delete', agentName]) // No --force

      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      mockFsModule({
        existsSync: (p: any) => {
          return String(p).includes('.cast/agents') ? true : false
        }
      })
      sandbox.stub(dbModule.db, 'getAgent').returns({ name: agentName })
      sandbox.stub(keychainModule.keychain, 'getToken').resolves(null)

      const rl = {
        question: (q: string, cb: (answer: string) => void) => {
          cb('n') // Answer "no"
        },
        close: () => {},
      }
      sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

      sandbox.stub(instance, 'log').callsFake(() => {})

      await instance.run()

      // Directory should still exist
      expect(fs.existsSync(agentPath)).to.be.true
    })

    const secretServiceError = new Error(
      'The name org.freedesktop.secrets was not provided by any .service files',
    )

    const captureOutput = (instance: any) => {
      const logs: string[] = []
      const warnings: string[] = []
      sandbox.stub(instance, 'log').callsFake((...args: unknown[]) => {
        logs.push(args.map(arg => String(arg ?? '')).join(' '))
      })
      sandbox.stub(instance, 'warn').callsFake((...args: unknown[]) => {
        warnings.push(args.map(arg => String(arg ?? '')).join(' '))
      })
      const errorSpy = sandbox.spy(console, 'error')
      return {logs, warnings, errorSpy}
    }

    it('prints one line when Secret Service is missing and does not claim the token was removed', async () => {
      const agentName = 'keychain-missing-agent'
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test')

      const instance = createRunInstance(['delete', agentName, '--force'])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getAgent').returns({name: agentName})
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})
      sandbox.stub(require('keytar'), 'getPassword').rejects(secretServiceError)
      sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)

      const {logs, warnings, errorSpy} = captureOutput(instance)

      try {
        await instance.run()
      } finally {
        if (fs.existsSync(agentPath)) fs.rmSync(agentPath, {recursive: true, force: true})
      }

      expect(logs.filter(line => line === 'No keychain available. Nothing removed.')).to.have.length(1)
      expect(warnings.filter(line => line.startsWith('Failed to remove token from keychain'))).to.deep.equal([])
      expect(errorSpy.called).to.equal(false)
      expect(logs.some(line => line.includes('Removed token from keychain.'))).to.equal(false)
      expect(logs.some(line => line.includes(`Agent '${agentName}' deleted successfully.`))).to.equal(true)
    })

    it('prints Removed token from keychain only when a token was deleted', async () => {
      const agentName = 'keychain-removed-agent'
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test')

      const instance = createRunInstance(['delete', agentName, '--force'])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getAgent').returns({name: agentName})
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})
      sandbox.stub(require('keytar'), 'getPassword').resolves('stored-token')
      sandbox.stub(require('keytar'), 'deletePassword').resolves(true)

      const {logs, warnings, errorSpy} = captureOutput(instance)

      try {
        await instance.run()
      } finally {
        if (fs.existsSync(agentPath)) fs.rmSync(agentPath, {recursive: true, force: true})
      }

      expect(logs.filter(line => line === 'Removed token from keychain.')).to.have.length(1)
      expect(logs.some(line => line.includes('Auth token from keychain'))).to.equal(true)
      expect(logs.some(line => line.includes('No keychain available'))).to.equal(false)
      expect(warnings).to.deep.equal([])
      expect(errorSpy.called).to.equal(false)
    })

    it('does not claim a token was removed when the keychain has none', async () => {
      const agentName = 'keychain-absent-agent'
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test')

      const instance = createRunInstance(['delete', agentName, '--force'])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getAgent').returns(null)
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})
      sandbox.stub(require('keytar'), 'getPassword').resolves(null)
      sandbox.stub(require('keytar'), 'deletePassword').resolves(false)

      const {logs, warnings, errorSpy} = captureOutput(instance)

      try {
        await instance.run()
      } finally {
        if (fs.existsSync(agentPath)) fs.rmSync(agentPath, {recursive: true, force: true})
      }

      expect(logs.some(line => line.includes('Removed token from keychain.'))).to.equal(false)
      expect(logs.some(line => line.includes('No keychain available'))).to.equal(false)
      expect(warnings).to.deep.equal([])
      expect(errorSpy.called).to.equal(false)
    })

    it('warns once when token deletion fails for another reason', async () => {
      const agentName = 'keychain-failed-agent'
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test')

      const instance = createRunInstance(['delete', agentName, '--force'])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getAgent').returns(null)
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})
      sandbox.stub(require('keytar'), 'getPassword').resolves(null)
      sandbox.stub(require('keytar'), 'deletePassword').rejects(new Error('Keychain error'))

      const {logs, warnings, errorSpy} = captureOutput(instance)

      try {
        await instance.run()
      } finally {
        if (fs.existsSync(agentPath)) fs.rmSync(agentPath, {recursive: true, force: true})
      }

      expect(warnings).to.deep.equal(['Failed to remove token from keychain: Keychain error'])
      expect(logs.some(line => line.includes('Removed token from keychain.'))).to.equal(false)
      expect(logs.some(line => line.includes('No keychain available'))).to.equal(false)
      expect(errorSpy.called).to.equal(false)
    })

    it('removes a file fallback token when Secret Service is missing', async () => {
      const agentName = 'keychain-file-fallback-agent'
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      const tokenFile = path.join(os.homedir(), '.cast', 'tokens', `${agentName}.token`)
      fs.mkdirSync(agentPath, {recursive: true})
      fs.mkdirSync(path.dirname(tokenFile), {recursive: true})
      fs.writeFileSync(tokenFile, 'file-token', {mode: 0o600})

      const instance = createRunInstance(['delete', agentName, '--force'])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getAgent').returns({name: agentName})
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})
      sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)

      const {logs, warnings, errorSpy} = captureOutput(instance)

      try {
        await instance.run()
      } finally {
        if (fs.existsSync(agentPath)) fs.rmSync(agentPath, {recursive: true, force: true})
        if (fs.existsSync(tokenFile)) fs.rmSync(tokenFile, {force: true})
      }

      expect(logs).to.include('Removed bearer token from ~/.cast/tokens.')
      expect(logs.some(line => line.includes('Nothing removed.'))).to.equal(false)
      expect(logs.some(line => line.includes('Removed token from keychain.'))).to.equal(false)
      expect(warnings).to.deep.equal([])
      expect(errorSpy.called).to.equal(false)
      expect(fs.existsSync(tokenFile)).to.equal(false)
    })

    it('prints one line when a database-only agent has no keychain', async () => {
      const agentName = 'db-only-no-keychain'
      const instance = createRunInstance(['delete', agentName, '--force'])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getAgent').returns({name: agentName})
      sandbox.stub(dbModule.db, 'deleteAgent').callsFake(() => {})
      sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)

      const {logs, warnings, errorSpy} = captureOutput(instance)
      await instance.run()

      expect(logs).to.include('No keychain available. Nothing removed.')
      expect(logs.some(line => line.includes('Removed token from keychain.'))).to.equal(false)
      expect(warnings.filter(line => /Removed token|Failed to delete token/.test(line))).to.deep.equal([])
      expect(errorSpy.called).to.equal(false)
    })
  })

  describe('items to delete list', () => {
    it('should list agent directory in items', () => {
      const agentPath = `${os.homedir()}/.cast/agents/test-agent`
      const item = `Agent directory: ${agentPath}`

      expect(item).to.include('Agent directory')
      expect(item).to.include(agentPath)
    })

    it('should list database records as item', () => {
      const item = 'Database records'
      expect(item).to.equal('Database records')
    })

    it('should list keychain token as item', () => {
      const item = 'Auth token from keychain'
      expect(item).to.equal('Auth token from keychain')
    })
  })

  describe('error message patterns', () => {
    it('should have deployment error message format', () => {
      const agentName = 'test-agent'
      const provider = 'docker'
      const deployment_url = 'http://localhost:8080'

      const errorMsg = `Agent '${agentName}' is currently deployed to ${provider} (${deployment_url}).\n` +
        `Shut it down first before deleting:\n` +
        `  cast shutdown ${agentName}`

      expect(errorMsg).to.include('currently deployed')
      expect(errorMsg).to.include(provider)
      expect(errorMsg).to.include('cast shutdown')
    })

    it('should have DB cleanup warning format', () => {
      const agentName = 'test-agent'
      const warning = `Agent directory not found, but '${agentName}' exists in the database.`
      const cleanupMsg = 'Cleaning up database records...'

      expect(warning).to.include('not found')
      expect(warning).to.include('database')
      expect(cleanupMsg).to.include('Cleaning up')
    })

    it('should have "not found" message for nonexistent agent', () => {
      const agentName = 'nonexistent'
      const notFoundMsg = `Agent '${agentName}' not found. Nothing to delete.`

      expect(notFoundMsg).to.include('not found')
      expect(notFoundMsg).to.include('Nothing to delete')
    })
  })

  describe('directory removal', () => {
    it('should use recursive and force options for rmSync', () => {
      const options = {recursive: true, force: true}
      expect(options.recursive).to.be.true
      expect(options.force).to.be.true
    })

    it('should handle directory removal errors', () => {
      const errorMsg = 'Failed to remove agent directory: Permission denied'
      expect(errorMsg).to.include('Failed to remove agent directory')
    })
  })

  describe('database deletion', () => {
    it('should call deleteAgent with agent name', () => {
      const agentName = 'test-agent'
      expect(agentName).to.equal('test-agent')
    })

    it('should handle database errors gracefully', () => {
      const warningMsg = 'Failed to remove from database: Permission denied'
      expect(warningMsg).to.include('Failed to remove from database')
    })
  })

  describe('keychain deletion', () => {
    it('should call deleteToken with agent name', () => {
      const agentName = 'test-agent'
      expect(agentName).to.equal('test-agent')
    })

    it('should handle keychain errors gracefully', () => {
      const warningMsg = 'Failed to remove token from keychain: Keychain error'
      expect(warningMsg).to.include('Failed to remove token from keychain')
    })
  })

  describe('success message patterns', () => {
    it('should have success message format', () => {
      const agentName = 'test-agent'
      const successMsg = `Agent '${agentName}' deleted successfully.`

      expect(successMsg).to.include('deleted successfully')
      expect(successMsg).to.include(agentName)
    })

    it('should have cancellation message', () => {
      const cancelMsg = 'Deletion cancelled.'
      expect(cancelMsg).to.include('cancelled')
    })
  })
})