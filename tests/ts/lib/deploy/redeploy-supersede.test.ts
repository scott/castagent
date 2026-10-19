import {expect} from 'chai'
import crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import {
  deploymentIdsSupersededBy,
  resolveDeploymentTarget,
  saveDeployment,
  sharesDeploymentResource,
} from '../../../../typescript/cast-cli/src/lib/deploy/deploy-utils'

const secretServiceError = new Error(
  'The name org.freedesktop.secrets was not provided by any .service files',
)

interface RedeployCase {
  provider: 'digitalocean' | 'fly' | 'sprites'
  firstUrl: string
  secondUrl: string
  volumeId: string
}

function tokenPath(id: string): string {
  return path.join(os.homedir(), '.cast', 'tokens', 'deployments', `${id}.token`)
}

function tokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

function uniqueSha(used: Set<string>): string {
  let sha = ''
  do {
    sha = crypto.randomBytes(3).toString('hex')
  } while (used.has(sha))
  used.add(sha)
  return sha
}

function withDeploymentSha(id: string, run: () => void): void {
  const previous = process.env.CAST_DEPLOYMENT_SHA
  process.env.CAST_DEPLOYMENT_SHA = id
  try {
    run()
  } finally {
    if (previous === undefined) delete process.env.CAST_DEPLOYMENT_SHA
    else process.env.CAST_DEPLOYMENT_SHA = previous
  }
}

function plantToken(id: string, token: string): void {
  const file = tokenPath(id)
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, token, {mode: 0o600})
}

function removeToken(id: string): void {
  fs.rmSync(tokenPath(id), {force: true})
}

function deletedAt(id: string): string | null {
  const {db} = require('../../../../typescript/cast-cli/src/lib/sqlite')
  const raw = (db as {db: {prepare: (sql: string) => {get: (...args: unknown[]) => {deleted_at?: string | null} | undefined}}}).db
  const row = raw.prepare('SELECT deleted_at FROM deployments WHERE id = ?').get(id)
  return row?.deleted_at ?? null
}

function setDeployedAt(id: string, deployedAt: string): void {
  const {db} = require('../../../../typescript/cast-cli/src/lib/sqlite')
  const raw = (db as {db: {prepare: (sql: string) => {run: (...args: unknown[]) => void}}}).db
  raw.prepare('UPDATE deployments SET deployed_at = ? WHERE id = ?').run(deployedAt, id)
}

function loadCommand(commandName: string): any {
  return require(path.join(
    __dirname,
    '../../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`,
  )).default
}

