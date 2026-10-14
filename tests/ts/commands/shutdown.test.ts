import {expect} from 'chai'
import sinon from 'sinon'
import * as path from 'path'
import * as os from 'os'

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

// Helper to create command instance with mocked context
function createCommandInstance(CommandClass: any, args: string[], flags: any = {}): any {
  const instance = new CommandClass(args, {color: false})
  // Mock the config object for oclif
  instance.config = {
    runHook: async () => {},
    name: 'shutdown',
    bin: 'cast'
  }
  // Mock argv for parse
  instance.argv = args
  // Set parsed args and flags directly and bypass parse()
  instance.args = { agent: args[0] }
  instance.flags = { force: flags.force || false }
  // Override parse to return mocked values
  instance.parse = async () => ({ args: instance.args, flags: instance.flags })
  // Mock confirm to return true by default (or use flags.confirm value)
  instance.confirm = async () => flags.confirm !== false
  return instance
}

function stubDeploymentTokenDelete(sandbox?: sinon.SinonSandbox): void {
  const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
  if (typeof keychainModule.keychain.deleteDeploymentToken !== 'function') {
    keychainModule.keychain.deleteDeploymentToken = async () => false
  }
  if (sandbox) {
    if (!(keychainModule.keychain.deleteDeploymentToken as any).isSinonProxy) {
      sandbox.stub(keychainModule.keychain, 'deleteDeploymentToken').resolves(false)
    }
    return
  }
  keychainModule.keychain.deleteDeploymentToken = async () => false
}

