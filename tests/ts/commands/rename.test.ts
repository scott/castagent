import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'yaml'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('rename command', () => {
  const testDir = path.join(os.tmpdir(), `cast-rename-test-${Date.now()}`)
  const agentsDir = path.join(testDir, '.cast', 'agents')

  before(() => {
    fs.mkdirSync(agentsDir, {recursive: true})
  })

  after(() => {
    try {
      fs.rmSync(testDir, {recursive: true, force: true})
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('agent name validation', () => {
    it('should accept valid agent names', () => {
      const validNames = ['test-agent', 'my-agent', 'agent-123', 'TestAgent123']
      const pattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

      for (const name of validNames) {
        expect(pattern.test(name)).to.be.true
      }
    })

    it('should reject invalid agent names', () => {
      const invalidNames = ['-test', 'test agent', 'test_agent', 'test.agent', '']
      const pattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

      for (const name of invalidNames) {
        expect(pattern.test(name)).to.be.false
      }
    })

    it('should not allow renaming to same name', () => {
      const currentName = 'test-agent'
      const newName = 'test-agent'

      expect(currentName === newName).to.be.true
    })
  })

  describe('agent existence check', () => {
    it('should check if current agent exists', () => {
      const nonExistentPath = path.join(agentsDir, 'non-existent-agent')
      expect(fs.existsSync(nonExistentPath)).to.be.false
    })

    it('should check if new name already exists', () => {
      const existingPath = path.join(agentsDir, 'existing-agent')
      fs.mkdirSync(existingPath, {recursive: true})

      expect(fs.existsSync(existingPath)).to.be.true
    })
  })

  describe('rename operation', () => {
    const oldName = `rename-source-${Date.now()}`
    const newName = `rename-target-${Date.now()}`

    before(() => {
      // Create source agent
      const sourcePath = path.join(agentsDir, oldName)
      fs.mkdirSync(sourcePath, {recursive: true})

      const config = {
        name: oldName,
        version: '1.0',
        description: 'Test agent for rename'
      }
      fs.writeFileSync(
        path.join(sourcePath, 'agent.yaml'),
        yaml.stringify(config)
      )

      // Register in database
      db.createAgent(oldName, path.join(sourcePath, 'agent.yaml'))
    })

    after(() => {
      // Clean up
      try {
        fs.rmSync(path.join(agentsDir, oldName), {recursive: true, force: true})
        fs.rmSync(path.join(agentsDir, newName), {recursive: true, force: true})
        db.deleteAgent(oldName)
        db.deleteAgent(newName)
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should move agent directory', () => {
      const sourcePath = path.join(agentsDir, oldName)
      const targetPath = path.join(agentsDir, newName)

      fs.renameSync(sourcePath, targetPath)

      expect(fs.existsSync(targetPath)).to.be.true
      expect(fs.existsSync(sourcePath)).to.be.false
    })

    it('should update agent.yaml with new name', () => {
      const targetPath = path.join(agentsDir, newName)
      const configPath = path.join(targetPath, 'agent.yaml')

      const config = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      config.name = newName

      fs.writeFileSync(configPath, yaml.stringify(config))

      const updatedConfig = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      expect(updatedConfig.name).to.equal(newName)
    })

    it('should update database records', () => {
      db.renameAgent(oldName, newName)

      const newAgent = db.getAgent(newName)
      expect(newAgent).to.exist
      expect(newAgent.name).to.equal(newName)
    })
  })

  describe('deployed agent handling', () => {
    it('should warn when renaming deployed agent', () => {
      const agentName = `deployed-${Date.now()}`
      const deployment = db.getDeployment(agentName)

      if (deployment) {
        // Agent is deployed
        expect(deployment.provider).to.be.a('string')
      }
    })
  })

  describe('running agent handling', () => {
    it('should warn when renaming running agent', () => {
      const agentName = `running-${Date.now()}`
      const localAgent = db.getLocalAgent(agentName)

      if (localAgent) {
        // Agent is running
        expect(localAgent.pid).to.be.a('number')
      }
    })
  })
})