describe('redeploy supersedes the previous deployment', () => {
  const {db} = require('../../../../typescript/cast-cli/src/lib/sqlite')
  const usedShas = new Set<string>()
  const agents: string[] = []
  const tokenIds: string[] = []
  let sandbox: sinon.SinonSandbox

  const cases: RedeployCase[] = [
    {
      provider: 'digitalocean',
      firstUrl: 'https://203.0.113.10',
      secondUrl: 'https://203.0.113.10',
      volumeId: 'cast-redeploy-droplet',
    },
    {
      provider: 'fly',
      firstUrl: 'https://cast-redeploy-agent.fly.dev',
      secondUrl: 'https://cast-redeploy-agent.fly.dev',
      volumeId: 'cast_redeploy_agent_memory',
    },
    {
      provider: 'sprites',
      firstUrl: 'https://old.example.sprites.app',
      secondUrl: 'https://new.example.sprites.app',
      volumeId: 'cast-redeploy-agent-memory',
    },
  ]

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    sandbox.stub(require('keytar'), 'getPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'setPassword').rejects(secretServiceError)
    sandbox.stub(require('keytar'), 'deletePassword').rejects(secretServiceError)
  })

  afterEach(() => {
    sandbox.restore()
    for (const name of agents.splice(0)) {
      try { db.deleteAgent(name) } catch { /* already gone */ }
    }
    for (const id of tokenIds.splice(0)) removeToken(id)
    delete process.env.CAST_DEPLOYMENT_SHA
  })

  function record(
    agentName: string,
    sha: string,
    provider: string,
    url: string,
    volumeId: string,
    secret: string,
  ): void {
    tokenIds.push(sha)
    plantToken(sha, secret)
    withDeploymentSha(sha, () => {
      saveDeployment(agentName, provider, url, tokenHash(secret), volumeId, '{}')
    })
  }

  it('marks the previous row deleted for Fly, DigitalOcean, and Sprites', () => {
    for (const spec of cases) {
      const agentName = `redeploy-test-${spec.provider}-${Date.now()}-${uniqueSha(usedShas)}`
      agents.push(agentName)
      const previous = uniqueSha(usedShas)
      const current = uniqueSha(usedShas)
      record(agentName, previous, spec.provider, spec.firstUrl, spec.volumeId, `old-${previous}`)
      record(agentName, current, spec.provider, spec.secondUrl, spec.volumeId, `new-${current}`)

      const live = db.listDeployments(agentName)
      expect(live.map((row: {id: string}) => row.id)).to.deep.equal([current])
      expect(db.getDeploymentBySha(previous)).to.not.exist
      expect(deletedAt(previous)).to.be.a('string').and.not.empty
      expect(fs.existsSync(tokenPath(previous))).to.equal(false)
      expect(fs.readFileSync(tokenPath(current), 'utf8')).to.equal(`new-${current}`)
      expect(resolveDeploymentTarget(agentName)).to.include({type: 'single'})
      expect(resolveDeploymentTarget(agentName).deployment.id).to.equal(current)
      expect(resolveDeploymentTarget(previous).type).to.equal('not_found')
      removeToken(current)
    }
  })

  it('treats an older droplet URL and the current https URL as one droplet', () => {
    const agentName = `redeploy-test-do-url-${Date.now()}-${uniqueSha(usedShas)}`
    agents.push(agentName)
    const previous = uniqueSha(usedShas)
    const current = uniqueSha(usedShas)
    record(agentName, previous, 'digitalocean', 'http://203.0.113.20:8080', 'cast-agent-uuid-memory', `old-${previous}`)
    record(agentName, current, 'digitalocean', 'https://203.0.113.20', 'cast-agent', `new-${current}`)

    expect(db.listDeployments(agentName).map((row: {id: string}) => row.id)).to.deep.equal([current])
    expect(fs.existsSync(tokenPath(previous))).to.equal(false)
    expect(fs.readFileSync(tokenPath(current), 'utf8')).to.equal(`new-${current}`)
    removeToken(current)
  })

  it('leaves the live row in place when a failed deploy records a leftover', () => {
    const agentName = `redeploy-test-leftover-${Date.now()}-${uniqueSha(usedShas)}`
    agents.push(agentName)
    const live = uniqueSha(usedShas)
    const leftover = uniqueSha(usedShas)
    record(agentName, live, 'digitalocean', 'https://203.0.113.40', 'cast-leftover', `live-${live}`)
    tokenIds.push(leftover)
    plantToken(leftover, `left-${leftover}`)
    withDeploymentSha(leftover, () => {
      saveDeployment(
        agentName,
        'digitalocean',
        'https://203.0.113.40',
        tokenHash(`left-${leftover}`),
        'cast-leftover',
        '{}',
        undefined,
        {supersede: false},
      )
    })

    expect(db.listDeployments(agentName).map((row: {id: string}) => row.id)).to.have.members([live, leftover])
    expect(fs.readFileSync(tokenPath(live), 'utf8')).to.equal(`live-${live}`)
    expect(fs.readFileSync(tokenPath(leftover), 'utf8')).to.equal(`left-${leftover}`)
    removeToken(live)
    removeToken(leftover)
  })

  it('keeps a second provider and a second MicroVM', () => {
    const agentName = `redeploy-test-distinct-${Date.now()}-${uniqueSha(usedShas)}`
    agents.push(agentName)
    const fly = uniqueSha(usedShas)
    const droplet = uniqueSha(usedShas)
    const microA = uniqueSha(usedShas)
    const microB = uniqueSha(usedShas)
    record(agentName, fly, 'fly', 'https://cast-distinct.fly.dev', 'cast_distinct_memory', `fly-${fly}`)
    record(agentName, droplet, 'digitalocean', 'https://203.0.113.30', 'cast-distinct', `do-${droplet}`)
    record(agentName, microA, 'microvm', 'https://vm-a.example', 'vm-a', `vm-${microA}`)
    record(agentName, microB, 'microvm', 'https://vm-b.example', 'vm-b', `vm-${microB}`)

    expect(db.listDeployments(agentName).map((row: {id: string}) => row.id)).to.have.members([
      fly, droplet, microA, microB,
    ])
    for (const id of [fly, droplet, microA, microB]) {
      expect(fs.existsSync(tokenPath(id))).to.equal(true)
      removeToken(id)
    }
    expect(resolveDeploymentTarget(agentName).type).to.equal('ambiguous')
  })

  it('retires rows already active from before the fix and removes the old token file', () => {
    const agentName = `redeploy-test-legacy-${Date.now()}-${uniqueSha(usedShas)}`
    agents.push(agentName)
    const previous = uniqueSha(usedShas)
    const current = uniqueSha(usedShas)
    db.createAgent(agentName, '/tmp/agent.yaml')
    db.createDeployment(previous, agentName, 'sprites', 'https://old.example.sprites.app', 'h1', 'cast-legacy-memory', '{}')
    db.createDeployment(current, agentName, 'sprites', 'https://new.example.sprites.app', 'h2', 'cast-legacy-memory', '{}')
    setDeployedAt(previous, '2026-01-01 00:00:00')
    setDeployedAt(current, '2026-06-01 00:00:00')
    tokenIds.push(previous, current)
    plantToken(previous, `old-${previous}`)
    plantToken(current, `new-${current}`)

    const resolution = resolveDeploymentTarget(agentName)
    expect(resolution.type).to.equal('single')
    expect(resolution.deployment.id).to.equal(current)
    expect(db.getDeploymentBySha(previous)).to.not.exist
    expect(deletedAt(previous)).to.be.a('string').and.not.empty
    expect(fs.existsSync(tokenPath(previous))).to.equal(false)
    expect(fs.readFileSync(tokenPath(current), 'utf8')).to.equal(`new-${current}`)
    removeToken(current)
  })

  describe('connect and shutdown after a redeploy', () => {
    let Connect: any
    let Shutdown: any
    let restoreDestroyers: (() => void) | undefined

    before(() => {
      require('../../../../typescript/cast-cli/src/lib/deploy/docker')
      require('../../../../typescript/cast-cli/src/lib/deploy/fly')
      require('../../../../typescript/cast-cli/src/lib/deploy/digitalocean')
      require('../../../../typescript/cast-cli/src/lib/deploy/sprites')
      Connect = loadCommand('connect')
      Shutdown = loadCommand('shutdown')
    })

    beforeEach(() => {
      const registry = require('../../../../typescript/cast-cli/src/lib/deploy/registry')
      const original = registry.getDeploymentProvider
      sandbox.stub(registry, 'getDeploymentProvider').callsFake((key: unknown) => {
        const provider = original(key)
        if (!provider) return provider
        return {
          ...provider,
          connect: async () => ({url: 'http://127.0.0.1:9'}),
        }
      })
      const {A2AClient} = require('../../../../typescript/cast-cli/src/lib/a2a/client')
      sandbox.stub(A2AClient.prototype, 'getAgentCard').resolves({name: 'redeploy-test'})

      const shutdown = require('../../../../typescript/cast-cli/src/commands/shutdown')
      const previous: Record<string, unknown> = {}
      for (const key of ['fly', 'digitalocean', 'sprites']) {
        previous[key] = shutdown.PROVIDER_DESTROYERS[key]
        shutdown.PROVIDER_DESTROYERS[key] = async () => {}
      }
      restoreDestroyers = () => {
        for (const key of Object.keys(previous)) {
          if (previous[key] === undefined) delete shutdown.PROVIDER_DESTROYERS[key]
          else shutdown.PROVIDER_DESTROYERS[key] = previous[key]
        }
      }
    })

    afterEach(() => {
      restoreDestroyers?.()
      restoreDestroyers = undefined
    })

    function connectInstance(agentName: string): {instance: any; logs: string[]} {
      const instance = new Connect([agentName], {color: false})
      const logs: string[] = []
      instance.config = {runHook: async () => {}, name: 'connect', bin: 'cast'}
      instance.argv = [agentName]
      instance.parse = async () => ({args: {agent: agentName}, flags: {proxy: false, sha: false}})
      instance.log = (message?: string) => { if (message) logs.push(message) }
      instance.warn = () => {}
      instance.error = (message?: string) => {
        throw new Error(typeof message === 'string' ? message : 'connect failed')
      }
      instance.launchTui = async () => { logs.push('launched') }
      return {instance, logs}
    }

    function shutdownInstance(agentName: string): {instance: any; logs: string[]} {
      const instance = new Shutdown([agentName], {color: false})
      const logs: string[] = []
      instance.config = {runHook: async () => {}, name: 'shutdown', bin: 'cast'}
      instance.argv = [agentName]
      instance.parse = async () => ({args: {agent: agentName}, flags: {force: true}})
      instance.log = (message?: string) => { if (message) logs.push(message) }
      instance.warn = (message?: string) => { if (message) logs.push(message) }
      instance.error = (message?: string) => {
        throw new Error(typeof message === 'string' ? message : 'shutdown failed')
      }
      return {instance, logs}
    }

    async function redeploy(spec: RedeployCase): Promise<{agentName: string; current: string; secret: string}> {
      const agentName = `redeploy-test-cmd-${spec.provider}-${Date.now()}-${uniqueSha(usedShas)}`
      agents.push(agentName)
      const previous = uniqueSha(usedShas)
      const current = uniqueSha(usedShas)
      const secret = `new-${current}`
      record(agentName, previous, spec.provider, spec.firstUrl, spec.volumeId, `old-${previous}`)
      record(agentName, current, spec.provider, spec.secondUrl, spec.volumeId, secret)
      expect(fs.existsSync(tokenPath(previous))).to.equal(false)
      return {agentName, current, secret}
    }

    for (const spec of cases) {
      it(`connects to ${spec.provider} by agent name after a redeploy`, async () => {
        const {agentName, secret} = await redeploy(spec)
        const {instance, logs} = connectInstance(agentName)
        await instance.run()
        expect(logs.some(line => line.includes(`Connecting to ${agentName}`))).to.equal(true)
        expect(logs).to.include('launched')
        expect(logs.join('\n').includes(secret)).to.equal(false)
        removeToken(tokenShaFromSecret(secret))
      })

      it(`shuts down ${spec.provider} by agent name after a redeploy`, async () => {
        const {agentName, current, secret} = await redeploy(spec)
        const {instance, logs} = shutdownInstance(agentName)
        await instance.run()
        const text = logs.join('\n')
        expect(text).to.include(`deployed to ${spec.provider}`)
        expect(text).to.include('Shutting down')
        expect(text.includes('Multiple deployments')).to.equal(false)
        expect(text.includes(secret)).to.equal(false)
        expect(db.listDeployments(agentName)).to.have.length(0)
        expect(db.getDeploymentBySha(current)).to.not.exist
        removeToken(current)
      })
    }

    it('connects when duplicate rows were already active', async () => {
      const agentName = `redeploy-test-legacy-connect-${Date.now()}-${uniqueSha(usedShas)}`
      agents.push(agentName)
      const previous = uniqueSha(usedShas)
      const current = uniqueSha(usedShas)
      const secret = `new-${current}`
      db.createAgent(agentName, '/tmp/agent.yaml')
      db.createDeployment(previous, agentName, 'digitalocean', 'http://203.0.113.40:8080', tokenHash(`old-${previous}`), 'cast-legacy', '{}')
      db.createDeployment(current, agentName, 'digitalocean', 'https://203.0.113.40', tokenHash(secret), 'cast-legacy-new', '{}')
      setDeployedAt(previous, '2026-01-01 00:00:00')
      setDeployedAt(current, '2026-06-01 00:00:00')
      tokenIds.push(previous, current)
      plantToken(previous, `old-${previous}`)
      plantToken(current, secret)

      const {instance, logs} = connectInstance(agentName)
      await instance.run()
      expect(logs.some(line => line.includes(`Connecting to ${agentName}`))).to.equal(true)
      expect(logs).to.include('launched')
      expect(fs.existsSync(tokenPath(previous))).to.equal(false)
      expect(db.listDeployments(agentName).map((row: {id: string}) => row.id)).to.deep.equal([current])
      removeToken(current)
    })

    it('shuts down when duplicate rows were already active', async () => {
      const agentName = `redeploy-test-legacy-shutdown-${Date.now()}-${uniqueSha(usedShas)}`
      agents.push(agentName)
      const previous = uniqueSha(usedShas)
      const current = uniqueSha(usedShas)
      db.createAgent(agentName, '/tmp/agent.yaml')
      db.createDeployment(previous, agentName, 'fly', 'https://cast-legacy.fly.dev', 'h1', 'cast_legacy_memory', '{}')
      db.createDeployment(current, agentName, 'fly', 'https://cast-legacy.fly.dev/', 'h2', 'cast_legacy_memory', '{}')
      setDeployedAt(previous, '2026-01-01 00:00:00')
      setDeployedAt(current, '2026-06-01 00:00:00')
      tokenIds.push(previous, current)
      plantToken(previous, `old-${previous}`)
      plantToken(current, `new-${current}`)

      const {instance, logs} = shutdownInstance(agentName)
      await instance.run()
      expect(logs.join('\n').includes('Multiple deployments')).to.equal(false)
      expect(logs.join('\n')).to.include('deployed to fly')
      expect(fs.existsSync(tokenPath(previous))).to.equal(false)
      expect(db.listDeployments(agentName)).to.have.length(0)
      removeToken(current)
    })
  })
})