describe('shutdown command', () => {
  let Shutdown: any

  before(async () => {
    // Ensure deploy modules are loaded so PROVIDER_DESTROYERS is populated
    require('../../../typescript/cast-cli/src/lib/deploy/docker')
    require('../../../typescript/cast-cli/src/lib/deploy/fly')
    require('../../../typescript/cast-cli/src/lib/deploy/railway')
    require('../../../typescript/cast-cli/src/lib/deploy/digitalocean')
    require('../../../typescript/cast-cli/src/lib/deploy/sprites')
    Shutdown = await loadTestCommand('shutdown')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Shutdown.description).to.equal('Shut down a deployed agent (destroy remote resources)')
    })

    it('should have agent name argument', () => {
      expect(Shutdown.args.agent).to.exist
      expect(Shutdown.args.agent.description).to.equal('Agent name or deployment SHA')
      expect(Shutdown.args.agent.required).to.be.true
    })

    it('should have force flag', () => {
      expect(Shutdown.flags.force).to.exist
      expect(Shutdown.flags.force.description).to.equal('Skip confirmation prompt')
    })

    it('should not accept a --destroy-volume flag', () => {
      expect(Shutdown.flags).to.not.have.property('destroy-volume')
      expect(Object.keys(Shutdown.flags)).to.deep.equal(['force'])
    })

    it('should have examples', () => {
      expect(Shutdown.examples).to.not.be.empty
    })

    it('should include --force example', () => {
      const hasForceExample = Shutdown.examples.some((ex: string) => ex.includes('--force'))
      expect(hasForceExample).to.be.true
    })
  })

  describe('command behavior', () => {
    let sandbox: sinon.SinonSandbox

    beforeEach(() => {
      sandbox = sinon.createSandbox()
      stubDeploymentTokenDelete(sandbox)
    })

    afterEach(() => {
      sandbox.restore()
    })

    it('should log message when agent is not deployed', async () => {
      const testAgentName = 'test-shutdown-agent-none-' + Date.now()
      const instance = createCommandInstance(Shutdown, [testAgentName])
      let loggedMessage = ''

      instance.log = (msg: string) => {
        loggedMessage = msg
      }

      // Mock deployments to be empty (new code uses listDeployments / getDeploymentBySha)
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([])
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').returns(null)

      try {
        await instance.run()
        expect(loggedMessage).to.include('No deployment found')
      } finally {
        sandbox.restore()
      }
    })

    it('should show deployment info when agent is deployed', async () => {
      const testAgentName = 'test-shutdown-agent-deployed-' + Date.now()
      const instance = createCommandInstance(Shutdown, [testAgentName])
      let loggedMessage = ''

      instance.log = (msg: string) => {
        loggedMessage += msg + '\n'
      }

      // Mock deployment exists (new resolution: listDeployments returns one row)
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([{
        id: 'abc123',
        agent_name: testAgentName,
        deployment_url: 'https://fly.example.com/app',
        provider: 'fly',
      }])
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').returns(null)

      // Mock keychain
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves()

      // Mock db operations
      sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})

      try {
        await instance.run()
        // Check that deployment info was logged
        expect(loggedMessage).to.include('deployed to')
        expect(loggedMessage).to.include('fly')
      } finally {
        sandbox.restore()
      }
    })

    it('should warn when no destroyer is available for provider', async () => {
      const testAgentName = 'test-shutdown-agent-unknown-' + Date.now()
      const instance = createCommandInstance(Shutdown, [testAgentName])
      let warningMessage = ''

      instance.warn = (msg: string) => {
        warningMessage = msg
      }

      // Mock deployment with unsupported provider
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([{
        id: 'abc123',
        agent_name: testAgentName,
        deployment_url: 'https://custom.example.com',
        provider: 'unknown-provider',
      }])
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').returns(null)

      // Mock keychain
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves()

      // Mock db operations
      sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})

      try {
        await instance.run()
        expect(warningMessage).to.include('No shutdown handler')
      } finally {
        sandbox.restore()
      }
    })

    it('should remove deployment from database after shutdown', async () => {
      const testAgentName = 'test-shutdown-agent-remove-' + Date.now()
      const instance = createCommandInstance(Shutdown, [testAgentName])
      let dbMessage = ''

      instance.log = (msg: string) => {
        if (msg.includes('Marked all deployments as deleted')) {
          dbMessage = msg
        }
      }

      // Mock deployment
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([{
        id: 'sha123',
        agent_name: testAgentName,
        deployment_url: 'https://fly.example.com/app',
        provider: 'fly',
      }])
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').returns(null)

      // Track removeAllDeployments call
      const removeAllStub = sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})

      // Mock keychain
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves()

      try {
        await instance.run()
        expect(removeAllStub.calledOnce).to.be.true
        expect(removeAllStub.calledWith(testAgentName)).to.be.true
        expect(dbMessage).to.include('Marked all deployments as deleted')
      } finally {
        sandbox.restore()
      }
    })

    it('should remove auth token from keychain after shutdown', async () => {
      const testAgentName = 'test-shutdown-agent-keychain-' + Date.now()
      const instance = createCommandInstance(Shutdown, [testAgentName])
      let keychainMessage = ''

      instance.log = (msg: string) => {
        if (msg.includes('auth token')) {
          keychainMessage = msg
        }
      }

      // Mock deployment
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([{
        id: 'sha123',
        agent_name: testAgentName,
        deployment_url: 'https://fly.example.com/app',
        provider: 'fly',
      }])
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').returns(null)

      // Track keychain call
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      const deleteTokenStub = sandbox.stub(keychainModule.keychain, 'deleteToken').resolves({
        removed: true,
        stores: ['keychain'],
      })

      // Mock db operations
      sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})

      try {
        await instance.run()
        expect(deleteTokenStub.calledOnce).to.be.true
        expect(keychainMessage).to.equal('Removed auth token from keychain.')
      } finally {
        sandbox.restore()
      }
    })

    it('names the token file when the removed auth token was a file', async () => {
      const testAgentName = 'test-shutdown-agent-token-file-' + Date.now()
      const instance = createCommandInstance(Shutdown, [testAgentName], {force: true})
      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.warn = () => {}

      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([{
        id: 'sha123',
        agent_name: testAgentName,
        deployment_url: 'http://localhost:8080',
        provider: 'docker',
      }])
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').returns(null)
      sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})

      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves({removed: true, stores: ['file']})

      const shutdownModule = require('../../../typescript/cast-cli/src/commands/shutdown')
      const originalDestroyer = shutdownModule.PROVIDER_DESTROYERS.docker
      shutdownModule.PROVIDER_DESTROYERS.docker = async () => {}

      try {
        await instance.run()
        expect(logs).to.include('Removed auth token from token file.')
        expect(logs.some((line: string) => line.includes('from keychain'))).to.equal(false)
      } finally {
        shutdownModule.PROVIDER_DESTROYERS.docker = originalDestroyer
        sandbox.restore()
      }
    })

    it('names the token file for a deployment token removed from a file', async () => {
      const testAgentName = 'test-shutdown-deployment-token-file-' + Date.now()
      const instance = createCommandInstance(Shutdown, ['bb7590'], {force: true})
      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.warn = () => {}

      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      const spriteHash = keychainModule.keychain.hashToken('sprite-token')
      const dockerHash = keychainModule.keychain.hashToken('docker-token')
      const dockerRow = {
        id: 'bb7590',
        agent_name: testAgentName,
        provider: 'docker',
        deployment_url: 'http://localhost:8080',
        auth_token_hash: dockerHash,
      }
      const sprites = {
        id: 'd6b12f',
        agent_name: testAgentName,
        provider: 'sprites',
        deployment_url: 'https://sprite.example',
        auth_token_hash: spriteHash,
      }

      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').callsFake((sha: unknown) => sha === 'bb7590' ? dockerRow : null)
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([dockerRow, sprites])
      sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})
      sandbox.stub(sqliteModule.db, 'removeDeploymentBySha').callsFake(() => {})
      sandbox.stub(keychainModule.keychain, 'getToken').resolves('sprite-token')
      const deleteToken = sandbox.stub(keychainModule.keychain, 'deleteToken').resolves({
        removed: true,
        stores: ['keychain'],
      })
      keychainModule.keychain.deleteDeploymentToken.resolves({removed: true, stores: ['file']})

      const shutdownModule = require('../../../typescript/cast-cli/src/commands/shutdown')
      const originalDestroyer = shutdownModule.PROVIDER_DESTROYERS.docker
      shutdownModule.PROVIDER_DESTROYERS.docker = async () => {}

      try {
        await instance.run()
        expect(deleteToken.called).to.equal(false)
        expect(logs).to.include('Removed auth token for deployment bb7590 from token file.')
        expect(logs.some((line: string) => line.includes('from keychain'))).to.equal(false)
      } finally {
        shutdownModule.PROVIDER_DESTROYERS.docker = originalDestroyer
        sandbox.restore()
      }
    })

    it('should shut down one SHA and leave the other provider registered', async () => {
      const testAgentName = 'test-shutdown-two-providers-' + Date.now()
      const instance = createCommandInstance(Shutdown, ['d6b12f'], {force: true})
      let loggedMessage = ''
      instance.log = (msg: string) => {
        loggedMessage += msg + '\n'
      }
      instance.warn = () => {}

      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      const spriteToken = 'sprite-token'
      const spriteHash = keychainModule.keychain.hashToken(spriteToken)
      const microHash = keychainModule.keychain.hashToken('micro-token')
      const microvm = {
        id: 'd6b12f',
        agent_name: testAgentName,
        provider: 'microvm',
        deployment_url: 'https://micro.example',
        volume_id: 'vm-1',
        auth_token_hash: microHash,
      }
      const sprites = {
        id: 'bb7590',
        agent_name: testAgentName,
        provider: 'sprites',
        deployment_url: 'https://sprite.example',
        volume_id: 'sprite-vol',
        auth_token_hash: spriteHash,
      }

      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').callsFake((sha: unknown) => sha === 'd6b12f' ? microvm : null)
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([sprites, microvm])
      const removeAll = sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})
      const removeOne = sandbox.stub(sqliteModule.db, 'removeDeploymentBySha').callsFake(() => {})
      sandbox.stub(keychainModule.keychain, 'getToken').resolves(spriteToken)
      const deleteToken = sandbox.stub(keychainModule.keychain, 'deleteToken').resolves(true)

      const shutdownModule = require('../../../typescript/cast-cli/src/commands/shutdown')
      const originalDestroyer = shutdownModule.PROVIDER_DESTROYERS.microvm
      let destroyed: any = null
      shutdownModule.PROVIDER_DESTROYERS.microvm = async (_agentName: string, deployment: any) => {
        destroyed = deployment
      }

      try {
        await instance.run()
        expect(removeAll.called).to.equal(false)
        expect(removeOne.calledOnce).to.equal(true)
        expect(removeOne.calledWith('d6b12f')).to.equal(true)
        expect(deleteToken.called).to.equal(false)
        expect(destroyed?.id).to.equal('d6b12f')
        expect(loggedMessage).to.include("Deployment 'd6b12f'")
        expect(loggedMessage).to.include('Left the auth token in place')
      } finally {
        shutdownModule.PROVIDER_DESTROYERS.microvm = originalDestroyer
        sandbox.restore()
      }
    })

    it('should remove every row of a shared provider remote and leave other providers', async () => {
      const testAgentName = 'test-shutdown-shared-remote-' + Date.now()
      const instance = createCommandInstance(Shutdown, ['bb7590'], {force: true})
      instance.log = () => {}
      instance.warn = () => {}

      const older = {
        id: 'aa1111',
        agent_name: testAgentName,
        provider: 'sprites',
        deployment_url: 'https://sprite.example',
        volume_id: 'old-vol',
        auth_token_hash: 'old',
      }
      const sprites = {
        id: 'bb7590',
        agent_name: testAgentName,
        provider: 'sprites',
        deployment_url: 'https://sprite.example',
        volume_id: 'new-vol',
        auth_token_hash: 'new',
      }
      const microvm = {
        id: 'd6b12f',
        agent_name: testAgentName,
        provider: 'microvm',
        deployment_url: 'https://micro.example',
        volume_id: 'vm-1',
        auth_token_hash: 'micro',
      }

      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'getDeploymentBySha').callsFake((sha: unknown) => sha === 'bb7590' ? sprites : null)
      sandbox.stub(sqliteModule.db, 'listDeployments').returns([sprites, older, microvm])
      const removeAll = sandbox.stub(sqliteModule.db, 'removeAllDeployments').callsFake(() => {})
      const removed: string[] = []
      sandbox.stub(sqliteModule.db, 'removeDeploymentBySha').callsFake((sha: unknown) => {
        removed.push(String(sha))
      })

      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'getToken').resolves(null)
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves(true)

      const shutdownModule = require('../../../typescript/cast-cli/src/commands/shutdown')
      const originalDestroyer = shutdownModule.PROVIDER_DESTROYERS.sprites
      shutdownModule.PROVIDER_DESTROYERS.sprites = async () => {}

      try {
        await instance.run()
        expect(removeAll.called).to.equal(false)
        expect(removed).to.have.members(['bb7590', 'aa1111'])
        expect(removed).to.not.include('d6b12f')
      } finally {
        shutdownModule.PROVIDER_DESTROYERS.sprites = originalDestroyer
        sandbox.restore()
      }
    })
  })
})

