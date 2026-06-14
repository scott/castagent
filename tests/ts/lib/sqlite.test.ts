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

  it('should create deployments table with deployed_version column after migration', () => {
    // The CastDatabase constructor runs initSchema() which includes the migration
    // Check that the deployed_version column exists in the deployments table
    const deployment = db.getDeployment('non-existent-agent')
    // The column exists if we can query it (even with no rows)
    // We verify the schema by checking a deployment record structure
    db.setDeployment('migration-test-agent', 'docker', 'http://localhost:9000', 'token456')
    const deployed = db.getDeployment('migration-test-agent')
    expect(deployed).to.exist
    expect(deployed).to.have.property('deployed_version')
    expect(deployed.deployed_version).to.equal(null) // Initially null before any version is set
  })

  it('should return null from getDeployedVersion when no deployment exists', () => {
    const version = db.getDeployedVersion('non-existent-agent')
    expect(version).to.equal(null)
  })

  it('should return null from getDeployedVersion when deployment has no version', () => {
    db.createAgent('no-version-agent', '/path/to/agent.yaml')
    db.setDeployment('no-version-agent', 'docker', 'http://localhost:8080', 'token123')
    const version = db.getDeployedVersion('no-version-agent')
    expect(version).to.equal(null)
  })

  it('should return version from getDeployedVersion when version is set', () => {
    db.createAgent('versioned-agent', '/path/to/agent.yaml')
    db.setDeployment('versioned-agent', 'docker', 'http://localhost:8080', 'token123')
    db.updateDeployedVersion('versioned-agent', 42)
    const version = db.getDeployedVersion('versioned-agent')
    // Numeric versions are stored with a "v" prefix to disambiguate from
    // semantic versions (e.g. "1.6") that don't use a prefix.
    expect(version).to.equal('v42')
  })

  it('should return semantic version from getDeployedVersion when version is a string', () => {
    db.createAgent('semver-agent', '/path/to/agent.yaml')
    db.setDeployment('semver-agent', 'docker', 'http://localhost:8080', 'token123')
    db.updateDeployedVersion('semver-agent', '1.6')
    const version = db.getDeployedVersion('semver-agent')
    // Semantic versions are stored verbatim without a "v" prefix.
    expect(version).to.equal('1.6')
  })

  it('should update deployed version for an existing deployment', () => {
    db.createAgent('update-test-agent', '/path/to/agent.yaml')
    db.setDeployment('update-test-agent', 'aws', 'https://aws.example.com', 'tokenabc')

    // Initial version should be null
    expect(db.getDeployedVersion('update-test-agent')).to.equal(null)

    // Update to version 1 (numeric, gets "v" prefix)
    db.updateDeployedVersion('update-test-agent', 1)
    expect(db.getDeployedVersion('update-test-agent')).to.equal('v1')

    // Update to version 5 (numeric, gets "v" prefix)
    db.updateDeployedVersion('update-test-agent', 5)
    expect(db.getDeployedVersion('update-test-agent')).to.equal('v5')

    // Update to a semantic version (no prefix)
    db.updateDeployedVersion('update-test-agent', '2.0')
    expect(db.getDeployedVersion('update-test-agent')).to.equal('2.0')
  })

  it('should handle updateDeployedVersion for non-existent deployment without error', () => {
    // Should not throw even if agent doesn't exist
    expect(() => {
      db.updateDeployedVersion('non-existent-agent', 10)
    }).to.not.throw()

    // Version should remain null since no deployment exists
    expect(db.getDeployedVersion('non-existent-agent')).to.equal(null)
  })

  it('deleteAgent cascades to releases, deployments, and mcp records', () => {
    const cascadeAgent = `cascade-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    db.createAgent(cascadeAgent, '/path/to/cascade.yaml')
    db.createRelease(cascadeAgent, '1.0', 1, 'A', '', '/tmp/a.tar.gz')
    db.createRelease(cascadeAgent, '2.0', 2, 'B', '', '/tmp/b.tar.gz')
    const cascadeSha = `cs${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(cascadeSha, cascadeAgent, 'docker', 'http://a', 'h')
    db.setAgentMcp(cascadeAgent, 'gmail', '/tmp/gmail.yaml')

    // Sanity check: all data is present
    expect(db.listReleases(cascadeAgent)).to.have.length(2)
    expect(db.listDeployments(cascadeAgent)).to.have.length(1)
    expect(db.listAgentMcp(cascadeAgent)).to.have.length(1)

    db.deleteAgent(cascadeAgent)

    // After delete, no related records should remain.
    expect(db.listReleases(cascadeAgent)).to.have.length(0)
    expect(db.listDeployments(cascadeAgent)).to.have.length(0)
    expect(db.listAgentMcp(cascadeAgent)).to.have.length(0)
    expect(db.getAgent(cascadeAgent)).to.not.exist
  })
})

