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

  it('should add and remove a deployment', () => {
    db.setDeployment('test-agent', 'docker', 'http://localhost:8080', 'hash123')
    const deployment = db.getDeployment('test-agent')
    expect(deployment).to.exist
    expect(deployment.provider).to.equal('docker')

    db.removeDeployment('test-agent')
    const removed = db.getDeployment('test-agent')
    expect(removed).to.not.exist
  })
})
