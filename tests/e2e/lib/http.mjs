import http from 'node:http'
import {readWorld, recordRequest, updateWorld} from './state.mjs'

export const VOLUME_ID = '11111111-1111-4111-8111-111111111111'
export const DROPLET_ID = '424242'
export const DROPLET_IP = '203.0.113.10'
const SSH_KEY_ID = 42

function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {'content-type': 'application/json'})
  res.end(payload)
}

function bearerOk(req) {
  const header = req.headers.authorization || ''
  const token = process.env.DIGITALOCEAN_ACCESS_TOKEN || ''
  return token.length > 0 && header === `Bearer ${token}`
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function volumeRecord(volume) {
  return {
    id: volume.id,
    name: volume.name,
    region: {slug: volume.region},
    droplet_ids: volume.dropletIds,
    filesystem_type: 'ext4',
  }
}

export function startFakeHttp(stateDir) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const method = req.method || 'GET'
    const body = method === 'GET' || method === 'DELETE' ? {} : await readBody(req)
    const note = typeof body.name === 'string' ? body.name : ''
    recordRequest(stateDir, {
      bin: 'http',
      method,
      path: `${url.pathname}${url.search}`,
      argv: note ? [note] : [],
      remote: note,
      env: {authorizationBearer: bearerOk(req)},
    })

    if (method === 'DELETE' || (method !== 'GET' && method !== 'POST' && url.pathname.startsWith('/v2/account/keys'))) {
      updateWorld(stateDir, world => {
        world.violations.push({kind: 'ssh-key-write', method, path: url.pathname})
      })
      send(res, 403, {id: 'forbidden', message: 'account SSH keys are add-only'})
      return
    }

    if (url.pathname === '/v2/account/keys' && method === 'GET') {
      const world = readWorld(stateDir)
      send(res, 200, {ssh_keys: world.sshKeys, links: {}})
      return
    }

    if (url.pathname === '/v2/account/keys' && method === 'POST') {
      const created = {id: SSH_KEY_ID, name: body.name || 'cast-do-key', fingerprint: 'aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'}
      updateWorld(stateDir, world => {
        world.sshKeys.push(created)
      })
      send(res, 201, {ssh_key: created})
      return
    }

    if (url.pathname === '/v2/volumes' && method === 'GET') {
      const name = url.searchParams.get('name')
      const region = url.searchParams.get('region')
      const world = readWorld(stateDir)
      const volumes = world.volumes.filter(volume =>
        (!name || volume.name === name) && (!region || volume.region === region))
      send(res, 200, {volumes: volumes.map(volumeRecord)})
      return
    }

    if (url.pathname === '/v2/volumes' && method === 'POST') {
      const volume = {
        id: VOLUME_ID,
        name: String(body.name || ''),
        region: String(body.region || 'nyc3'),
        dropletIds: [],
      }
      updateWorld(stateDir, world => {
        world.volumes.push(volume)
      })
      send(res, 201, {volume: volumeRecord(volume)})
      return
    }

    const action = url.pathname.match(/^\/v2\/volumes\/([^/]+)\/actions\/([^/]+)$/)
    if (action && method === 'GET') {
      send(res, 200, {action: {id: Number(action[2]), status: 'completed'}})
      return
    }

    const actions = url.pathname.match(/^\/v2\/volumes\/([^/]+)\/actions$/)
    if (actions && method === 'POST') {
      const dropletId = Number(body.droplet_id)
      updateWorld(stateDir, world => {
        const volume = world.volumes.find(item => item.id === actions[1])
        if (volume && Number.isInteger(dropletId) && !volume.dropletIds.includes(dropletId)) {
          volume.dropletIds.push(dropletId)
        }
      })
      send(res, 201, {action: {id: 7, status: 'completed'}})
      return
    }

    const oneVolume = url.pathname.match(/^\/v2\/volumes\/([^/]+)$/)
    if (oneVolume && method === 'GET') {
      const world = readWorld(stateDir)
      const volume = world.volumes.find(item => item.id === oneVolume[1])
      if (!volume) {
        send(res, 404, {id: 'not_found', message: 'volume not found'})
        return
      }
      send(res, 200, {volume: volumeRecord(volume)})
      return
    }

    const droplet = url.pathname.match(/^\/v2\/droplets\/([^/]+)$/)
    if (droplet && method === 'GET') {
      const world = readWorld(stateDir)
      const found = world.droplets.some(item => item.id === droplet[1])
      if (!found) {
        send(res, 404, {id: 'not_found', message: 'droplet not found'})
        return
      }
      send(res, 200, {droplet: {id: Number(droplet[1])}})
      return
    }

    if (url.pathname === '/.well-known/agent.json' && method === 'GET') {
      send(res, 200, {name: 'smoke', description: 'mocked agent card'})
      return
    }

    if ((url.pathname === '/' || url.pathname === '') && method === 'POST') {
      send(res, 200, {
        jsonrpc: '2.0',
        id: body.id || '1',
        result: {name: 'smoke', description: 'mocked agent', url: process.env.CAST_E2E_HTTP_BASE || ''},
      })
      return
    }

    send(res, 404, {id: 'not_found', message: `no fake route for ${method} ${url.pathname}`})
  })

  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () => new Promise(done => server.close(() => done())),
      })
    })
  })
}