describe('SQLite - SHA-based deployments', () => {
  let db: CastDatabase
  // Unique agent name per test to avoid collisions in the shared DB
  let agentName: string

  beforeEach(() => {
    db = new CastDatabase()
    agentName = `sha-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  it('createDeployment stores the SHA as the primary key', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    const sha = `abc${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(sha, agentName, 'docker', 'http://localhost:8080', 'hash')

    const deployment = db.getDeploymentBySha(sha)
    expect(deployment).to.exist
    expect(deployment.id).to.equal(sha)
    expect(deployment.agent_name).to.equal(agentName)
    expect(deployment.provider).to.equal('docker')
  })

  it('getDeploymentBySha returns undefined for unknown SHA', () => {
    expect(db.getDeploymentBySha('xxxxxx')).to.not.exist
  })

  it('getDeploymentBySha excludes soft-deleted deployments', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    const sha = `del${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(sha, agentName, 'docker', 'http://localhost', 'h')
    db.removeDeploymentBySha(sha)
    expect(db.getDeploymentBySha(sha)).to.not.exist
  })

  it('listDeployments returns only non-deleted deployments for an agent', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    const sha1 = `d1a${Math.random().toString(16).slice(2, 5)}`
    const sha2 = `d2b${Math.random().toString(16).slice(2, 5)}`
    const sha3 = `d3c${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(sha1, agentName, 'docker', 'http://docker', 'h1')
    db.createDeployment(sha2, agentName, 'fly', 'http://fly', 'h2')
    db.createDeployment(sha3, agentName, 'railway', 'http://railway', 'h3')
    db.removeDeploymentBySha(sha2)

    const deployments = db.listDeployments(agentName)
    expect(deployments).to.have.length(2)
    const ids = deployments.map((d: any) => d.id)
    expect(ids).to.include(sha1)
    expect(ids).to.include(sha3)
    expect(ids).to.not.include(sha2)
  })

  it('listDeployments returns empty array when no deployments exist', () => {
    expect(db.listDeployments(`never-deployed-${Date.now()}`)).to.deep.equal([])
  })

  it('setDeployment auto-generates a SHA', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.setDeployment(agentName, 'docker', 'http://localhost', 'hash')

    const deployments = db.listDeployments(agentName)
    expect(deployments).to.have.length(1)
    const sha = deployments[0].id
    expect(sha).to.be.a('string')
    expect(sha).to.match(/^[a-f0-9]{6}$/)
  })

  it('removeDeployment soft-deletes the most recent deployment for backward compat', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.setDeployment(agentName, 'docker', 'http://localhost', 'hash')

    const before = db.getDeployment(agentName)
    expect(before).to.exist

    db.removeDeployment(agentName)
    expect(db.getDeployment(agentName)).to.not.exist
    // But the record is still in the DB, just soft-deleted
    const list = db.listDeployments(agentName)
    // soft-deleted, so listDeployments excludes it
    expect(list).to.have.length(0)
  })

  it('removeAllDeployments soft-deletes all undeleted deployments for an agent', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    const sha1 = `x1a${Math.random().toString(16).slice(2, 5)}`
    const sha2 = `x2b${Math.random().toString(16).slice(2, 5)}`
    const sha3 = `x3c${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(sha1, agentName, 'docker', 'http://docker', 'h1')
    db.createDeployment(sha2, agentName, 'fly', 'http://fly', 'h2')
    db.createDeployment(sha3, agentName, 'railway', 'http://railway', 'h3')

    // All three should be present before cleanup
    expect(db.listDeployments(agentName)).to.have.length(3)

    db.removeAllDeployments(agentName)

    // All should be soft-deleted
    expect(db.listDeployments(agentName)).to.have.length(0)

    // Verify individual SHAs also return nothing
    expect(db.getDeploymentBySha(sha1)).to.not.exist
    expect(db.getDeploymentBySha(sha2)).to.not.exist
    expect(db.getDeploymentBySha(sha3)).to.not.exist
  })

  it('removeAllDeployments does not affect deployments of other agents', () => {
    const otherAgent = `other-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.createAgent(otherAgent, '/path/to/other.yaml')
    const sha1 = `oa1${Math.random().toString(16).slice(2, 5)}`
    const sha2 = `oa2${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(sha1, agentName, 'docker', 'http://a', 'h1')
    db.createDeployment(sha2, otherAgent, 'fly', 'http://b', 'h2')

    db.removeAllDeployments(agentName)

    // Our agent's deployments should be gone
    expect(db.listDeployments(agentName)).to.have.length(0)
    // Other agent's deployments should remain untouched
    expect(db.listDeployments(otherAgent)).to.have.length(1)
  })

  it('removeAllDeployments is a no-op when no deployments exist', () => {
    // Should not throw even if agent has no deployments
    expect(() => {
      db.removeAllDeployments(`never-deployed-${Date.now()}`)
    }).to.not.throw()
  })

  it('updateDeploymentLastConnected updates the timestamp', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    const sha = `cn${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(sha, agentName, 'docker', 'http://localhost', 'h')
    db.updateDeploymentLastConnected(sha)
    const dep = db.getDeploymentBySha(sha)
    expect(dep.last_connected_at).to.exist
  })
})

