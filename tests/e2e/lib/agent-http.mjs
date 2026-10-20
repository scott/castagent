// Agent card and A2A JSON-RPC on the shared fake. Fly and Sprites both
// call this from their modules. The server does not special-case them.

export function handleAgentHttp(ctx) {
  const {method, url, body, res, send} = ctx
  if (url.pathname === '/.well-known/agent.json' && method === 'GET') {
    send(res, 200, {name: 'smoke', description: 'mocked agent card'})
    return true
  }
  if ((url.pathname === '/' || url.pathname === '') && method === 'POST') {
    send(res, 200, {
      jsonrpc: '2.0',
      id: body.id || '1',
      result: {name: 'smoke', description: 'mocked agent', url: process.env.CAST_E2E_HTTP_BASE || ''},
    })
    return true
  }
  return false
}
