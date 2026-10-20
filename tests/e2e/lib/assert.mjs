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
