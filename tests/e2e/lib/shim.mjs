#!/usr/bin/env node
// Fake provider CLI. The basename on PATH selects sprite, flyctl, doctl, docker, ssh, gzip, or bun.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import {DROPLET_ID, DROPLET_IP, VOLUME_ID} from './http.mjs'
import {faultHit, recordRequest, updateWorld} from './state.mjs'

const stateDir = process.env.CAST_E2E_STATE
if (!stateDir) {
  process.stderr.write('e2e shim: CAST_E2E_STATE is not set\n')
  process.exit(2)
}

const bin = path.basename(process.argv[1] || '')
const args = process.argv.slice(2)
const joined = args.join(' ')

function envFlags() {
  return {
    SPRITE_TOKEN: Boolean(process.env.SPRITE_TOKEN),
    SPRITES_TOKEN: Boolean(process.env.SPRITES_TOKEN),
    FLY_API_TOKEN: Boolean(process.env.FLY_API_TOKEN),
    DIGITALOCEAN_ACCESS_TOKEN: Boolean(process.env.DIGITALOCEAN_ACCESS_TOKEN),
  }
}

function remoteOf(argv) {
  const dash = argv.indexOf('--')
  if (dash !== -1) return argv.slice(dash + 1).join(' ')
  const at = argv.findIndex(arg => arg.startsWith('root@'))
  if (at !== -1) return argv.slice(at + 1).join(' ')
  return ''
}

const remote = remoteOf(args)

