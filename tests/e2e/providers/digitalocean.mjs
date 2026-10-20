import http from 'node:http'
import {DROPLET_ID, DROPLET_IP, SSH_KEY_ID, VOLUME_ID} from '../lib/ids.mjs'
import {
  AGENT,
  assert,
  assertAddOnlySshKeys,
  assertAgentResources,
  assertDoBearer,
  assertEnding,
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

export const shims = ['doctl', 'docker', 'ssh']

function volumeRecord(volume) {
  return {
    id: volume.id,
    name: volume.name,
    region: {slug: volume.region},
    droplet_ids: volume.dropletIds,
    filesystem_type: 'ext4',
  }
}

function isDoctlSshKeyDelete(argv) {
  if (!argv.includes('ssh-key')) return false
  return argv.some(arg => arg === 'delete' || arg === 'rm' || arg === 'd')
}

export async function handleShim(api) {
  const {bin, args, joined, stateDir, remote} = api
  if (bin === 'doctl') {
    if (isDoctlSshKeyDelete(args)) {
      api.updateWorld(stateDir, world => {
        world.violations.push({kind: 'doctl-ssh-key-delete', argv: args})
      })
      api.finish(1, '', 'refusing to delete an account SSH key\n')
    }
    if (args[0] === 'account') api.finish(0, 'e2e\n')
    if (joined.startsWith('compute droplet list')) {
      const lines = api.updateWorld(stateDir, world => world.droplets.map(item => `${item.id} ${item.name} ${item.ip}`).join('\n'))
      api.finish(0, lines ? `${lines}\n` : '')
    }
    if (joined.startsWith('compute droplet create')) {
      const name = args[3]
      api.updateWorld(stateDir, world => {
        if (!world.droplets.some(item => item.name === name)) {
          world.droplets.push({id: DROPLET_ID, name, ip: DROPLET_IP})
        }
      })
      api.finish(0, `created ${name}\n`)
    }
    if (joined.startsWith('compute droplet get')) {
      const name = args[3]
      const line = api.updateWorld(stateDir, world => {
        const droplet = world.droplets.find(item => item.name === name)
        return droplet ? `${droplet.id} ${droplet.ip}` : ''
      })
      if (!line) api.finish(1, '', `droplet ${name} not found\n`)
      api.finish(0, `${line}\n`)
    }
    if (joined.startsWith('compute droplet delete')) {
      const id = args[3]
      api.updateWorld(stateDir, world => {
        world.droplets = world.droplets.filter(item => item.id !== id)
      })
      api.finish(0, `deleted ${id}\n`)
    }
    if (joined.startsWith('compute volume list')) {
      const namesOnly = args.includes('Name') && !joined.includes('ID,Name')
      const lines = api.updateWorld(stateDir, world => {
        if (namesOnly) return world.volumes.map(item => item.name).join('\n')
        return world.volumes.map(item => `${item.id} ${item.name} ${item.region}`).join('\n')
      })
      api.finish(0, lines ? `${lines}\n` : '')
    }
    if (joined.startsWith('compute volume delete')) {
      const id = args[3]
      api.updateWorld(stateDir, world => {
        world.volumes = world.volumes.filter(item => item.id !== id)
      })
      api.finish(0, `deleted ${id}\n`)
    }
    api.finish(1, '', `e2e doctl: unhandled ${joined}\n`)
  }

  if (bin === 'docker') {
    if (args[0] === 'buildx' || args[0] === 'build') {
      const failed = api.updateWorld(stateDir, (world, scenario) => {
        if (args[0] === 'buildx' && scenario.dockerBuildFail) return true
        if (args[0] === 'build' && scenario.upgradeDeployFail) return true
        return false
      })
      if (failed) api.finish(1, '', 'docker build failed\n')
      api.finish(0, '')
    }
    if (args[0] === 'push') api.finish(0, '')
    if (args[0] === 'save') api.finish(0, 'fake-image')
    api.finish(0, '')
  }

  if (bin === 'ssh') {
    if (args.includes('-N') && args.includes('-L')) {
      api.recordRequest(stateDir, {
        bin,
        argv: args,
        remote,
        cwd: process.cwd(),
        env: api.envFlags(),
      })
      const forward = args[args.indexOf('-L') + 1] || ''
      const port = Number(forward.split(':')[1])
      const tunnel = http.createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1')
        if (req.method === 'GET' && url.pathname === '/.well-known/agent.json') {
          res.writeHead(200, {'content-type': 'application/json'})
          res.end(JSON.stringify({name: 'smoke'}))
          return
        }
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          let body = {}
          try {
            body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
          } catch {
            body = {}
          }
          res.writeHead(200, {'content-type': 'application/json'})
          res.end(JSON.stringify({
            jsonrpc: '2.0',
            id: body.id || '1',
            result: {name: 'smoke', description: 'tunneled agent'},
          }))
        })
      })
      tunnel.listen(port, '127.0.0.1')
      return true
    }
    if (remote.includes('gunzip') || remote.includes('cat >')) await api.readStdin()
    if (remote.includes('---CAST-LOGS---')) {
      const failed = api.updateWorld(stateDir, (world, scenario) => scenario.doHealthFail === true)
      if (failed) api.finish(0, 'exited\n---CAST-LOGS---\nError loading agent config\n')
      api.finish(0, 'running\n---CAST-LOGS---\nAgent ready\n')
    }
    if (remote.includes('blkid') || remote.includes('---CAST-VOLUME---')) {
      const mount = /mnt='([^']+)'/.exec(remote)?.[1] || '/mnt/cast-smoke'
      api.finish(0, [
        '---CAST-VOLUME---',
        'formatted=1',
        'filesystem=ext4',
        `uuid=${VOLUME_ID}`,
        `mount=${mount}`,
        'source=/dev/disk/by-id/scsi-0DO_Volume_cast-smoke',
        '',
      ].join('\n'))
    }
    if (remote.includes('stat -c %d')) api.finish(0, 'container=ok\n')
    if (remote.includes('docker inspect')) api.finish(0, 'cast-smoke:latest\n')
    if (remote === 'echo ok') api.finish(0, 'ok\n')
    api.finish(0, '')
  }
  return false
}

