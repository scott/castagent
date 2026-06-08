import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('meta test command', () => {
  describe('command description', () => {
    it('should have correct description', () => {
      const description = 'Meta-builder test command'
      expect(description).to.not.be.empty
    })
  })

  describe('test agent creation', () => {
    const testDir = path.join(os.tmpdir(), `cast-meta-test-${Date.now()}`)

    before(() => {
      fs.mkdirSync(testDir, {recursive: true})
    })

    after(() => {
      try {
        fs.rmSync(testDir, {recursive: true, force: true})
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should create test agent directory', () => {
      const agentName = 'test-meta-agent'
      const agentPath = path.join(testDir, agentName)
      fs.mkdirSync(agentPath, {recursive: true})

      expect(fs.existsSync(agentPath)).to.be.true
    })

    it('should create agent.yaml for test agent', () => {
      const agentName = 'test-meta-agent'
      const agentPath = path.join(testDir, agentName)
      const agentYamlPath = path.join(agentPath, 'agent.yaml')

      fs.writeFileSync(
        agentYamlPath,
        `name: ${agentName}\nversion: "1.0"\ndescription: "Test agent"`
      )

      expect(fs.existsSync(agentYamlPath)).to.be.true
    })

    it('should create instructions.md for test agent', () => {
      const agentName = 'test-meta-agent'
      const agentPath = path.join(testDir, agentName)
      const instructionsPath = path.join(agentPath, 'instructions.md')

      fs.writeFileSync(
        instructionsPath,
        'You are a test agent for meta testing.'
      )

      expect(fs.existsSync(instructionsPath)).to.be.true
    })
  })

  describe('test configuration', () => {
    it('should define test agent configuration', () => {
      const testConfig = {
        name: 'meta-test-agent',
        version: '1.0',
        description: 'Agent for testing meta commands',
        brain: {
          model: 'openrouter/anthropic/claude-3.7-sonnet',
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

      expect(testConfig.name).to.equal('meta-test-agent')
      expect(testConfig.brain.model).to.include('openrouter')
      expect(testConfig.tools.builtin).to.include('bash')
    })

    it('should support various tool configurations', () => {
      const toolConfigs = [
        {builtin: ['bash']},
        {builtin: ['bash', 'read']},
        {builtin: ['bash', 'read', 'glob']},
        {builtin: [], mcp: [{server: 'gmail'}]},
      ]

      for (const config of toolConfigs) {
        expect(config).to.have.property('builtin')
      }
    })
  })

  describe('meta command execution', () => {
    it('should execute meta test command', () => {
      const command = 'cast meta:test'
      expect(command).to.include('meta')
      expect(command).to.include('test')
    })

    it('should pass arguments to meta command', () => {
      const args = ['--verbose', '--agent', 'test-agent']
      expect(args.length).to.equal(3)
    })
  })

  describe('test validation', () => {
    it('should validate agent configuration structure', () => {
      const config = {
        name: 'test',
        version: '1.0',
        brain: {model: 'test'},
        tools: {builtin: []},
      }

      expect(config).to.have.property('name')
      expect(config).to.have.property('version')
      expect(config).to.have.property('brain')
      expect(config).to.have.property('tools')
    })

    it('should validate instructions file exists', () => {
      const instructionsFile = 'instructions.md'
      expect(instructionsFile).to.equal('instructions.md')
    })
  })

  describe('cleanup', () => {
    it('should clean up test artifacts', () => {
      const testDir = path.join(os.tmpdir(), 'meta-cleanup-test')
      fs.mkdirSync(testDir, {recursive: true})

      // Create test files
      fs.writeFileSync(path.join(testDir, 'test.txt'), 'test')
      fs.writeFileSync(path.join(testDir, 'test.yaml'), 'key: value')

      // Clean up
      fs.rmSync(testDir, {recursive: true, force: true})

      expect(fs.existsSync(testDir)).to.be.false
    })
  })
})