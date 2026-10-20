import {AGENT, assertEnding} from './harness.mjs'

export function fail(message) {
  throw new Error(message)
}

export function assert(condition, message) {
  if (!condition) fail(message)
}

export function blob(fx) {
  return fx.requests().map(req => [req.bin, req.method, req.path, ...(req.argv || [])].filter(Boolean).join(' ')).join('\n')
}

export function assertIncludes(text, needle) {
  if (!text.includes(needle)) {
    const tail = text.length > 2500 ? text.slice(-2500) : text
    fail(`missing ${JSON.stringify(needle)}\n--- output ---\n${tail}`)
  }
}

export function assertExcludes(text, needle) {
  if (text.includes(needle)) fail(`unexpected ${JSON.stringify(needle)}`)
}

export function assertOk(result, label) {
  if (result.timedOut) fail(`${label} timed out\n${result.stderr}\n${result.stdout}`)
  if (result.code !== 0) {
    fail(`${label} exited ${result.code}\nSTDOUT\n${result.stdout}\nSTDERR\n${result.stderr}`)
  }
}

export function assertFailed(result, label) {
  if (result.timedOut) fail(`${label} timed out\n${result.stderr}\n${result.stdout}`)
  if (result.code === 0) fail(`${label} unexpectedly succeeded\n${result.stdout}`)
}

export function combined(result) {
  return `${result.stdout}\n${result.stderr}`
}

export function oneLive(fx) {
  const rows = fx.liveRows()
  assert(rows.length === 1, `expected 1 live registry row, got ${JSON.stringify(rows)}`)
  return rows[0]
}

export function assertNoLive(fx) {
  const rows = fx.liveRows()
  assert(rows.length === 0, `expected no live registry row, got ${JSON.stringify(rows)}`)
}

export function assertAgentResources(fx, provider) {
  const text = blob(fx)
  if (provider === 'sprites') assertIncludes(text, 'sprite create cast-smoke')
  if (provider === 'fly') assertIncludes(text, 'flyctl apps create cast-smoke')
  if (provider === 'digitalocean') {
    assertIncludes(text, 'doctl compute droplet create cast-smoke')
    const volumes = fx.requests().filter(req => req.bin === 'http' && req.method === 'POST' && req.path === '/v2/volumes')
    assert(volumes.some(req => (req.argv || []).includes('cast-smoke')), `volume name is not the agent name\n${text}`)
  }
}

export function assertAddOnlySshKeys(fx) {
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

export function assertDoBearer(fx) {
  const api = fx.requests().filter(req => req.bin === 'http' && String(req.path).startsWith('/v2/'))
  assert(api.length > 0, 'expected DigitalOcean API requests')
  const missing = api.filter(req => !req.env || req.env.authorizationBearer !== true)
  assert(missing.length === 0, `DigitalOcean request missing bearer: ${JSON.stringify(missing.map(req => req.path))}`)
}

export async function deploy(fx, provider) {
  return fx.cast(['deploy', AGENT, '--provider', provider])
}

export async function connect(fx) {
  return fx.cast(['connect', AGENT])
}

export async function shutdown(fx) {
  return fx.cast(['shutdown', AGENT, '--force'])
}

export async function upgradeTo(fx, version) {
  return fx.cast(['upgrade', AGENT, version], 'y\n')
}

export async function seededDeploy(fx, provider, version = '1.0.0') {
  fx.writeAgent(version)
  fx.seedRelease(version)
  const result = await deploy(fx, provider)
  assertOk(result, `${provider} deploy`)
  return result
}

export {assertEnding, AGENT}
