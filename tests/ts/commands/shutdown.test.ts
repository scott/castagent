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
      expect(Shutdown.args.agent.description).to.equal('Agent name')
      expect(Shutdown.args.agent.required).to.be.true
    })

    it('should have force flag', () => {
      expect(Shutdown.flags.force).to.exist
      expect(Shutdown.flags.force.description).to.equal('Skip confirmation prompt')
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

      // Mock getDeployment to return null
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'getDeployment').returns(null)

      try {
        await instance.run()
        expect(loggedMessage).to.include('not currently deployed')
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

      // Mock deployment exists
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'getDeployment').returns({
        deployment_url: 'https://fly.example.com/app',
        provider: 'fly'
      })

      // Mock keychain
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves()

      // Mock db operations
      sandbox.stub(sqliteModule.db, 'removeDeployment').callsFake(() => {})

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
      sandbox.stub(sqliteModule.db, 'getDeployment').returns({
        deployment_url: 'https://custom.example.com',
        provider: 'unknown-provider'
      })

      // Mock keychain
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves()

      // Mock db operations
      sandbox.stub(sqliteModule.db, 'removeDeployment').callsFake(() => {})

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
        if (msg.includes('Removed deployment')) {
          dbMessage = msg
        }
      }

      // Mock deployment
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(sqliteModule.db, 'getDeployment').returns({
        deployment_url: 'https://fly.example.com/app',
        provider: 'fly'
      })

      // Track removeDeployment call
      sandbox.stub(sqliteModule.db, 'removeDeployment').callsFake(() => {})

      // Mock keychain
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves()

      try {
        await instance.run()
        expect(sqliteModule.db.removeDeployment.calledOnce).to.be.true
        expect(dbMessage).to.include('Removed deployment')
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
      sandbox.stub(sqliteModule.db, 'getDeployment').returns({
        deployment_url: 'https://fly.example.com/app',
        provider: 'fly'
      })

      // Track keychain call
      const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
      sandbox.stub(keychainModule.keychain, 'deleteToken').resolves()

      // Mock db operations
      sandbox.stub(sqliteModule.db, 'removeDeployment').callsFake(() => {})

      try {
        await instance.run()
        expect(keychainModule.keychain.deleteToken.calledOnce).to.be.true
        expect(keychainMessage).to.include('auth token')
      } finally {
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

    // Mock deployment
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalGetDeployment = sqliteModule.db.getDeployment
    sqliteModule.db.getDeployment = () => ({
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly'
    })

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db operations
    sqliteModule.db.removeDeployment = () => {}

    // Track log messages
    let loggedMessages: string[] = []
    instance.log = (msg: string) => {
      loggedMessages.push(msg)
    }

    await instance.run()

    // With --force, confirm should not be called
    expect(confirmCalled).to.be.false

    // Cleanup
    sqliteModule.db.getDeployment = originalGetDeployment
  })

  it('should prompt for confirmation when --force is not set', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'])
    let confirmCalled = false

    instance.confirm = async () => {
      confirmCalled = true
      return true
    }

    // Mock deployment
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalGetDeployment = sqliteModule.db.getDeployment
    sqliteModule.db.getDeployment = () => ({
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly'
    })

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db operations
    sqliteModule.db.removeDeployment = () => {}

    // Track log messages
    instance.log = () => {}

    await instance.run()

    expect(confirmCalled).to.be.true

    // Cleanup
    sqliteModule.db.getDeployment = originalGetDeployment
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

    // Mock deployment
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalGetDeployment = sqliteModule.db.getDeployment
    sqliteModule.db.getDeployment = () => ({
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly'
    })

    await instance.run()

    expect(cancelled).to.be.true

    // Cleanup
    sqliteModule.db.getDeployment = originalGetDeployment
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

    // Mock deployment
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalGetDeployment = sqliteModule.db.getDeployment
    sqliteModule.db.getDeployment = () => ({
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly'
    })

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db removal to throw
    const originalRemoveDeployment = sqliteModule.db.removeDeployment
    sqliteModule.db.removeDeployment = () => {
      throw new Error('Database error')
    }

    await instance.run()

    expect(warningMessage).to.include('Failed to remove deployment record')

    // Cleanup
    sqliteModule.db.getDeployment = originalGetDeployment
    sqliteModule.db.removeDeployment = originalRemoveDeployment
  })

  it('should warn when keychain deletion fails', async () => {
    const instance = createCommandInstance(Shutdown, ['test-agent'], {force: true})
    let warningMessage = ''

    instance.warn = (msg: string) => {
      warningMessage = msg
    }

    // Mock deployment
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalGetDeployment = sqliteModule.db.getDeployment
    sqliteModule.db.getDeployment = () => ({
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly'
    })

    // Mock keychain to throw
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    const originalDeleteToken = keychainModule.keychain.deleteToken
    keychainModule.keychain.deleteToken = async () => {
      throw new Error('Keychain error')
    }

    // Mock db operations
    sqliteModule.db.removeDeployment = () => {}

    await instance.run()

    expect(warningMessage).to.include('Failed to remove auth token')

    // Cleanup
    sqliteModule.db.getDeployment = originalGetDeployment
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

    // Mock deployment
    const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
    const originalGetDeployment = sqliteModule.db.getDeployment
    sqliteModule.db.getDeployment = () => ({
      deployment_url: 'https://fly.example.com/app',
      provider: 'fly'
    })

    // Mock keychain
    const keychainModule = require('../../../typescript/cast-cli/src/lib/keychain')
    keychainModule.keychain.deleteToken = async () => {}

    // Mock db operations
    sqliteModule.db.removeDeployment = () => {}

    // Mock deploy module to throw
    const deployModule = require('../../../typescript/cast-cli/src/commands/shutdown')
    const originalDestroyer = deployModule.PROVIDER_DESTROYERS['fly']
    deployModule.PROVIDER_DESTROYERS['fly'] = async () => {
      throw new Error('Destroyer failed')
    }

    await instance.run()

    expect(warningMessage).to.include('Failed to destroy')

    // Cleanup
    sqliteModule.db.getDeployment = originalGetDeployment
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