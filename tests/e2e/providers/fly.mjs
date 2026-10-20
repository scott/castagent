import {handleAgentHttp} from '../lib/agent-http.mjs'
import {
  AGENT,
  assert,
  assertAgentResources,
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

export const shims = ['flyctl']

function ensureApp(world, name) {
  if (!world.apps[name]) world.apps[name] = {volumes: [], deployed: false}
  return world.apps[name]
}

export async function handleShim(api) {
  if (api.bin !== 'flyctl') return false
  const {args, stateDir, joined} = api
  const app = api.appFlag() || args[2] || ''
  if (args[0] === 'status') {
    const exists = api.updateWorld(stateDir, world => Boolean(world.apps[app] && !world.apps[app].destroyed))
    if (!exists) api.finish(1, '', 'Could not find App\n')
    api.finish(0, 'running\n')
  }
  if (args[0] === 'apps' && args[1] === 'create') {
    const name = args[2]
    api.updateWorld(stateDir, world => {
      ensureApp(world, name)
    })
    api.finish(0, `created ${name}\n`)
  }
  if (args[0] === 'apps' && args[1] === 'destroy') {
    api.updateWorld(stateDir, world => {
      const record = world.apps[app]
      if (record) record.destroyed = true
    })
    api.finish(0, `destroyed ${app}\n`)
  }
  if (args[0] === 'volumes' && args[1] === 'list') {
    const volumes = api.updateWorld(stateDir, world => ensureApp(world, app).volumes.slice())
    api.finish(0, `${JSON.stringify(volumes)}\n`)
  }
  if (args[0] === 'volumes' && args[1] === 'create') {
    const name = args[2]
    api.updateWorld(stateDir, world => {
      const record = ensureApp(world, app)
      record.volumes.push({id: `vol_${name}`, name})
    })
    api.finish(0, `created ${name}\n`)
  }
  if (args[0] === 'volumes' && args[1] === 'delete') {
    const id = args[2]
    api.updateWorld(stateDir, world => {
      const record = ensureApp(world, app)
      record.volumes = record.volumes.filter(volume => volume.id !== id)
    })
    api.finish(0, `deleted ${id}\n`)
  }
  if (args[0] === 'secrets') {
    await api.readStdin()
    api.finish(0, '')
  }
  if (args[0] === 'deploy') {
    const failed = api.updateWorld(stateDir, (world, scenario) => {
      if (args.includes('--detach') && scenario.upgradeDeployFail) return true
      if (!args.includes('--detach') && scenario.flyDeployFail) return true
      const record = ensureApp(world, app || 'from-cwd')
      record.deployed = true
      return false
    })
    if (failed) api.finish(1, '', 'fly deploy failed\n')
    api.finish(0, 'deployed\n')
  }
  if (args[0] === 'machines' && args[1] === 'list') {
    const deployed = api.updateWorld(stateDir, world => Boolean(world.apps[app]?.deployed))
    const body = deployed ? [{id: 'm1', state: 'started'}] : []
    api.finish(0, `${JSON.stringify(body)}\n`)
  }
  if (args[0] === 'machine' && args[1] === 'destroy') {
    api.finish(0, `destroyed ${args[2]}\n`)
  }
  if (args[0] === 'logs') api.finish(0, 'Agent ready\n')
  api.finish(1, '', `e2e flyctl: unhandled ${joined}\n`)
}

export function handleHttp(ctx) {
  return handleAgentHttp(ctx)
}

const FLY_DOUBLE = 'Fly does not install with pip or rewrite agent.yaml at the CLI boundary. A failed flyctl deploy is fly.cleanup.'

export const cases = [
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
    id: 'fly.upgrade-failure',
    provider: 'fly',
    name: 'upgrade-failure',
    async run(fx) {
      await seededDeploy(fx, 'fly')
      fx.seedRelease('1.1.0')
      fx.setScenario({upgradeDeployFail: true})
      const result = await upgradeTo(fx, '1.1.0')
      assertFailed(result, 'fly upgrade failure')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assertIncludes(combined(result), 'You can try rolling back by deploying the previous version:')
      assertIncludes(combined(result), 'cast deploy smoke --provider fly')
      assertEnding('fly.upgrade-failure', result.stdout, result.stderr, fx.home)
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
]
