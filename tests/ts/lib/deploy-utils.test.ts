import {expect} from 'chai'
import * as path from 'path'
import * as os from 'os'
import {getAgentPath} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'

describe('Agent Path Resolution', () => {
  describe('getAgentPath', () => {
    it('should return path under ~/.cast/agents', () => {
      const agentName = 'test-agent'
      const result = getAgentPath(agentName)
      const expected = path.join(os.homedir(), '.cast', 'agents', agentName)
      expect(result).to.equal(expected)
    })

    it('should not return path under ~/cast-agents (old location)', () => {
      const agentName = 'test-agent'
      const result = getAgentPath(agentName)
      const oldLocation = path.join(os.homedir(), 'cast-agents', agentName)
      expect(result).to.not.equal(oldLocation)
    })

    it('should handle hyphenated agent names', () => {
      const agentName = 'my-test-agent'
      const result = getAgentPath(agentName)
      expect(result).to.include(path.join('.cast', 'agents', agentName))
    })

    it('should include .cast in the path', () => {
      const result = getAgentPath('any-agent')
      expect(result).to.include('.cast')
    })

    it('should include agents in the path', () => {
      const result = getAgentPath('any-agent')
      expect(result).to.include('agents')
    })
  })
})