describe('shutdown command - confirm method', () => {
  let Shutdown: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    Shutdown = await loadTestCommand('shutdown')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should have confirm method', () => {
    const instance = new Shutdown(['shutdown', 'test-agent'], {color: false})
    expect(typeof instance.confirm).to.equal('function')
  })

  it('should return true for "y" answer', async () => {
    const instance = new Shutdown(['shutdown', 'test-agent'], {color: false})

    // Mock readline
    const rl = {
      question: (q: string, cb: (answer: string) => void) => {
        cb('y')
      },
      close: () => {},
    }
    sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

    const result = await instance.confirm('Are you sure?')
    expect(result).to.be.true
  })

  it('should return true for "Y" answer', async () => {
    const instance = new Shutdown(['shutdown', 'test-agent'], {color: false})

    const rl = {
      question: (q: string, cb: (answer: string) => void) => {
        cb('Y')
      },
      close: () => {},
    }
    sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

    const result = await instance.confirm('Are you sure?')
    expect(result).to.be.true
  })

  it('should return false for "n" answer', async () => {
    const instance = new Shutdown(['shutdown', 'test-agent'], {color: false})

    const rl = {
      question: (q: string, cb: (answer: string) => void) => {
        cb('n')
      },
      close: () => {},
    }
    sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

    const result = await instance.confirm('Are you sure?')
    expect(result).to.be.false
  })

  it('should return false for empty answer', async () => {
    const instance = new Shutdown(['shutdown', 'test-agent'], {color: false})

    const rl = {
      question: (q: string, cb: (answer: string) => void) => {
        cb('')
      },
      close: () => {},
    }
    sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

    const result = await instance.confirm('Are you sure?')
    expect(result).to.be.false
  })

  it('should trim whitespace from input', async () => {
    const instance = new Shutdown(['shutdown', 'test-agent'], {color: false})

    const rl = {
      question: (q: string, cb: (answer: string) => void) => {
        cb('  y  ')
      },
      close: () => {},
    }
    sandbox.stub(require('readline'), 'createInterface').returns(rl as any)

    const result = await instance.confirm('Are you sure?')
    expect(result).to.be.true
  })
})

