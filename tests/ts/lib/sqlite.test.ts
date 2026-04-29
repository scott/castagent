import {expect} from 'chai'
import {CastDatabase} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('SQLite', () => {
  let db: CastDatabase

  beforeEach(() => {
    db = new CastDatabase()
  })

  it('should create and retrieve an agent', () => {
    db.createAgent('test-agent', '/path/to/agent.yaml')
    const agent = db.getAgent('test-agent')
    expect(agent).to.exist
    expect(agent.name).to.equal('test-agent')
  })
})
