import fs from 'node:fs'
import path from 'node:path'

export function emptyWorld() {
  return {
    sprites: {},
    apps: {},
    droplets: [],
    volumes: [],
    sshKeys: [],
    counts: {pip: 0, yaml: 0, create: 0},
    marker: '',
    yamlBroken: false,
    violations: [],
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function withState(dir, fn) {
  const lock = path.join(dir, 'lock')
  const started = Date.now()
  for (;;) {
    try {
      fs.mkdirSync(lock)
      break
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error
      if (Date.now() - started > 5000) {
        fs.rmSync(lock, {recursive: true, force: true})
        continue
      }
      sleepMs(10)
    }
  }
  try {
    return fn()
  } finally {
    fs.rmSync(lock, {recursive: true, force: true})
  }
}

export function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

export function readScenario(dir) {
  return readJson(path.join(dir, 'scenario.json'), {})
}

export function writeScenario(dir, scenario) {
  fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario))
}

function withDefaults(world) {
  const base = emptyWorld()
  const current = world && typeof world === 'object' ? world : {}
  return {
    ...base,
    ...current,
    sprites: current.sprites || {},
    apps: current.apps || {},
    droplets: current.droplets || [],
    volumes: current.volumes || [],
    sshKeys: current.sshKeys || [],
    violations: current.violations || [],
    counts: {...base.counts, ...(current.counts || {})},
  }
}

export function updateWorld(dir, fn) {
  return withState(dir, () => {
    const file = path.join(dir, 'world.json')
    const world = withDefaults(readJson(file, emptyWorld()))
    const result = fn(world, readScenario(dir))
    fs.writeFileSync(file, JSON.stringify(world))
    return result
  })
}

export function resetCounts(dir) {
  updateWorld(dir, world => {
    world.counts = {pip: 0, yaml: 0, create: 0}
  })
}

export function tokenNamesIn(text, tokens) {
  const hits = []
  for (const [name, value] of Object.entries(tokens || {})) {
    if (typeof value === 'string' && value.length >= 8 && text.includes(value)) hits.push(name)
  }
  return hits
}

export function recordRequest(dir, entry) {
  const argv = Array.isArray(entry.argv) ? entry.argv : []
  const remote = typeof entry.remote === 'string' ? entry.remote : ''
  const urlPath = typeof entry.path === 'string' ? entry.path : ''
  const blob = `${entry.bin || ''} ${entry.method || ''} ${urlPath} ${argv.join(' ')} ${remote}`
  const tokenInArgv = tokenNamesIn(blob, readJson(path.join(dir, 'tokens.json'), {}))
  const row = {
    bin: entry.bin || '',
    method: entry.method || '',
    path: urlPath,
    argv,
    remote: remote.slice(0, 240),
    cwd: entry.cwd || '',
    env: entry.env || {},
    tokenInArgv,
  }
  withState(dir, () => {
    fs.appendFileSync(path.join(dir, 'requests.jsonl'), `${JSON.stringify(row)}\n`)
    if (tokenInArgv.length > 0) {
      const worldFile = path.join(dir, 'world.json')
      const world = withDefaults(readJson(worldFile, emptyWorld()))
      world.violations.push({kind: 'token-argv', bin: row.bin, names: tokenInArgv})
      fs.writeFileSync(worldFile, JSON.stringify(world))
    }
  })
  return row
}

export function readRequests(dir) {
  const file = path.join(dir, 'requests.jsonl')
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
}

export function readWorld(dir) {
  return withDefaults(readJson(path.join(dir, 'world.json'), emptyWorld()))
}

export function faultHit(spec, count) {
  if (!spec || typeof spec !== 'object') return false
  if (typeof spec.once === 'number') return count === spec.once
  if (typeof spec.from === 'number') return count >= spec.from
  return false
}