describe('shutdown command - force flag behavior', () => {
  let Shutdown: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    Shutdown = await loadTestCommand('shutdown')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    stubDeploymentTokenDelete(sandbox)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should skip confirmation when --force flag is set', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'], {force: true})
    let confirmCalled = false

    // Mock the confirm method
    instance.confirm = async () => {
      confirmCalled = true
      return false
    }

    // Mock deployment (new resolution pattern)
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalListDeployments = sqliteModule.db.listDeployments
    const originalGetDeploymentBySha = sqliteModule.db.getDeploymentBySha
    sqliteModule.db.listDeployments = () => [{
      id: 'sha123',
      agent_name: 'test-agent',
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly',
    }]
    sqliteModule.db.getDeploymentBySha = () => null

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db operations
    sqliteModule.db.removeAllDeployments = () => {}

    // Track log messages
    let loggedMessages: string[] = []
    instance.log = (msg: string) => {
      loggedMessages.push(msg)
    }

    await instance.run()

    // With --force, confirm should not be called
    expect(confirmCalled).to.be.false

    // Cleanup
    sqliteModule.db.listDeployments = originalListDeployments
    sqliteModule.db.getDeploymentBySha = originalGetDeploymentBySha
  })

  it('should prompt for confirmation when --force is not set', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'])
    let confirmCalled = false

    instance.confirm = async () => {
      confirmCalled = true
      return true
    }

    // Mock deployment (new resolution pattern)
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalListDeployments = sqliteModule.db.listDeployments
    const originalGetDeploymentBySha = sqliteModule.db.getDeploymentBySha
    sqliteModule.db.listDeployments = () => [{
      id: 'sha123',
      agent_name: 'test-agent',
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly',
    }]
    sqliteModule.db.getDeploymentBySha = () => null

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db operations
    sqliteModule.db.removeAllDeployments = () => {}

    // Track log messages
    instance.log = () => {}

    await instance.run()

    expect(confirmCalled).to.be.true

    // Cleanup
    sqliteModule.db.listDeployments = originalListDeployments
    sqliteModule.db.getDeploymentBySha = originalGetDeploymentBySha
  })

  it('should cancel shutdown when user declines confirmation', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'])
    let cancelled = false

    instance.confirm = async () => false
    instance.log = (msg: string) => {
      if (msg.includes('cancelled')) {
        cancelled = true
      }
    }

    // Mock deployment (new resolution pattern)
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalListDeployments = sqliteModule.db.listDeployments
    const originalGetDeploymentBySha = sqliteModule.db.getDeploymentBySha
    sqliteModule.db.listDeployments = () => [{
      id: 'sha123',
      agent_name: 'test-agent',
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly',
    }]
    sqliteModule.db.getDeploymentBySha = () => null

    await instance.run()

    expect(cancelled).to.be.true

    // Cleanup
    sqliteModule.db.listDeployments = originalListDeployments
    sqliteModule.db.getDeploymentBySha = originalGetDeploymentBySha
  })
})

