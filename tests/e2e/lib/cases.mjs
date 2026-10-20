import {spawn} from 'node:child_process'
import {
  AGENT,
  TOKENS,
  assertEnding,
  countCreatesSince,
  startProcSampler,
} from './harness.mjs'

function fail(message) {
  throw new Error(message)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function blob(fx) {
  return fx.requests().map(req => [req.bin, req.method, req.path, ...(req.argv || [])].filter(Boolean).join(' ')).join('\n')
}

function assertIncludes(text, needle) {
  if (!text.includes(needle)) {
    const tail = text.length > 2500 ? text.slice(-2500) : text
    fail(`missing ${JSON.stringify(needle)}\n--- output ---\n${tail}`)
  }
}

function assertExcludes(text, needle) {
  if (text.includes(needle)) fail(`unexpected ${JSON.stringify(needle)}`)
}

function assertOk(result, label) {
  if (result.timedOut) fail(`${label} timed out\n${result.stderr}\n${result.stdout}`)
  if (result.code !== 0) {
    fail(`${label} exited ${result.code}\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`)
  }
}

function assertFailed(result, label) {
  if (result.timedOut) fail(`${label} timed out\n${result.stderr}\n${result.stdout}`)
  if (result.code === 0) fail(`${label} unexpectedly succeeded\n${result.stdout}`)
}

function combined(result) {
  return `${result.stdout}\n${result.stderr}`
}

function oneLive(fx) {
  const rows = fx.liveRows()
  assert(rows.length === 1, `expected 1 live registry row, got ${JSON.stringify(rows)}`)
  return rows[0]
}

function assertNoLive(fx) {
  const rows = fx.liveRows()
  assert(rows.length === 0, `expected no live registry row, got ${JSON.stringify(rows)}`)
}

function assertAgentResources(fx, provider) {
  const text = blob(fx)
  if (provider === 'sprites') assertIncludes(text, 'sprite create cast-smoke')
  if (provider === 'fly') assertIncludes(text, 'flyctl apps create cast-smoke')
  if (provider === 'digitalocean') {
    assertIncludes(text, 'doctl compute droplet create cast-smoke')
    const volumes = fx.requests().filter(req => req.bin === 'http' && req.method === 'POST' && req.path === '/v2/volumes')
    assert(volumes.some(req => (req.argv || []).includes('cast-smoke')), `volume name is not the agent name\n${text}`)
  }
}

function assertAddOnlySshKeys(fx) {
  const requests = fx.requests()
  const deletes = requests.filter(req =>
    (req.method === 'DELETE' && String(req.path).startsWith('/v2/account/keys'))
    || (req.bin === 'doctl' && (req.argv || []).includes('ssh-key') && (req.argv || []).includes('delete')),
  )
  assert(deletes.length === 0, `account SSH key was deleted or rewritten: ${JSON.stringify(deletes)}`)
  const keyWrites = requests.filter(req =>
    req.bin === 'http'
    && String(req.path).startsWith('/v2/account/keys')
    && req.method !== 'GET'
    && req.method !== 'POST',
  )
  assert(keyWrites.length === 0, `account SSH key was modified: ${JSON.stringify(keyWrites)}`)
  const posts = requests.filter(req => req.method === 'POST' && req.path === '/v2/account/keys')
  assert(posts.length >= 1, 'expected one add of an account SSH key')
  const violations = (fx.world().violations || []).filter(item => item.kind !== 'token-argv')
  assert(violations.length === 0, `provider fake recorded a violation: ${JSON.stringify(violations)}`)
}

function assertDoBearer(fx) {
  const api = fx.requests().filter(req => req.bin === 'http' && String(req.path).startsWith('/v2/'))
  assert(api.length > 0, 'expected DigitalOcean API requests')
  const missing = api.filter(req => !req.env || req.env.authorizationBearer !== true)
  assert(missing.length === 0, `DigitalOcean request missing bearer: ${JSON.stringify(missing.map(req => req.path))}`)
}

async function deploy(fx, provider) {
  return fx.cast(['deploy', AGENT, '--provider', provider])
}

async function connect(fx) {
  return fx.cast(['connect', AGENT])
}

async function shutdown(fx) {
  return fx.cast(['shutdown', AGENT, '--force'])
}

async function upgradeTo(fx, version) {
  return fx.cast(['upgrade', AGENT, version], 'y\n')
}

async function seededDeploy(fx, provider, version = '1.0.0') {
  fx.writeAgent(version)
  fx.seedRelease(version)
  const result = await deploy(fx, provider)
  assertOk(result, `${provider} deploy`)
  return result
}

const FLY_DOUBLE = 'Fly does not install with pip or rewrite agent.yaml at the CLI boundary. A failed flyctl deploy is fly.cleanup.'
const DO_DOUBLE = 'DigitalOcean upgrade builds a container with docker. It does not run the sprite pip or agent.yaml fault points. A failed deploy\'s droplet and volume deletes are do.cleanup.'

export const cases = [
  {
    id: 'sprites.deploy',
    provider: 'sprites',
    name: 'deploy',
    async run(fx) {
      const result = await seededDeploy(fx, 'sprites')
      const row = oneLive(fx)
      assert(row.agent_name === AGENT, row.agent_name)
      assert(row.provider === 'sprites', row.provider)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.remote_version_state == null, String(row.remote_version_state))
      assert(row.volume_id === 'cast-smoke-memory', String(row.volume_id))
      assert(String(row.deployment_url).startsWith('http://127.0.0.1'), String(row.deployment_url))
      assertAgentResources(fx, 'sprites')
      assertEnding('sprites.deploy', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.connect',
    provider: 'sprites',
    name: 'connect',
    async run(fx) {
      await seededDeploy(fx, 'sprites')
      const result = await connect(fx)
      assertOk(result, 'sprites connect')
      assertIncludes(combined(result), 'Connection verified')
      assertExcludes(blob(fx), 'sprite proxy')
      assertEnding('sprites.connect', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.shutdown',
    provider: 'sprites',
    name: 'shutdown',
    async run(fx) {
      await seededDeploy(fx, 'sprites')
      const before = fx.requests().length
      const result = await shutdown(fx)
      assertOk(result, 'sprites shutdown')
      assertNoLive(fx)
      const text = blob({requests: () => fx.requests().slice(before)})
      assertIncludes(text, 'sprite destroy cast-smoke')
      assertEnding('sprites.shutdown', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.upgrade',
    provider: 'sprites',
    name: 'upgrade',
    async run(fx) {
      await seededDeploy(fx, 'sprites')
      fx.seedRelease('1.1.0')
      fx.resetCounts()
      const before = fx.requests()
      const result = await upgradeTo(fx, '1.1.0')
      assertOk(result, 'sprites upgrade')
      assert(countCreatesSince(before, fx.requests()) === 1, `creates ${countCreatesSince(before, fx.requests())}`)
      const row = oneLive(fx)
      assert(row.deployed_version === '1.1.0', row.deployed_version)
      assert(row.remote_version_state == null, String(row.remote_version_state))
      assertIncludes(combined(result), 'Upgraded to version 1.1.0 successfully.')
      assertEnding('sprites.upgrade', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.rollback',
    provider: 'sprites',
    name: 'rollback',
    async run(fx) {
      await seededDeploy(fx, 'sprites')
      fx.seedRelease('1.1.0')
      fx.resetCounts()
      fx.setScenario({pip: {once: 1}})
      const before = fx.requests()
      const result = await upgradeTo(fx, '1.1.0')
      assertFailed(result, 'sprites rollback')
      assert(result.code === 2, `exit ${result.code}\n${combined(result)}`)
      assert(countCreatesSince(before, fx.requests()) === 2, `creates ${countCreatesSince(before, fx.requests())}`)
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.remote_version_state == null, String(row.remote_version_state))
      assertIncludes(combined(result), 'smoke is back on 1.0.0')
      assertEnding('sprites.rollback', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.double-failure-pip',
    provider: 'sprites',
    name: 'double-failure-pip',
    async run(fx) {
      await seededDeploy(fx, 'sprites')
      fx.seedRelease('1.1.0')
      fx.resetCounts()
      fx.setScenario({pip: {from: 1}})
      const before = fx.requests()
      const result = await upgradeTo(fx, '1.1.0')
      assertFailed(result, 'sprites double pip')
      assert(result.code === 2, `exit ${result.code}\n${combined(result)}`)
      assert(countCreatesSince(before, fx.requests()) === 2, `creates ${countCreatesSince(before, fx.requests())}`)
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.remote_version_state === 'remote-state-unknown:1.1.0', String(row.remote_version_state))
      assertIncludes(combined(result), 'restoring 1.0.0 on the remote also failed')
      assertEnding('sprites.double-failure-pip', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.double-failure-yaml',
    provider: 'sprites',
    name: 'double-failure-yaml',
    async run(fx) {
      await seededDeploy(fx, 'sprites')
      fx.seedRelease('1.1.0')
      fx.resetCounts()
      fx.setScenario({yaml: {from: 1}})
      const before = fx.requests()
      const result = await upgradeTo(fx, '1.1.0')
      assertFailed(result, 'sprites double yaml')
      assert(result.code === 2, `exit ${result.code}\n${combined(result)}`)
      assert(countCreatesSince(before, fx.requests()) === 2, `creates ${countCreatesSince(before, fx.requests())}`)
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.remote_version_state === 'remote-state-unknown:1.1.0', String(row.remote_version_state))
      assertIncludes(combined(result), 'Error loading agent config')
      assertEnding('sprites.double-failure-yaml', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.no-version',
    provider: 'sprites',
    name: 'no-version',
    async run(fx) {
      fx.writeAgent(undefined)
      const result = await deploy(fx, 'sprites')
      assertOk(result, 'sprites no-version')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0', row.deployed_version)
      assertIncludes(result.stdout, 'Warning: agent.yaml has no version. Recorded 1.0.')
      assertEnding('sprites.no-version', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.timeout',
    provider: 'sprites',
    name: 'timeout',
    async run(fx) {
      fx.writeAgent('1.0.0')
      fx.setScenario({cliTimeout: true})
      const result = await deploy(fx, 'sprites')
      assertFailed(result, 'sprites timeout')
      assertNoLive(fx)
      assertIncludes(blob(fx), 'sprite destroy cast-smoke')
      assertIncludes(combined(result), 'timed out')
      assertEnding('sprites.timeout', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sprites.flagged-restore',
    provider: 'sprites',
    name: 'flagged-restore',
    async run(fx) {
      await seededDeploy(fx, 'sprites')
      fx.seedRelease('1.0.0')
      fx.setRemoteState('remote-state-unknown:1.1.0')
      fx.resetCounts()
      fx.setScenario({pip: {from: 1}})
      const before = fx.requests()
      const result = await upgradeTo(fx, '1.0.0')
      assertFailed(result, 'sprites flagged restore')
      assert(result.code === 2, `exit ${result.code}\n${combined(result)}`)
      const creates = countCreatesSince(before, fx.requests())
      assert(creates === 1, `flagged restore deployed ${creates} times`)
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.remote_version_state === 'remote-state-unknown:1.1.0', String(row.remote_version_state))
      assertIncludes(combined(result), 'Restoring 1.0.0 on the remote failed again.')
      assertEnding('sprites.flagged-restore', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'fly.deploy',
    provider: 'fly',
    name: 'deploy',
    async run(fx) {
      const result = await seededDeploy(fx, 'fly')
      const row = oneLive(fx)
      assert(row.provider === 'fly', row.provider)
      assert(row.agent_name === AGENT, row.agent_name)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.volume_id === 'cast_smoke_memory', String(row.volume_id))
      assert(row.deployment_url === 'https://cast-smoke.fly.dev', String(row.deployment_url))
      assert(!String(row.deployment_url).includes(fx.base), String(row.deployment_url))
      assertIncludes(blob(fx), 'http GET /.well-known/agent.json')
      assertAgentResources(fx, 'fly')
      assertIncludes(blob(fx), 'flyctl volumes create cast_smoke_memory')
      assertEnding('fly.deploy', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'fly.connect',
    provider: 'fly',
    name: 'connect',
    async run(fx) {
      await seededDeploy(fx, 'fly')
      const result = await connect(fx)
      assertOk(result, 'fly connect')
      assertIncludes(combined(result), 'Connection verified')
      assertEnding('fly.connect', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'fly.shutdown',
    provider: 'fly',
    name: 'shutdown',
    async run(fx) {
      await seededDeploy(fx, 'fly')
      const before = fx.requests().length
      const result = await shutdown(fx)
      assertOk(result, 'fly shutdown')
      assertNoLive(fx)
      const text = blob({requests: () => fx.requests().slice(before)})
      assertIncludes(text, 'flyctl apps destroy cast-smoke')
      assertIncludes(text, 'flyctl volumes delete vol_cast_smoke_memory')
      assertEnding('fly.shutdown', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'fly.upgrade',
    provider: 'fly',
    name: 'upgrade',
    async run(fx) {
      await seededDeploy(fx, 'fly')
      fx.seedRelease('1.1.0')
      const result = await upgradeTo(fx, '1.1.0')
      assertOk(result, 'fly upgrade')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.1.0', row.deployed_version)
      assertIncludes(blob(fx), 'flyctl deploy --detach')
      assertIncludes(combined(result), 'Upgraded to version 1.1.0 successfully.')
      assertEnding('fly.upgrade', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'fly.rollback',
    provider: 'fly',
    name: 'rollback',
    async run(fx) {
      await seededDeploy(fx, 'fly')
      fx.seedRelease('1.1.0')
      fx.setScenario({upgradeDeployFail: true})
      const result = await upgradeTo(fx, '1.1.0')
      assertFailed(result, 'fly rollback')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assertIncludes(combined(result), 'cast deploy smoke --provider fly')
      assertEnding('fly.rollback', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'fly.double-failure',
    provider: 'fly',
    name: 'double-failure',
    skip: FLY_DOUBLE,
  },
  {
    id: 'fly.no-version',
    provider: 'fly',
    name: 'no-version',
    async run(fx) {
      fx.writeAgent(undefined)
      const result = await deploy(fx, 'fly')
      assertOk(result, 'fly no-version')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0', row.deployed_version)
      assertIncludes(result.stdout, 'Warning: agent.yaml has no version. Recorded 1.0.')
      assertEnding('fly.no-version', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'fly.cleanup',
    provider: 'fly',
    name: 'cleanup',
    async run(fx) {
      fx.writeAgent('1.0.0')
      fx.setScenario({flyDeployFail: true})
      const failed = await deploy(fx, 'fly')
      assertFailed(failed, 'fly deploy failure')
      const row = oneLive(fx)
      assert(row.provider === 'fly', row.provider)
      assert(row.deployment_url === 'https://cast-smoke.fly.dev', String(row.deployment_url))
      assert(!String(row.deployment_url).includes(fx.base), String(row.deployment_url))
      assertIncludes(combined(failed), 'Recorded the Fly deployment so cast shutdown smoke can remove the app.')
      assertExcludes(blob(fx), 'flyctl apps destroy')
      const result = await shutdown(fx)
      assertOk(result, 'fly shutdown after failed deploy')
      assertNoLive(fx)
      assertIncludes(blob(fx), 'flyctl apps destroy cast-smoke')
      assertIncludes(blob(fx), 'flyctl volumes delete vol_cast_smoke_memory')
      assertEnding('fly.cleanup', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'digitalocean.deploy',
    provider: 'digitalocean',
    name: 'deploy',
    async run(fx) {
      const result = await seededDeploy(fx, 'digitalocean')
      const row = oneLive(fx)
      assert(row.provider === 'digitalocean', row.provider)
      assert(row.agent_name === AGENT, row.agent_name)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.volume_id === 'cast-smoke', String(row.volume_id))
      assert(row.deployment_url === 'https://203.0.113.10', String(row.deployment_url))
      assertAgentResources(fx, 'digitalocean')
      assertAddOnlySshKeys(fx)
      assertDoBearer(fx)
      assertEnding('digitalocean.deploy', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'digitalocean.connect',
    provider: 'digitalocean',
    name: 'connect',
    async run(fx) {
      await seededDeploy(fx, 'digitalocean')
      const result = await connect(fx)
      assertOk(result, 'digitalocean connect')
      assertIncludes(combined(result), 'Connection verified')
      assertIncludes(combined(result), 'Opening an SSH tunnel')
      assertEnding('digitalocean.connect', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'digitalocean.shutdown',
    provider: 'digitalocean',
    name: 'shutdown',
    async run(fx) {
      await seededDeploy(fx, 'digitalocean')
      const before = fx.requests().length
      const result = await shutdown(fx)
      assertOk(result, 'digitalocean shutdown')
      assertNoLive(fx)
      const text = blob({requests: () => fx.requests().slice(before)})
      assertIncludes(text, 'doctl compute droplet delete')
      assertIncludes(text, 'doctl compute volume delete')
      assertIncludes(combined(result), 'Left DigitalOcean account SSH keys in place')
      assertAddOnlySshKeys(fx)
      assertEnding('digitalocean.shutdown', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'digitalocean.upgrade',
    provider: 'digitalocean',
    name: 'upgrade',
    async run(fx) {
      await seededDeploy(fx, 'digitalocean')
      fx.seedRelease('1.1.0')
      const result = await upgradeTo(fx, '1.1.0')
      assertOk(result, 'digitalocean upgrade')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.1.0', row.deployed_version)
      assertIncludes(blob(fx), 'docker build -t registry.digitalocean.com/cast-smoke/agent:1.1.0')
      assertIncludes(combined(result), 'Upgraded to version 1.1.0 successfully.')
      assertEnding('digitalocean.upgrade', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'digitalocean.rollback',
    provider: 'digitalocean',
    name: 'rollback',
    async run(fx) {
      await seededDeploy(fx, 'digitalocean')
      fx.seedRelease('1.1.0')
      fx.setScenario({upgradeDeployFail: true})
      const result = await upgradeTo(fx, '1.1.0')
      assertFailed(result, 'digitalocean rollback')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assertIncludes(combined(result), 'cast deploy smoke --provider digitalocean')
      assertEnding('digitalocean.rollback', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'digitalocean.double-failure',
    provider: 'digitalocean',
    name: 'double-failure',
    skip: DO_DOUBLE,
  },
  {
    id: 'digitalocean.no-version',
    provider: 'digitalocean',
    name: 'no-version',
    async run(fx) {
      fx.writeAgent(undefined)
      const result = await deploy(fx, 'digitalocean')
      assertOk(result, 'digitalocean no-version')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0', row.deployed_version)
      assertIncludes(result.stdout, 'Warning: agent.yaml has no version. Recorded 1.0.')
      assertAddOnlySshKeys(fx)
      assertEnding('digitalocean.no-version', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'digitalocean.cleanup',
    provider: 'digitalocean',
    name: 'cleanup',
    async run(fx) {
      fx.writeAgent('1.0.0')
      fx.setScenario({doHealthFail: true})
      const result = await deploy(fx, 'digitalocean')
      assertFailed(result, 'digitalocean health failure')
      assertNoLive(fx)
      const text = blob(fx)
      assertIncludes(text, 'doctl compute droplet create cast-smoke')
      assertIncludes(text, 'doctl compute droplet delete')
      assertIncludes(text, 'doctl compute volume delete')
      assertAddOnlySshKeys(fx)
      assertIncludes(combined(result), 'Removed droplet \'cast-smoke\' after the deploy failed.')
      assertEnding('digitalocean.cleanup', result.stdout, result.stderr, fx.home)
    },
  },
  {
    id: 'sampler.self-check',
    provider: 'sampler',
    name: 'self-check',
    ownSampler: true,
    async run() {
      const sampler = startProcSampler()
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)', TOKENS.FLY_API_TOKEN], {
        stdio: 'ignore',
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      const hits = sampler.stop()
      child.kill('SIGKILL')
      assert(hits.some(hit => hit.name === 'FLY_API_TOKEN' && hit.source === 'proc'), `sampler missed argv token: ${JSON.stringify(hits)}`)
    },
  },
]
