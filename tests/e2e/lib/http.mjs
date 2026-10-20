import http from 'node:http'
import {readWorld, recordRequest, updateWorld} from './state.mjs'

export {DROPLET_ID, DROPLET_IP, SSH_KEY_ID, VOLUME_ID} from './ids.mjs'

function send(res, status, body) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {'content-type': 'application/json'})
  res.end(payload)
}

function bearerOk(req, accessToken) {
  const header = req.headers.authorization || ''
  return accessToken.length > 0 && header === `Bearer ${accessToken}`
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

export function startFakeHttp(stateDir, accessToken = '', handlers = []) {
  const server = http.createServer(async (req, res) => {
    try {
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
        env: {authorizationBearer: bearerOk(req, accessToken)},
      })
      const ctx = {
        stateDir,
        accessToken,
        method,
        url,
        body,
        req,
        res,
        send,
        updateWorld,
        readWorld,
      }
      for (const handle of handlers) {
        if (await handle(ctx)) return
      }
      send(res, 404, {id: 'not_found', message: `no fake route for ${method} ${url.pathname}`})
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!res.headersSent) send(res, 500, {id: 'fake_error', message})
      else res.end()
    }
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