describe('shutdown command - error handling', () => {
  let Shutdown: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    Shutdown = await loadTestCommand('shutdown')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    stubDeploymentTokenDelete(sandbox)
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('should warn when database removal fails', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'], {force: true})
    let warningMessage = ''

    instance.warn = (msg: string) => {
      warningMessage = msg
    }

    // Mock deployment (new resolution pattern)
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalListDeployments = sqliteModule.db.listDeployments
    const originalGetDeploymentBySha = sqliteModule.db.getDeploymentBySha
    sqliteModule.db.listDeployments = () => [{
      id: 'sha123',
      agent_name: 'test-agent',
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly',
    }]
    sqliteModule.db.getDeploymentBySha = () => null

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db removal to throw
    sqliteModule.db.removeAllDeployments = () => {
      throw new Error('Database error')
    }

    await instance.run()

    expect(warningMessage).to.include('Failed to update deployment records')

    // Cleanup
    sqliteModule.db.listDeployments = originalListDeployments
    sqliteModule.db.getDeploymentBySha = originalGetDeploymentBySha
  })

  it('should warn when keychain deletion fails', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'], {force: true})
    let warningMessage = ''

    instance.warn = (msg: string) => {
      warningMessage = msg
    }

    // Mock deployment (new resolution pattern)
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalListDeployments = sqliteModule.db.listDeployments
    const originalGetDeploymentBySha = sqliteModule.db.getDeploymentBySha
    sqliteModule.db.listDeployments = () => [{
      id: 'sha123',
      agent_name: 'test-agent',
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly',
    }]
    sqliteModule.db.getDeploymentBySha = () => null

    // Mock keychain to throw
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    const originalDeleteToken = keychainModule.keychain.deleteToken
    keychainModule.keychain.deleteToken = async () => {
      throw new Error('Keychain error')
    }

    // Mock db operations
    sqliteModule.db.removeAllDeployments = () => {}

    await instance.run()

    expect(warningMessage).to.include('Failed to remove auth token')

    // Cleanup
    sqliteModule.db.listDeployments = originalListDeployments
    sqliteModule.db.getDeploymentBySha = originalGetDeploymentBySha
    keychainModule.keychain.deleteToken = originalDeleteToken
  })

  it('should warn when destroyer fails but continue cleanup', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'], {force: true})
    let warningMessage = ''

    instance.warn = (msg: string) => {
      if (msg.includes('Failed to destroy')) {
        warningMessage = msg
      }
    }

    // Mock deployment (new resolution pattern)
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalListDeployments = sqliteModule.db.listDeployments
    const originalGetDeploymentBySha = sqliteModule.db.getDeploymentBySha
    sqliteModule.db.listDeployments = () => [{
      id: 'sha123',
      agent_name: 'test-agent',
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly',
    }]
    sqliteModule.db.getDeploymentBySha = () => null

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db operations
    sqliteModule.db.removeAllDeployments = () => {}

    // Mock deploy module to throw
    const deployModule = require('../../../typescript/cast-cli/src/commands/shutdown')
    const originalDestroyer = deployModule.PROVIDER_DESTROYERS['fly']
    deployModule.PROVIDER_DESTROYERS['fly'] = async () => {
      throw new Error('Destroyer failed')
    }

    await instance.run()

    expect(warningMessage).to.include('Failed to destroy')

    // Cleanup
    sqliteModule.db.listDeployments = originalListDeployments
    sqliteModule.db.getDeploymentBySha = originalGetDeploymentBySha
    deployModule.PROVIDER_DESTROYERS['fly'] = originalDestroyer
  })
})

