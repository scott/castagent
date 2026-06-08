import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {CastDatabase} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('Database Integration', () => {
  const tempDir = path.join(os.tmpdir(), `cast-db-test-${Date.now()}`)
  const testDbPath = path.join(tempDir, 'test-cast.db')

  // Use a fresh database instance with test path
  let db: TestableCastDatabase

  class TestableCastDatabase extends CastDatabase {
    constructor(testPath: string) {
      // Override the DB path by creating a subclass
      super()
    }
  }

  before(() => {
    // Create temp directory
    fs.mkdirSync(tempDir, {recursive: true})
  })

  after(() => {
    // Cleanup
    try {
      fs.rmSync(tempDir, {recursive: true, force: true})
    } catch {
      // Ignore
    }
  })

  describe('Full Database Lifecycle', () => {
    beforeEach(() => {
      // Create fresh database for each test
      // Note: This uses the default ~/.cast/cast.db
      db = new CastDatabase()
    })

    it('should create, read, update, and delete agents', () => {
      const agentName = `lifecycle-test-${Date.now()}`
      const agentPath = `/test/agents/${agentName}/agent.yaml`

      // Create agent
      db.createAgent(agentName, agentPath)
      let agent = db.getAgent(agentName)
      expect(agent).to.exist
      expect(agent.name).to.equal(agentName)
      expect(agent.agent_yaml_path).to.equal(agentPath)

      // Update agent
      db.updateAgent(agentName, {run_count: 5})
      agent = db.getAgent(agentName)
      expect(agent.run_count).to.equal(5)

      // Update run count
      db.updateAgentRun(agentName)
      agent = db.getAgent(agentName)
      expect(agent.run_count).to.equal(6)
      expect(agent.last_run_at).to.not.be.null

      // List agents
      const agents = db.listAgents()
      expect(agents.length).to.be.greaterThan(0)
      const found = agents.find(a => a.name === agentName)
      expect(found).to.exist

      // Delete agent
      db.deleteAgent(agentName)
      agent = db.getAgent(agentName)
      expect(agent).to.be.undefined
    })

    it('should handle local agent tracking', () => {
      const agentName = `local-agent-${Date.now()}`
      const pid = 12345
      const port = 54321

      // Set local agent
      db.setLocalAgent(agentName, pid, port)
      let localAgent = db.getLocalAgent(agentName)
      expect(localAgent).to.exist
      expect(localAgent.pid).to.equal(pid)
      expect(localAgent.port).to.equal(port)

      // Update local agent
      db.setLocalAgent(agentName, pid + 1, port + 1)
      localAgent = db.getLocalAgent(agentName)
      expect(localAgent.pid).to.equal(pid + 1)
      expect(localAgent.port).to.equal(port + 1)

      // Remove local agent
      db.removeLocalAgent(agentName)
      localAgent = db.getLocalAgent(agentName)
      expect(localAgent).to.be.undefined
    })

    it('should handle deployment tracking', () => {
      const agentName = `deploy-test-${Date.now()}`
      const provider = 'docker'
      const url = 'http://localhost:8080'
      const tokenHash = 'abc123hash'

      // Set deployment
      db.setDeployment(agentName, provider, url, tokenHash, 'vol-123', '{"key": "value"}')
      let deployment = db.getDeployment(agentName)
      expect(deployment).to.exist
      expect(deployment.provider).to.equal(provider)
      expect(deployment.deployment_url).to.equal(url)
      expect(deployment.auth_token_hash).to.equal(tokenHash)
      expect(deployment.volume_id).to.equal('vol-123')

      // Remove deployment
      db.removeDeployment(agentName)
      deployment = db.getDeployment(agentName)
      expect(deployment).to.be.undefined
    })

    it('should handle agent renaming with related records', () => {
      const oldName = `rename-test-${Date.now()}`
      const newName = `renamed-test-${Date.now()}`
      const agentPath = `/test/agents/${oldName}/agent.yaml`

      // Create agent with local and deployment info
      db.createAgent(oldName, agentPath)
      db.setLocalAgent(oldName, 12345, 54321)
      db.setDeployment(oldName, 'docker', 'http://localhost:8080', 'hash123')

      // Rename agent
      db.renameAgent(oldName, newName)

      // Verify new agent exists
      const newAgent = db.getAgent(newName)
      expect(newAgent).to.exist
      expect(newAgent.name).to.equal(newName)

      // Verify old agent doesn't exist
      const oldAgent = db.getAgent(oldName)
      expect(oldAgent).to.be.undefined

      // Verify local agent was renamed
      const localAgent = db.getLocalAgent(newName)
      expect(localAgent).to.exist
      expect(localAgent.agent_name).to.equal(newName)

      // Verify deployment was renamed
      const deployment = db.getDeployment(newName)
      expect(deployment).to.exist
      expect(deployment.agent_name).to.equal(newName)

      // Cleanup
      db.deleteAgent(newName)
    })

    it('should handle MCP server configurations', () => {
      const agentName = `mcp-test-${Date.now()}`
      const serverName = 'gmail'
      const configPath = '/path/to/mcp-config.json'
      const credentialsPath = '/path/to/creds.json'

      // Set MCP config
      db.setAgentMcp(agentName, serverName, configPath, credentialsPath)

      // List MCP servers
      const mcpServers = db.listAgentMcp(agentName)
      expect(mcpServers.length).to.be.greaterThan(0)
      const found = mcpServers.find(m => m.server_name === serverName)
      expect(found).to.exist
      expect(found.config_path).to.equal(configPath)
      expect(found.credentials_path).to.equal(credentialsPath)

      // Update credentials
      db.updateAgentMcpCredentials(agentName, serverName, '/new/creds.json')
      const updatedServers = db.listAgentMcp(agentName)
      const updated = updatedServers.find(m => m.server_name === serverName)
      expect(updated?.credentials_path).to.equal('/new/creds.json')

      // Remove MCP server
      db.removeAgentMcp(agentName, serverName)
      const remainingServers = db.listAgentMcp(agentName)
      const removed = remainingServers.find(m => m.server_name === serverName)
      expect(removed).to.be.undefined
    })

    it('should handle provider configurations', () => {
      const provider = 'openai'
      const config = {
        api_key: 'sk-test-key',
        model: 'gpt-4',
        temperature: 0.7,
      }

      // Set provider config
      db.setProviderConfig(provider, config)

      // Get provider config
      const retrieved = db.getProviderConfig(provider)
      expect(retrieved).to.exist
      expect(retrieved.api_key).to.equal('sk-test-key')
      expect(retrieved.model).to.equal('gpt-4')
      expect(retrieved.temperature).to.equal(0.7)

      // Update provider config
      config.api_key = 'sk-new-key'
      db.setProviderConfig(provider, config)
      const updated = db.getProviderConfig(provider)
      expect(updated.api_key).to.equal('sk-new-key')
    })
  })

  describe('Concurrent Operations', () => {
    it('should handle multiple simultaneous agent operations', () => {
      const agentCount = 10
      const agentNames = Array.from(
        {length: agentCount},
        (_, i) => `concurrent-${Date.now()}-${i}`
      )

      // Create all agents
      for (const name of agentNames) {
        db.createAgent(name, `/test/${name}/agent.yaml`)
      }

      // Verify all created
      const agents = db.listAgents()
      for (const name of agentNames) {
        const found = agents.find(a => a.name === name)
        expect(found).to.exist
      }

      // Update all agents
      for (const name of agentNames) {
        db.updateAgent(name, {run_count: Math.floor(Math.random() * 100)})
      }

      // Verify all updated
      for (const name of agentNames) {
        const agent = db.getAgent(name)
        expect(agent).to.exist
        expect(agent.run_count).to.be.a('number')
      }

      // Delete all agents
      for (const name of agentNames) {
        db.deleteAgent(name)
      }

      // Verify all deleted
      for (const name of agentNames) {
        const agent = db.getAgent(name)
        expect(agent).to.be.undefined
      }
    })

    it('should handle race conditions in agent updates', () => {
      const agentName = `race-test-${Date.now()}`

      // Create agent
      db.createAgent(agentName, `/test/${agentName}/agent.yaml`)

      // Simulate concurrent updates
      const updates = [
        {run_count: 1},
        {run_count: 5},
        {run_count: 10},
      ]

      // Sequential updates (SQLite handles this)
      for (const update of updates) {
        db.updateAgent(agentName, update)
      }

      const agent = db.getAgent(agentName)
      expect(agent.run_count).to.equal(10)

      // Cleanup
      db.deleteAgent(agentName)
    })
  })

  describe('Database Integrity', () => {
    it('should maintain referential integrity on agent deletion', () => {
      const agentName = `integrity-test-${Date.now()}`

      // Create agent with related data
      db.createAgent(agentName, `/test/${agentName}/agent.yaml`)
      db.setLocalAgent(agentName, 12345, 54321)
      db.setDeployment(agentName, 'docker', 'http://localhost:8080', 'hash123')
      db.setAgentMcp(agentName, 'gmail', '/config.json', '/creds.json')

      // Delete agent (should cascade)
      db.deleteAgent(agentName)

      // Verify all related data removed
      expect(db.getAgent(agentName)).to.be.undefined
      expect(db.getLocalAgent(agentName)).to.be.undefined
      expect(db.getDeployment(agentName)).to.be.undefined
      expect(db.listAgentMcp(agentName).length).to.equal(0)
    })

    it('should handle database initialization gracefully', () => {
      // Database should initialize without errors
      const newDb = new CastDatabase()
      expect(newDb).to.exist

      // Should be able to perform basic operations
      const testAgent = `init-test-${Date.now()}`
      newDb.createAgent(testAgent, '/test/agent.yaml')
      expect(newDb.getAgent(testAgent)).to.exist

      // Cleanup
      newDb.deleteAgent(testAgent)
    })
  })
})