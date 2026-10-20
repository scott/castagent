import {handleAgentHttp} from '../lib/agent-http.mjs'
import {
  AGENT,
  assert,
  assertEnding,
  assertExcludes,
  assertFailed,
  assertIncludes,
  assertNoLive,
  assertOk,
  blob,
  combined,
  connect,
  deploy,
  oneLive,
  seededDeploy,
  shutdown,
  upgradeTo,
} from '../lib/assert.mjs'
import {countCreatesSince as countCreates} from '../lib/harness.mjs'

export const shims = ['sprite']

export const tokens = {
  SPRITES_TOKEN: 'org-e2e/11111111-1111-4111-8111-111111111111/tokene2e/sprites-secret-e2e-9f3a7c',
  SPRITE_TOKEN: 'org-e2e/11111111-1111-4111-8111-111111111111/tokene2e/sprites-secret-e2e-9f3a7c',
}

// The sprite CLI reads SPRITE_TOKEN. Cast copies SPRITES_TOKEN onto it when
// SPRITE_TOKEN is unset. Leaving it out of the cast environment is what
// exercises that copy; the sampler still sees the value via tokens.json.
export const omitFromEnv = ['SPRITE_TOKEN']

function assertSpriteResources(fx) {
  assertIncludes(blob(fx), 'sprite create cast-smoke')
}

export async function handleShim(api) {
  if (api.bin !== 'sprite') return false
  const {args, stateDir} = api
  if (args[0] === 'list') api.finish(0, 'NAME\n')
  if (args[0] === 'create') {
    const name = args[1] || ''
    const created = api.updateWorld(stateDir, world => {
      world.counts.create += 1
      if (world.sprites[name]) return false
      world.sprites[name] = {exists: true}
      return true
    })
    if (created === false) api.finish(0, 'sprite already exists\n')
    api.finish(0, `created ${name}\n`)
  }
  if (args[0] === 'destroy') {
    const name = args[1] || ''
    api.updateWorld(stateDir, world => {
      delete world.sprites[name]
    })
    api.finish(0, `destroyed ${name}\n`)
  }
  if (args[0] === 'url') {
    const base = process.env.CAST_E2E_HTTP_BASE || ''
    api.finish(0, `${base}\n`)
  }
  if (args[0] === 'proxy') {
    api.recordRequest(stateDir, {
      bin: api.bin,
      argv: args,
      remote: api.remote,
      cwd: process.cwd(),
      env: api.envFlags(),
    })
    setInterval(() => {}, 1000)
    return true
  }
  if (args[0] === 'exec') {
    const text = api.remote
    if (text.includes('base64 -d') || text.includes('services create cast-agent')) {
      const stdin = await api.readStdin()
      const marker = stdin.match(/---CAST-ATTEMPT-[0-9]+-[0-9a-f]+---/)
      if (text.includes('services create cast-agent')) {
        api.updateWorld(stateDir, (world, scenario) => {
          world.counts.yaml += 1
          if (marker) world.marker = marker[0]
          world.yamlBroken = api.faultHit(scenario.yaml, world.counts.yaml)
        })
      }
    }
    if (text.includes('/venv/bin/pip install')) {
      const failed = api.updateWorld(stateDir, (world, scenario) => {
        world.counts.pip += 1
        if (scenario.cliTimeout) return 'timeout'
        return api.faultHit(scenario.pip, world.counts.pip)
      })
      if (failed === 'timeout') api.finish(124, '', 'timed out after 30000ms\n')
      if (failed) {
        const count = api.updateWorld(stateDir, world => world.counts.pip)
        api.finish(1, '', `fault injected by test shim: pip install blocked (call ${count})\n`)
      }
    }
    if (text === 'echo ready' || text.endsWith(' echo ready') || args.includes('ready')) {
      api.finish(0, 'ready\n')
    }
    if (text.includes('---CAST-LOG---') || text.includes('services get cast-agent')) {
      const world = api.updateWorld(stateDir, current => current)
      const marker = world.marker || '---CAST-ATTEMPT-0-0---'
      const body = world.yamlBroken
        ? 'Error loading agent config\n'
        : 'Agent ready\n'
      api.finish(0, `{"status":"running"}\n---CAST-LOG---\n${marker}\n${body}`)
    }
    api.finish(0, '')
  }
  api.finish(0, '')
}

export function handleHttp(ctx) {
  return handleAgentHttp(ctx)
}

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
      assertSpriteResources(fx)
      const sprite = fx.requests().filter(req => req.bin === 'sprite')
      assert(
        sprite.length > 0 && sprite.every(req => req.env && req.env.SPRITES_TOKEN === true && req.env.SPRITE_TOKEN === true),
        'sprite child did not receive SPRITE_TOKEN copied from SPRITES_TOKEN',
      )
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
      assert(countCreates(before, fx.requests()) === 1, `creates ${countCreates(before, fx.requests())}`)
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
      assert(countCreates(before, fx.requests()) === 2, `creates ${countCreates(before, fx.requests())}`)
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
      assert(countCreates(before, fx.requests()) === 2, `creates ${countCreates(before, fx.requests())}`)
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
      assert(countCreates(before, fx.requests()) === 2, `creates ${countCreates(before, fx.requests())}`)
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
      const creates = countCreates(before, fx.requests())
      assert(creates === 1, `flagged restore deployed ${creates} times`)
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assert(row.remote_version_state === 'remote-state-unknown:1.1.0', String(row.remote_version_state))
      assertIncludes(combined(result), 'Restoring 1.0.0 on the remote failed again.')
      assertEnding('sprites.flagged-restore', result.stdout, result.stderr, fx.home)
    },
  },
]
