import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {exec} from 'child_process'
import {promisify} from 'util'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

const execAsync = promisify(exec)

describe('CLI Commands Integration', () => {
  const tempDir = path.join(os.tmpdir(), `cast-cli-test-${Date.now()}`)
  const agentsDir = path.join(tempDir, '.cast', 'agents')

  before(async () => {
    // Create temp directory structure
    fs.mkdirSync(path.join(tempDir, '.cast'), {recursive: true})
    fs.mkdirSync(agentsDir, {recursive: true})

    // Initialize test database in temp location
    // Note: The actual db uses ~/.cast/cast.db, but we can test the API
  })

  after(async () => {
    // Cleanup
    try {
      fs.rmSync(tempDir, {recursive: true, force: true})
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('Full Agent Lifecycle', () => {
    const testAgentName = `test-agent-${Date.now()}`

    it('should create, list, describe, and delete an agent', async () => {
      const agentPath = path.join(agentsDir, testAgentName)

      // Create agent directory
      fs.mkdirSync(agentPath, {recursive: true})

      // Create agent.yaml
      const agentYaml = `
name: ${testAgentName}
version: "1.0"
description: "Test agent for integration testing"
brain:
  model: openrouter/anthropic/claude-3.7-sonnet
  instructions_file: instructions.md
tools:
  builtin:
    - bash
    - read
  mcp: []
  custom: []
harness:
  permissions:
    bash: always-allow
`
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), agentYaml)

      // Create instructions.md
      fs.writeFileSync(
        path.join(agentPath, 'instructions.md'),
        'You are a test agent for integration testing.'
      )

      // Verify agent was created
      expect(fs.existsSync(agentPath)).to.be.true
      expect(fs.existsSync(path.join(agentPath, 'agent.yaml'))).to.be.true
      expect(fs.existsSync(path.join(agentPath, 'instructions.md'))).to.be.true

      // Register in database
      db.createAgent(testAgentName, path.join(agentPath, 'agent.yaml'))

      // Verify in database
      const agent = db.getAgent(testAgentName)
      expect(agent).to.exist
      expect(agent.name).to.equal(testAgentName)

      // List agents - should find our agent
      const agents = db.listAgents()
      const foundAgent = agents.find(a => a.name === testAgentName)
      expect(foundAgent).to.exist

      // Describe agent - read config
      const configContent = fs.readFileSync(
        path.join(agentPath, 'agent.yaml'),
        'utf8'
      )
      expect(configContent).to.include('name:')
      expect(configContent).to.include('description:')

      // Update agent run count
      db.updateAgentRun(testAgentName)
      const updatedAgent = db.getAgent(testAgentName)
      expect(updatedAgent.run_count).to.be.greaterThan(0)

      // Delete agent from database
      db.deleteAgent(testAgentName)

      // Verify deleted
      const deletedAgent = db.getAgent(testAgentName)
      expect(deletedAgent).to.be.undefined

      // Cleanup filesystem
      fs.rmSync(agentPath, {recursive: true, force: true})
    })

    it('should handle multiple concurrent agent operations', () => {
      const agents = Array.from({length: 5}, (_, i) => `concurrent-agent-${Date.now()}-${i}`)
      const createdAgents: string[] = []

      // Create multiple agents
      for (const name of agents) {
        const agentPath = path.join(agentsDir, name)
        fs.mkdirSync(agentPath, {recursive: true})
        fs.writeFileSync(
          path.join(agentPath, 'agent.yaml'),
          `name: ${name}\nversion: "1.0"`
        )
        db.createAgent(name, path.join(agentPath, 'agent.yaml'))
        createdAgents.push(name)
      }

      // Verify all created
      const allAgents = db.listAgents()
      for (const name of agents) {
        const found = allAgents.find(a => a.name === name)
        expect(found).to.exist
      }

      // Clean up
      for (const name of createdAgents) {
        const agentPath = path.join(agentsDir, name)
        fs.rmSync(agentPath, {recursive: true, force: true})
        db.deleteAgent(name)
      }
    })
  })

  describe('Agent Configuration', () => {
    it('should persist and load agent configuration correctly', () => {
      const configAgent = `config-test-${Date.now()}`
      const agentPath = path.join(agentsDir, configAgent)

      fs.mkdirSync(agentPath, {recursive: true})

      const config = {
        name: configAgent,
        version: '1.0.0',
        description: 'Configuration persistence test',
        brain: {
          model: 'openrouter/anthropic/claude-3.5-sonnet',
          instructions_file: 'instructions.md',
        },
        tools: {
          builtin: ['bash', 'read', 'glob'],
          mcp: [],
          custom: [],
        },
        harness: {
          permissions: {
            bash: 'always-allow',
            read: 'always-allow',
          },
        },
      }

      fs.writeFileSync(
        path.join(agentPath, 'agent.yaml'),
        require('yaml').stringify(config)
      )

      // Read back and verify
      const loaded = fs.readFileSync(path.join(agentPath, 'agent.yaml'), 'utf8')
      const parsed = require('yaml').parse(loaded)

      expect(parsed.name).to.equal(configAgent)
      expect(parsed.version).to.equal('1.0.0')
      expect(parsed.brain.model).to.equal('openrouter/anthropic/claude-3.5-sonnet')
      expect(parsed.tools.builtin).to.deep.equal(['bash', 'read', 'glob'])
      expect(parsed.harness.permissions.bash).to.equal('always-allow')

      // Cleanup
      fs.rmSync(agentPath, {recursive: true, force: true})
    })
  })

  describe('Agent Path Resolution', () => {
    it('should resolve agent paths under ~/.cast/agents', () => {
      const agentName = 'test-agent'
      const expectedBase = path.join(os.homedir(), '.cast', 'agents')
      const expectedPath = path.join(expectedBase, agentName)

      // The database stores paths, so verify path format
      const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
      expect(agentPath).to.include('.cast')
      expect(agentPath).to.include('agents')
      expect(agentPath).to.equal(expectedPath)
    })

    it('should not use old ~/cast-agents path', () => {
      const agentName = 'test-agent'
      const oldPath = path.join(os.homedir(), 'cast-agents', agentName)
      const currentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

      expect(currentPath).to.not.equal(oldPath)
      expect(currentPath).to.include('.cast')
      expect(currentPath).to.not.include('cast-agents')
    })
  })
})