export function handleHttp(ctx) {
  const {method, url, body, res, send, stateDir} = ctx
  const keyPath = url.pathname === '/v2/account/keys' || url.pathname.startsWith('/v2/account/keys/')
  if (keyPath && method === 'DELETE') {
    ctx.updateWorld(stateDir, world => {
      world.violations.push({kind: 'ssh-key-write', method, path: url.pathname})
    })
    send(res, 403, {id: 'forbidden', message: 'account SSH keys are add-only'})
    return true
  }
  if (keyPath && method !== 'GET' && method !== 'POST') {
    ctx.updateWorld(stateDir, world => {
      world.violations.push({kind: 'ssh-key-modify', method, path: url.pathname})
    })
    send(res, 403, {id: 'forbidden', message: 'account SSH keys are add-only'})
    return true
  }
  if (url.pathname === '/v2/account/keys' && method === 'GET') {
    const world = ctx.readWorld(stateDir)
    send(res, 200, {ssh_keys: world.sshKeys, links: {}})
    return true
  }
  if (url.pathname === '/v2/account/keys' && method === 'POST') {
    const created = {
      id: SSH_KEY_ID,
      name: body.name || 'cast-do-key',
      fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
    }
    ctx.updateWorld(stateDir, world => {
      world.sshKeys.push(created)
    })
    send(res, 201, {ssh_key: created})
    return true
  }
  if (url.pathname === '/v2/volumes' && method === 'GET') {
    const name = url.searchParams.get('name')
    const region = url.searchParams.get('region')
    const world = ctx.readWorld(stateDir)
    const volumes = world.volumes.filter(volume =>
      (!name || volume.name === name) && (!region || volume.region === region))
    send(res, 200, {volumes: volumes.map(volumeRecord)})
    return true
  }
  if (url.pathname === '/v2/volumes' && method === 'POST') {
    const volume = {
      id: VOLUME_ID,
      name: String(body.name || ''),
      region: String(body.region || 'nyc3'),
      dropletIds: [],
    }
    ctx.updateWorld(stateDir, world => {
      world.volumes.push(volume)
    })
    send(res, 201, {volume: volumeRecord(volume)})
    return true
  }
  const action = url.pathname.match(/^\/v2\/volumes\/([^/]+)\/actions\/([^/]+)$/)
  if (action && method === 'GET') {
    send(res, 200, {action: {id: Number(action[2]), status: 'completed'}})
    return true
  }
  const actions = url.pathname.match(/^\/v2\/volumes\/([^/]+)\/actions$/)
  if (actions && method === 'POST') {
    const dropletId = Number(body.droplet_id)
    ctx.updateWorld(stateDir, world => {
      const volume = world.volumes.find(item => item.id === actions[1])
      if (volume && Number.isInteger(dropletId) && !volume.dropletIds.includes(dropletId)) {
        volume.dropletIds.push(dropletId)
      }
    })
    send(res, 201, {action: {id: 7, status: 'completed'}})
    return true
  }
  const oneVolume = url.pathname.match(/^\/v2\/volumes\/([^/]+)$/)
  if (oneVolume && method === 'GET') {
    const world = ctx.readWorld(stateDir)
    const volume = world.volumes.find(item => item.id === oneVolume[1])
    if (!volume) {
      send(res, 404, {id: 'not_found', message: 'volume not found'})
      return true
    }
    send(res, 200, {volume: volumeRecord(volume)})
    return true
  }
  const droplet = url.pathname.match(/^\/v2\/droplets\/([^/]+)$/)
  if (droplet && method === 'GET') {
    const world = ctx.readWorld(stateDir)
    const found = world.droplets.some(item => item.id === droplet[1])
    if (!found) {
      send(res, 404, {id: 'not_found', message: 'droplet not found'})
      return true
    }
    send(res, 200, {droplet: {id: Number(droplet[1])}})
    return true
  }
  return false
}

const DO_DOUBLE = 'DigitalOcean upgrade builds a container with docker. It does not run the sprite pip or agent.yaml fault points. A failed deploy\'s droplet and volume deletes are do.cleanup.'

export const cases = [
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
    id: 'digitalocean.upgrade-failure',
    provider: 'digitalocean',
    name: 'upgrade-failure',
    async run(fx) {
      await seededDeploy(fx, 'digitalocean')
      fx.seedRelease('1.1.0')
      fx.setScenario({upgradeDeployFail: true})
      const result = await upgradeTo(fx, '1.1.0')
      assertFailed(result, 'digitalocean upgrade failure')
      const row = oneLive(fx)
      assert(row.deployed_version === '1.0.0', row.deployed_version)
      assertIncludes(combined(result), 'You can try rolling back by deploying the previous version:')
      assertIncludes(combined(result), 'cast deploy smoke --provider digitalocean')
      assertEnding('digitalocean.upgrade-failure', result.stdout, result.stderr, fx.home)
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
]
