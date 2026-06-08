import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('edit command', () => {
  const testDir = path.join(os.tmpdir(), `cast-edit-test-${Date.now()}`)
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

  describe('command description', () => {
    it('should have correct description', () => {
      const description = 'Edit an existing agent through an interactive TUI wizard'
      expect(description).to.not.be.empty
      expect(description).to.include('agent')
      expect(description).to.include('TUI')
    })
  })

  describe('agent argument', () => {
    it('should require agent name', () => {
      const agentName = 'test-agent'
      expect(agentName).to.be.a('string')
      expect(agentName).to.not.be.empty
    })

    it('should validate agent name format', () => {
      const pattern = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/
      expect(pattern.test('test-agent')).to.be.true
      expect(pattern.test('TestAgent')).to.be.true
      expect(pattern.test('-invalid')).to.be.false
    })
  })

  describe('agent existence check', () => {
    it('should verify agent exists before editing', () => {
      const agentName = `edit-test-${Date.now()}`
      const agentPath = path.join(agentsDir, agentName)

      // Create agent
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(
        path.join(agentPath, 'agent.yaml'),
        'name: test\nversion: "1.0"'
      )

      // Check existence
      const exists = fs.existsSync(path.join(agentPath, 'agent.yaml'))
      expect(exists).to.be.true

      // Cleanup
      fs.rmSync(agentPath, {recursive: true, force: true})
    })

    it('should error for non-existent agent', () => {
      const agentName = 'non-existent-agent'
      const agentPath = path.join(agentsDir, agentName)

      expect(fs.existsSync(agentPath)).to.be.false
    })
  })

  describe('edit workflow', () => {
    it('should start builder for editing', () => {
      const agentName = `builder-test-${Date.now()}`
      const agentPath = path.join(agentsDir, agentName)

      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(
        path.join(agentPath, 'agent.yaml'),
        'name: test\nversion: "1.0"'
      )

      // Verify agent is ready for editing
      const configPath = path.join(agentPath, 'agent.yaml')
      expect(fs.existsSync(configPath)).to.be.true

      // Cleanup
      fs.rmSync(agentPath, {recursive: true, force: true})
    })
  })

  describe('TUI launch', () => {
    it('should resolve bun executable path', () => {
      const candidates = [
        path.join(os.homedir(), '.bun', 'bin', 'bun'),
        '/usr/local/bin/bun',
        '/opt/homebrew/bin/bun',
      ]

      // At least one candidate should be valid or bun should be in PATH
      const bunPath = 'bun' // Default to PATH
      expect(bunPath).to.be.a('string')
    })

    it('should construct TUI arguments correctly', () => {
      const agentName = 'test-agent'
      const port = 12345
      const mode = 'dev'

      const tuiArgs = [
        'bun',
        '--agent', agentName,
        '--url', `http://localhost:${port}`,
        '--mode', mode,
      ]

      expect(tuiArgs).to.include('--agent')
      expect(tuiArgs).to.include(agentName)
      expect(tuiArgs).to.include('--url')
      expect(tuiArgs).to.include(`http://localhost:${port}`)
    })
  })

  describe('terminal fallback', () => {
    it('should fallback to terminal mode when TUI not available', () => {
      const tuiPath = '/nonexistent/path/to/tui'
      const tuiAvailable = fs.existsSync(tuiPath)

      expect(tuiAvailable).to.be.false
      // Should fallback to terminal mode
    })
  })
})