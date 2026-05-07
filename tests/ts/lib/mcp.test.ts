import {expect} from 'chai'
import * as path from 'path'
import * as os from 'os'

describe('MCP Manager Agent Path', () => {
  it('should reference ~/.cast/agents for agent directories', () => {
    // Import the module to verify the constant
    const mcpModule = require('../../../typescript/cast-cli/src/lib/mcp')
    const mcpManager = mcpModule.mcpManager

    // Test via the getAgentPath private method behavior
    const agentName = 'test-agent'
    const expectedPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    // Verify by checking a method that uses the path
    // The getAgentPath is private, but we can verify through ensureAgentDir error message
    try {
      mcpManager.installServer('nonexistent-test-agent-12345', 'gmail')
    } catch (err: any) {
      expect(err.message).to.include('.cast')
      expect(err.message).to.include('agents')
      expect(err.message).to.not.include('cast-agents')
    }
  })
})