function finish(code, stdout = '', stderr = '') {
  recordRequest(stateDir, {bin, argv: args, remote, cwd: process.cwd(), env: envFlags()})
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  process.exit(code)
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function appFlag() {
  const index = args.indexOf('--app')
  if (index !== -1 && args[index + 1]) return args[index + 1]
  return ''
}

function ensureApp(world, name) {
  if (!world.apps[name]) world.apps[name] = {volumes: [], deployed: false}
  return world.apps[name]
}

if (args.includes('--version') || (bin === 'docker' && args[0] === '--version') || (bin === 'doctl' && args[0] === 'version')) {
  finish(0, `${bin} e2e-fake\n`)
}

if (bin === 'bun') finish(0, '')

if (bin === 'gzip') {
  await readStdin()
  finish(0, 'gz\n')
}

if (bin === 'sprite') {
  if (args[0] === 'list') finish(0, 'NAME\n')
  if (args[0] === 'create') {
    const name = args[1] || ''
    const created = updateWorld(stateDir, world => {
      world.counts.create += 1
      if (world.sprites[name]) return false
      world.sprites[name] = {exists: true}
      return true
    })
    if (created === false) finish(0, 'sprite already exists\n')
    finish(0, `created ${name}\n`)
  }
  if (args[0] === 'destroy') {
    const name = args[1] || ''
    updateWorld(stateDir, world => {
      delete world.sprites[name]
    })
    finish(0, `destroyed ${name}\n`)
  }
  if (args[0] === 'url') {
    const base = process.env.CAST_E2E_HTTP_BASE || ''
    finish(0, `${base}\n`)
  }
  if (args[0] === 'proxy') {
    recordRequest(stateDir, {bin, argv: args, remote, cwd: process.cwd(), env: envFlags()})
    setInterval(() => {}, 1000)
  } else if (args[0] === 'exec') {
    const text = remote
    if (text.includes('base64 -d') || text.includes('services create cast-agent')) {
      const stdin = await readStdin()
      const marker = stdin.match(/---CAST-ATTEMPT-[0-9]+-[0-9a-f]+---/)
      if (text.includes('services create cast-agent')) {
        updateWorld(stateDir, (world, scenario) => {
          world.counts.yaml += 1
          if (marker) world.marker = marker[0]
          world.yamlBroken = faultHit(scenario.yaml, world.counts.yaml)
        })
      }
    }
    if (text.includes('/venv/bin/pip install')) {
      const failed = updateWorld(stateDir, (world, scenario) => {
        world.counts.pip += 1
        if (scenario.cliTimeout) return 'timeout'
        return faultHit(scenario.pip, world.counts.pip)
      })
      if (failed === 'timeout') finish(124, '', 'timed out after 30000ms\n')
      if (failed) {
        const count = updateWorld(stateDir, world => world.counts.pip)
        finish(1, '', `fault injected by test shim: pip install blocked (call ${count})\n`)
      }
    }
    if (text === 'echo ready' || text.endsWith(' echo ready') || args.includes('ready')) {
      finish(0, 'ready\n')
    }
    if (text.includes('---CAST-LOG---') || text.includes('services get cast-agent')) {
      const world = updateWorld(stateDir, current => current)
      const marker = world.marker || '---CAST-ATTEMPT-0-0---'
      const body = world.yamlBroken
        ? 'Error loading agent config\n'
        : 'Agent ready\n'
      finish(0, `{"status":"running"}\n---CAST-LOG---\n${marker}\n${body}`)
    }
    finish(0, '')
  } else {
    finish(0, '')
  }
}

if (bin === 'flyctl') {
  const app = appFlag() || args[2] || ''
  if (args[0] === 'status') {
    const exists = updateWorld(stateDir, world => Boolean(world.apps[app] && !world.apps[app].destroyed))
    if (!exists) finish(1, '', 'Could not find App\n')
    finish(0, 'running\n')
  }
  if (args[0] === 'apps' && args[1] === 'create') {
    const name = args[2]
    updateWorld(stateDir, world => {
      ensureApp(world, name)
    })
    finish(0, `created ${name}\n`)
  }
  if (args[0] === 'apps' && args[1] === 'destroy') {
    updateWorld(stateDir, world => {
      const record = world.apps[app]
      if (record) record.destroyed = true
    })
    finish(0, `destroyed ${app}\n`)
  }
  if (args[0] === 'volumes' && args[1] === 'list') {
    const volumes = updateWorld(stateDir, world => ensureApp(world, app).volumes.slice())
    finish(0, `${JSON.stringify(volumes)}\n`)
  }
  if (args[0] === 'volumes' && args[1] === 'create') {
    const name = args[2]
    updateWorld(stateDir, world => {
      const record = ensureApp(world, app)
      record.volumes.push({id: `vol_${name}`, name})
    })
    finish(0, `created ${name}\n`)
  }
  if (args[0] === 'volumes' && args[1] === 'delete') {
    const id = args[2]
    updateWorld(stateDir, world => {
      const record = ensureApp(world, app)
      record.volumes = record.volumes.filter(volume => volume.id !== id)
    })
    finish(0, `deleted ${id}\n`)
  }
  if (args[0] === 'secrets') {
    await readStdin()
    finish(0, '')
  }
  if (args[0] === 'deploy') {
    const failed = updateWorld(stateDir, (world, scenario) => {
      if (args.includes('--detach') && scenario.upgradeDeployFail) return true
      if (!args.includes('--detach') && scenario.flyDeployFail) return true
      const record = ensureApp(world, app || 'from-cwd')
      record.deployed = true
      return false
    })
    if (failed) finish(1, '', 'fly deploy failed\n')
    finish(0, 'deployed\n')
  }
  if (args[0] === 'machines' && args[1] === 'list') {
    const deployed = updateWorld(stateDir, world => Boolean(world.apps[app]?.deployed))
    const body = deployed ? [{id: 'm1', state: 'started'}] : []
    finish(0, `${JSON.stringify(body)}\n`)
  }
  if (args[0] === 'machine' && args[1] === 'destroy') {
    finish(0, `destroyed ${args[2]}\n`)
  }
  if (args[0] === 'logs') finish(0, 'Agent ready\n')
  finish(1, '', `e2e flyctl: unhandled ${joined}\n`)
}

if (bin === 'doctl') {
  if (args.includes('ssh-key') && args.includes('delete')) {
    updateWorld(stateDir, world => {
      world.violations.push({kind: 'doctl-ssh-key-delete', argv: args})
    })
    finish(1, '', 'refusing to delete an account SSH key\n')
  }
  if (args[0] === 'account') finish(0, 'e2e\n')
  if (joined.startsWith('compute droplet list')) {
    const lines = updateWorld(stateDir, world => world.droplets.map(item => `${item.id} ${item.name} ${item.ip}`).join('\n'))
    finish(0, lines ? `${lines}\n` : '')
  }
  if (joined.startsWith('compute droplet create')) {
    const name = args[3]
    updateWorld(stateDir, world => {
      if (!world.droplets.some(item => item.name === name)) {
        world.droplets.push({id: DROPLET_ID, name, ip: DROPLET_IP})
      }
    })
    finish(0, `created ${name}\n`)
  }
  if (joined.startsWith('compute droplet get')) {
    const name = args[3]
    const line = updateWorld(stateDir, world => {
      const droplet = world.droplets.find(item => item.name === name)
      return droplet ? `${droplet.id} ${droplet.ip}` : ''
    })
    if (!line) finish(1, '', `droplet ${name} not found\n`)
    finish(0, `${line}\n`)
  }
  if (joined.startsWith('compute droplet delete')) {
    const id = args[3]
    updateWorld(stateDir, world => {
      world.droplets = world.droplets.filter(item => item.id !== id)
    })
    finish(0, `deleted ${id}\n`)
  }
  if (joined.startsWith('compute volume list')) {
    const namesOnly = args.includes('Name') && !joined.includes('ID,Name')
    const lines = updateWorld(stateDir, world => {
      if (namesOnly) return world.volumes.map(item => item.name).join('\n')
      return world.volumes.map(item => `${item.id} ${item.name} ${item.region}`).join('\n')
    })
    finish(0, lines ? `${lines}\n` : '')
  }
  if (joined.startsWith('compute volume delete')) {
    const id = args[3]
    updateWorld(stateDir, world => {
      world.volumes = world.volumes.filter(item => item.id !== id)
    })
    finish(0, `deleted ${id}\n`)
  }
  finish(0, '')
}

if (bin === 'docker') {
  if (args[0] === 'buildx' || args[0] === 'build') {
    const failed = updateWorld(stateDir, (world, scenario) => {
      if (args[0] === 'buildx' && scenario.dockerBuildFail) return true
      if (args[0] === 'build' && scenario.upgradeDeployFail) return true
      return false
    })
    if (failed) finish(1, '', 'docker build failed\n')
    finish(0, '')
  }
  if (args[0] === 'push') finish(0, '')
  if (args[0] === 'save') finish(0, 'fake-image')
  finish(0, '')
}

if (bin === 'ssh') {
  if (args.includes('-N') && args.includes('-L')) {
    recordRequest(stateDir, {bin, argv: args, remote, cwd: process.cwd(), env: envFlags()})
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
  } else {
  if (remote.includes('gunzip') || remote.includes('cat >')) await readStdin()
  if (remote.includes('---CAST-LOGS---')) {
    const failed = updateWorld(stateDir, (world, scenario) => scenario.doHealthFail === true)
    if (failed) finish(0, 'exited\n---CAST-LOGS---\nError loading agent config\n')
    finish(0, 'running\n---CAST-LOGS---\nAgent ready\n')
  }
  if (remote.includes('blkid') || remote.includes('---CAST-VOLUME---')) {
    const mount = /mnt='([^']+)'/.exec(remote)?.[1] || `/mnt/cast-smoke`
    finish(0, [
      '---CAST-VOLUME---',
      'formatted=1',
      'filesystem=ext4',
      `uuid=${VOLUME_ID}`,
      `mount=${mount}`,
      'source=/dev/disk/by-id/scsi-0DO_Volume_cast-smoke',
      '',
    ].join('\n'))
  }
  if (remote.includes('stat -c %d')) finish(0, 'container=ok\n')
  if (remote.includes('docker inspect')) finish(0, 'cast-smoke:latest\n')
  if (remote === 'echo ok') finish(0, 'ok\n')
  finish(0, '')
  }
}

finish(1, '', `e2e shim: unhandled ${bin} ${joined}\n`)