describe('SQLite - Releases table', () => {
  let db: CastDatabase
  let agentName: string

  beforeEach(() => {
    db = new CastDatabase()
    agentName = `release-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  })

  it('createRelease stores a release and listReleases returns it', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.createRelease(agentName, '1.0', 3, 'First release', '## Changelog', '/tmp/1.0.tar.gz')

    const releases = db.listReleases(agentName)
    expect(releases).to.have.length(1)
    expect(releases[0].version).to.equal('1.0')
    expect(releases[0].change_number).to.equal(3)
    expect(releases[0].message).to.equal('First release')
    expect(releases[0].changelog).to.equal('## Changelog')
    expect(releases[0].tarball_path).to.equal('/tmp/1.0.tar.gz')
  })

  it('getRelease returns a specific release by version', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.createRelease(agentName, '1.0', 1, 'First', '', '/tmp/1.0.tar.gz')
    db.createRelease(agentName, '1.1', 2, 'Second', '', '/tmp/1.1.tar.gz')

    const r = db.getRelease(agentName, '1.1')
    expect(r).to.exist
    expect(r.version).to.equal('1.1')
    expect(r.message).to.equal('Second')
  })

  it('getRelease returns undefined for missing version', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    expect(db.getRelease(agentName, '99.0')).to.not.exist
  })

  it('getCurrentRelease returns the most recently created release', async () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.createRelease(agentName, '1.0', 1, 'First', '', '/tmp/1.0.tar.gz')
    // Sleep so the second insert gets a strictly later created_at timestamp
    // (CURRENT_TIMESTAMP has 1-second resolution)
    await new Promise(resolve => setTimeout(resolve, 1100))
    db.createRelease(agentName, '2.0', 5, 'Second', '', '/tmp/2.0.tar.gz')

    const current = db.getCurrentRelease(agentName)
    expect(current).to.exist
    // 2.0 was created last, so should be current
    expect(current.version).to.equal('2.0')
  })

  it('getCurrentRelease returns undefined when no releases exist', () => {
    expect(db.getCurrentRelease(`no-releases-${Date.now()}`)).to.not.exist
  })

  it('listAllReleases returns releases across agents joined with deployments', () => {
    const agentA = `rel-a-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const agentB = `rel-b-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(agentA, '/path/to/a.yaml')
    db.createAgent(agentB, '/path/to/b.yaml')
    db.createRelease(agentA, '1.0', 1, 'A1', '', '/tmp/a-1.0.tar.gz')
    db.createRelease(agentB, '2.0', 1, 'B1', '', '/tmp/b-2.0.tar.gz')

    const all = db.listAllReleases()
    const names = all.map((r: any) => r.agent_name)
    expect(names).to.include(agentA)
    expect(names).to.include(agentB)
  })

  it('listAllReleasesForAgent filters by agent', () => {
    const agentX = `rel-x-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const agentY = `rel-y-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    db.createAgent(agentX, '/path/to/x.yaml')
    db.createAgent(agentY, '/path/to/y.yaml')
    db.createRelease(agentX, '1.0', 1, 'X', '', '/tmp/x.tar.gz')
    db.createRelease(agentY, '1.0', 1, 'Y', '', '/tmp/y.tar.gz')

    const xReleases = db.listAllReleasesForAgent(agentX)
    expect(xReleases).to.have.length(1)
    expect(xReleases[0].agent_name).to.equal(agentX)
  })

  it('listAllDeploymentsForAgent returns deployment SHAs for one agent', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    const sha1 = `sh1${Math.random().toString(16).slice(2, 5)}`
    const sha2 = `sh2${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(sha1, agentName, 'docker', 'http://a', 'h')
    db.createDeployment(sha2, agentName, 'fly', 'http://b', 'h')

    const deps = db.listAllDeploymentsForAgent(agentName)
    expect(deps).to.have.length(2)
    const shas = deps.map((d: any) => d.deployment_sha)
    expect(shas).to.include(sha1)
    expect(shas).to.include(sha2)
  })

  it('listAllDeploymentsForAgent excludes soft-deleted deployments', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    const aliveSha = `alv${Math.random().toString(16).slice(2, 5)}`
    const deadSha = `ded${Math.random().toString(16).slice(2, 5)}`
    db.createDeployment(aliveSha, agentName, 'docker', 'http://a', 'h')
    db.createDeployment(deadSha, agentName, 'fly', 'http://b', 'h')
    db.removeDeploymentBySha(deadSha)

    const deps = db.listAllDeploymentsForAgent(agentName)
    expect(deps).to.have.length(1)
    expect(deps[0].deployment_sha).to.equal(aliveSha)
  })

  it('deleteRelease removes a release by version', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.createRelease(agentName, '1.0', 1, 'A', '', '/tmp/1.0.tar.gz')
    db.createRelease(agentName, '2.0', 2, 'B', '', '/tmp/2.0.tar.gz')

    db.deleteRelease(agentName, '1.0')

    const remaining = db.listReleases(agentName)
    expect(remaining).to.have.length(1)
    expect(remaining[0].version).to.equal('2.0')
  })

  it('createRelease with same version replaces (upsert)', () => {
    db.createAgent(agentName, '/path/to/agent.yaml')
    db.createRelease(agentName, '1.0', 1, 'First', '', '/tmp/v1.tar.gz')
    db.createRelease(agentName, '1.0', 1, 'Updated', 'new', '/tmp/v1.tar.gz')

    const releases = db.listReleases(agentName)
    expect(releases).to.have.length(1)
    expect(releases[0].message).to.equal('Updated')
  })
})