function tokenShaFromSecret(secret: string): string {
  return secret.slice('new-'.length)
}

describe('deployment resource matching', () => {
  it('matches a droplet across the old public URL and the current https URL', () => {
    const older = {id: 'olddro', provider: 'digitalocean', deployment_url: 'http://203.0.113.10:8080', volume_id: 'cast-old'}
    const newer = {id: 'newdro', provider: 'digitalocean', deployment_url: 'https://203.0.113.10', volume_id: 'cast-new'}
    expect(sharesDeploymentResource(older, newer)).to.equal(true)
    expect(deploymentIdsSupersededBy([newer, older])).to.deep.equal(['olddro'])
  })

  it('leaves two MicroVMs and two providers in place', () => {
    const rows = [
      {id: 'flynew', provider: 'fly', deployment_url: 'https://cast-a.fly.dev', volume_id: 'cast_a_memory'},
      {id: 'vmnew', provider: 'microvm', deployment_url: 'https://vm-b.example', volume_id: 'vm-b'},
      {id: 'vmold', provider: 'microvm', deployment_url: 'https://vm-a.example', volume_id: 'vm-a'},
      {id: 'donew', provider: 'digitalocean', deployment_url: 'https://203.0.113.11', volume_id: 'cast-a'},
    ]
    expect(deploymentIdsSupersededBy(rows)).to.deep.equal([])
  })
})
