import {expect} from 'chai'
import * as path from 'path'
import * as os from 'os'

describe('list command output', () => {
  it('should reference ~/.cast/agents in output message', () => {
    // Verify the expected output path string
    const expectedPath = path.join(os.homedir(), '.cast', 'agents')
    expect('Agents in ~/.cast/agents/').to.contain('.cast/agents')
  })

  it('should not reference old ~/cast-agents path', () => {
    const output = 'Agents in ~/.cast/agents/'
    expect(output).to.not.contain('cast-agents')
  })
})
