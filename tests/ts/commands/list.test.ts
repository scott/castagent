import {expect} from 'chai'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as sinon from 'sinon'

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

describe('list command', () => {
  let List: any

  before(async () => {
    List = await loadTestCommand('list')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(List.description).to.equal('List all agents')
    })

    it('should have no required arguments', () => {
      expect(List.args).to.deep.equal({})
    })

    it('should have examples', () => {
      expect(List.examples).to.not.be.empty
    })
  })

  describe('command behavior', () => {
    const sandbox = sinon.createSandbox()
    const tempAgentsDir = path.join(os.homedir(), '.cast', 'agents')
    const testAgentName = 'test-list-agent-' + Date.now()

    afterEach(() => {
      sandbox.restore()
      // Clean up test agent directory if it exists
      const agentPath = path.join(tempAgentsDir, testAgentName)
      if (fs.existsSync(agentPath)) {
        fs.rmSync(agentPath, {recursive: true, force: true})
      }
    })

    it('should output agent list when agents exist', async () => {
      // Create a test agent directory
      const agentPath = path.join(tempAgentsDir, testAgentName)
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      // Create a mock command instance
      const instance = Object.create(List.prototype)
      instance.log = sandbox.stub()
      instance.warn = sandbox.stub()
      instance.error = sandbox.stub()
      instance.parse = sandbox.stub().resolves({})
      instance.config = {runHook: sandbox.stub().resolves([])}

      // Mock db
      const dbModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(dbModule.db, 'listAgents').returns([{name: testAgentName}])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getLocalAgent').returns(null)

      await List.prototype.run.call(instance)

      // Check that logs contain expected output
      expect(instance.log.called).to.be.true

      // Should have logged agents header
      const logCalls = instance.log.getCalls().map((call: any) => String(call.args[0] || ''))
      const hasAgentsHeader = logCalls.some((log: string) => log.includes('Agents in ~/.cast/agents'))
      expect(hasAgentsHeader).to.be.true
    })

    it('should show deployment status for deployed agents', async () => {
      // Create a mock command instance
      const instance = Object.create(List.prototype)
      instance.log = sandbox.stub()
      instance.warn = sandbox.stub()
      instance.error = sandbox.stub()
      instance.parse = sandbox.stub().resolves({})
      instance.config = {runHook: sandbox.stub().resolves([])}

      // Mock db
      const dbModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(dbModule.db, 'listAgents').returns([{name: testAgentName}])
      sandbox.stub(dbModule.db, 'getDeployment').returns({
        deployment_url: 'https://example.com',
        provider: 'fly'
      })
      sandbox.stub(dbModule.db, 'getLocalAgent').returns(null)
      sandbox.stub(dbModule.db, 'getDeployedVersion').returns(3)

      await List.prototype.run.call(instance)

      const logCalls = instance.log.getCalls().map((call: any) => String(call.args[0] || ''))
      const hasDeployedStatus = logCalls.some((log: string) => log.includes('[deployed: fly, v3]'))
      expect(hasDeployedStatus).to.be.true
    })

    it('should show local running status for active agents', async () => {
      // Create a mock command instance
      const instance = Object.create(List.prototype)
      instance.log = sandbox.stub()
      instance.warn = sandbox.stub()
      instance.error = sandbox.stub()
      instance.parse = sandbox.stub().resolves({})
      instance.config = {runHook: sandbox.stub().resolves([])}

      // Mock db
      const dbModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(dbModule.db, 'listAgents').returns([{name: testAgentName}])
      sandbox.stub(dbModule.db, 'getDeployment').returns(null)
      sandbox.stub(dbModule.db, 'getLocalAgent').returns({port: 8080})

      await List.prototype.run.call(instance)

      const logCalls = instance.log.getCalls().map((call: any) => String(call.args[0] || ''))
      const hasLocalStatus = logCalls.some((log: string) => log.includes('[local: running on port 8080]'))
      expect(hasLocalStatus).to.be.true
    })

    it('should display help text for next steps', async () => {
      // Create a mock command instance
      const instance = Object.create(List.prototype)
      instance.log = sandbox.stub()
      instance.warn = sandbox.stub()
      instance.error = sandbox.stub()
      instance.parse = sandbox.stub().resolves({})
      instance.config = {runHook: sandbox.stub().resolves([])}

      // Mock db - empty state
      const dbModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sandbox.stub(dbModule.db, 'listAgents').returns([])

      await List.prototype.run.call(instance)

      const logCalls = instance.log.getCalls().map((call: any) => String(call.args[0] || ''))
      const hasHelpText = logCalls.some((log: string) => log.includes('cast dev'))
      expect(hasHelpText).to.be.true
    })
  })
})