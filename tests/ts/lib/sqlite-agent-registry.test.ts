import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {CastDatabase} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('agent registry foreign key', () => {
  const dbPath = path.join(os.tmpdir(), `cast-fk-registry-${process.pid}-${Date.now()}.db`)
  let db: CastDatabase

  beforeEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, {force: true})
    }
    db = new CastDatabase(dbPath)
  })

  afterEach(() => {
    db.close()
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, {force: true})
    }
  })

  it('rejects a deployment whose agent row was never recorded', () => {
    const raw = (db as unknown as {db: {prepare: (sql: string) => {run: (...args: string[]) => void}}}).db
    expect(() => {
      raw.prepare('INSERT INTO deployments (id, agent_name, provider) VALUES (?, ?, ?)').run(
        'abc123',
        'missing-agent',
        'docker',
      )
    }).to.throw(/FOREIGN KEY constraint failed/)
    expect(db.listAgents()).to.deep.equal([])
  })

  it('records the agent row when a deployment is saved without one', () => {
    const agentName = `fk-test-${Date.now()}`
    db.setDeployment(agentName, 'docker', 'http://localhost:8080', 'hash', 'vol', '{}')

    const agent = db.getAgent(agentName)
    expect(agent).to.exist
    expect(agent.name).to.equal(agentName)
    expect(agent.agent_yaml_path).to.equal(path.join(os.homedir(), '.cast', 'agents', agentName, 'agent.yaml'))

    const deployment = db.getDeployment(agentName)
    expect(deployment).to.exist
    expect(deployment.provider).to.equal('docker')
    expect(deployment.deployment_url).to.equal('http://localhost:8080')
  })

  it('does not reset run_count when the agent row already exists', () => {
    const agentName = `fk-test-keep-${Date.now()}`
    db.createAgent(agentName, '/tmp/kept/agent.yaml')
    db.updateAgentRun(agentName)

    db.setDeployment(agentName, 'docker', 'http://localhost:8080', 'hash')

    const agent = db.getAgent(agentName)
    expect(agent.run_count).to.equal(1)
    expect(agent.agent_yaml_path).to.equal('/tmp/kept/agent.yaml')
    expect(db.getDeployment(agentName)).to.exist
  })

  it('renames an agent that already has a deployment', () => {
    const oldName = `fk-test-old-${Date.now()}`
    const newName = `fk-test-new-${Date.now()}`
    db.createAgent(oldName, `/tmp/${oldName}/agent.yaml`)
    db.setLocalAgent(oldName, 12345, 54321)
    db.setDeployment(oldName, 'docker', 'http://localhost:8080', 'hash')
    db.updateAgentRun(oldName)

    db.renameAgent(oldName, newName)

    expect(db.getAgent(oldName)).to.equal(undefined)
    const renamed = db.getAgent(newName)
    expect(renamed).to.exist
    expect(renamed.name).to.equal(newName)
    expect(renamed.run_count).to.equal(1)
    expect(renamed.agent_yaml_path).to.equal(`/tmp/${oldName}/agent.yaml`)

    const deployment = db.getDeployment(newName)
    expect(deployment).to.exist
    expect(deployment.agent_name).to.equal(newName)
    expect(db.getDeployment(oldName)).to.equal(undefined)

    const localAgent = db.getLocalAgent(newName)
    expect(localAgent).to.exist
    expect(localAgent.agent_name).to.equal(newName)
    expect(db.getLocalAgent(oldName)).to.equal(undefined)
  })
})
