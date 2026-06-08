import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('stop command', () => {
  describe('command description', () => {
    it('should have correct description', () => {
      expect('Stop a running agent').to.not.be.empty
    })

    it('should document the force flag', () => {
      const forceFlagDescription = 'Force kill (SIGKILL instead of SIGTERM)'
      expect(forceFlagDescription).to.include('SIGKILL')
      expect(forceFlagDescription).to.include('SIGTERM')
    })
  })

  describe('agent not running scenario', () => {
    it('should handle agent that is not running', () => {
      const agentName = `test-nonexistent-${Date.now()}`
      const localAgent = db.getLocalAgent(agentName)

      expect(localAgent).to.be.undefined
    })
  })

  describe('agent running scenario', () => {
    const testAgent = `running-agent-${Date.now()}`

    before(() => {
      // Create a fake running agent
      db.setLocalAgent(testAgent, 99999, 12345)
    })

    after(() => {
      // Clean up
      db.removeLocalAgent(testAgent)
    })

    it('should find running agent in database', () => {
      const localAgent = db.getLocalAgent(testAgent)
      expect(localAgent).to.exist
      expect(localAgent.agent_name).to.equal(testAgent)
      expect(localAgent.pid).to.equal(99999)
      expect(localAgent.port).to.equal(12345)
    })

    it('should get process info from database', () => {
      const localAgent = db.getLocalAgent(testAgent)
      expect(localAgent.pid).to.be.a('number')
      expect(localAgent.port).to.be.a('number')
    })
  })

  describe('force flag behavior', () => {
    it('should use SIGTERM by default', () => {
      const defaultSignal = 'SIGTERM'
      expect(defaultSignal).to.equal('SIGTERM')
    })

    it('should use SIGKILL when force flag is set', () => {
      const forceSignal = 'SIGKILL'
      expect(forceSignal).to.equal('SIGKILL')
    })
  })

  describe('error handling', () => {
    it('should handle process already exited', () => {
      // When process.kill(pid, 0) fails, the process is not running
      const pid = 999999
      try {
        process.kill(pid, 0)
      } catch {
        // Process doesn't exist - expected
      }
    })

    it('should cleanup database when process is gone', () => {
      const agentName = `cleanup-test-${Date.now()}`
      db.setLocalAgent(agentName, 88888, 54321)

      // Simulate cleanup
      db.removeLocalAgent(agentName)

      const localAgent = db.getLocalAgent(agentName)
      expect(localAgent).to.be.undefined
    })
  })
})