describe('shutdown command - provider destroyers', () => {
  it('should have destroyer for docker provider', () => {
    const destroyers = require('../../../typescript/cast-cli/src/commands/shutdown').PROVIDER_DESTROYERS
    expect(destroyers).to.have.property('docker')
    expect(typeof destroyers.docker).to.equal('function')
  })

  it('should have destroyer for fly provider', () => {
    const destroyers = require('../../../typescript/cast-cli/src/commands/shutdown').PROVIDER_DESTROYERS
    expect(destroyers).to.have.property('fly')
    expect(typeof destroyers.fly).to.equal('function')
  })

  it('should have destroyer for railway provider', () => {
    const destroyers = require('../../../typescript/cast-cli/src/commands/shutdown').PROVIDER_DESTROYERS
    expect(destroyers).to.have.property('railway')
    expect(typeof destroyers.railway).to.equal('function')
  })

  it('should have destroyer for digitalocean provider', () => {
    const destroyers = require('../../../typescript/cast-cli/src/commands/shutdown').PROVIDER_DESTROYERS
    expect(destroyers).to.have.property('digitalocean')
    expect(typeof destroyers.digitalocean).to.equal('function')
  })

  it('should have destroyer for sprites provider', () => {
    const destroyers = require('../../../typescript/cast-cli/src/commands/shutdown').PROVIDER_DESTROYERS
    expect(destroyers).to.have.property('sprites')
    expect(typeof destroyers.sprites).to.equal('function')
  })
})

describe('shutdown token removal message', () => {
  const {shutdownTokenRemovalMessage} = require('../../../typescript/cast-cli/src/commands/shutdown')

  it('names the keychain, the token file, or both', () => {
    expect(shutdownTokenRemovalMessage('agent', ['keychain'], 'bb7590')).to.equal(
      'Removed auth token from keychain.',
    )
    expect(shutdownTokenRemovalMessage('agent', ['file'], 'bb7590')).to.equal(
      'Removed auth token from token file.',
    )
    expect(shutdownTokenRemovalMessage('agent', ['file', 'keychain'], 'bb7590')).to.equal(
      'Removed auth token from keychain and token file.',
    )
    expect(shutdownTokenRemovalMessage('deployment', ['file'], 'bb7590')).to.equal(
      'Removed auth token for deployment bb7590 from token file.',
    )
    expect(shutdownTokenRemovalMessage('deployment', [], 'bb7590')).to.equal(
      'Removed auth token for deployment bb7590 from keychain.',
    )
  })
})