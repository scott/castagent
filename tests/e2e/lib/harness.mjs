import {execFileSync, spawn} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {createRequire} from 'node:module'
import {fileURLToPath} from 'node:url'
import {startFakeHttp} from './http.mjs'
import {readRequests, readWorld, resetCounts, writeScenario} from './state.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const repoRoot = path.resolve(here, '../../..')
const castBin = path.join(repoRoot, 'typescript/cast-cli/bin/run')
const shimPath = path.join(here, 'shim.mjs')
const require = createRequire(path.join(repoRoot, 'typescript/cast-cli/package.json'))
const Database = require('better-sqlite3')

export const AGENT = 'smoke'

let activeTokens = {}

export function setActiveTokens(tokens) {
  activeTokens = tokens && typeof tokens === 'object' ? tokens : {}
}

export function currentTokens() {
  return activeTokens
}

const ENV_ALLOW = [
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'USER',
  'LOGNAME',
  'LD_LIBRARY_PATH',
]

function allowedEnv(extra) {
  const env = {}
  for (const key of ENV_ALLOW) {
    if (process.env[key]) env[key] = process.env[key]
  }
  if (!env.LANG) env.LANG = 'C.UTF-8'
  return {...env, ...extra}
}

const BUILTIN_SHIMS = ['gzip', 'bun']

function discoverPython() {
  try {
    const text = execFileSync('python3', ['-c', [
      'import site, sys',
      'print(sys.executable)',
      'print(site.getusersitepackages())',
      'print("\\n".join(site.getsitepackages()))',
    ].join('; ')], {encoding: 'utf8'})
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
    const executable = lines[0] || ''
    const sites = lines.slice(1)
    return {
      binDir: executable ? path.dirname(executable) : '',
      pythonPath: [...sites, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    }
  } catch {
    return {binDir: '', pythonPath: process.env.PYTHONPATH || ''}
  }
}

const python = discoverPython()

export function catA(text) {
  return text.split('\n').map(line => `${line.replace(/\t/g, '^I').replace(/\r/g, '^M')}$`).join('\n')
}

export function normalizeOutput(text, home) {
  return text
    .replaceAll(home, '<home>')
    .replaceAll(repoRoot, '<repo>')
    .replace(/cast-do-key-[0-9a-f]{8}(?:-[0-9]+)?/g, 'cast-do-key-<fp>')
    .replace(/http:\/\/127\.0\.0\.1:\d+/g, '<fake-http>')
    .replace(/127\.0\.0\.1:\d+/g, '127.0.0.1:<port>')
    .replace(/Tar file size: [0-9.]+MB/g, 'Tar file size: <size>MB')
    .replace(/deployment SHA: [a-f0-9]{6}/g, 'deployment SHA: <sha>')
    .replace(/Connect with: cast connect [a-f0-9]{6}/g, 'Connect with: cast connect <sha>')
    .replace(/\(deployment: [a-f0-9]{6}\)/g, '(deployment: <sha>')
}

export function tailLines(text, count) {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.slice(-count).join('\n')
}

export function assertEnding(id, stdout, stderr, home) {
  const actual = [
    '# stderr, last 12 lines, cat -A',
    catA(tailLines(normalizeOutput(stderr, home), 12)),
    '# stdout, last 14 lines, cat -A',
    catA(tailLines(normalizeOutput(stdout, home), 14)),
    '',
  ].join('\n')
  const file = path.join(repoRoot, 'tests/e2e/endings', `${id}.txt`)
  if (process.env.UPDATE_ENDINGS === '1' || process.env.UPDATE_SNAPSHOTS === '1') {
    if (process.env.CI) {
      throw new Error('refusing to update snapshots in CI. Run UPDATE_ENDINGS=1 node tests/e2e/run.mjs locally and commit the files.')
    }
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, actual)
    return
  }
  if (!fs.existsSync(file)) {
    throw new Error(`missing ending snapshot ${file}\n--- actual ---\n${actual}`)
  }
  const expected = fs.readFileSync(file, 'utf8')
  if (expected !== actual) {
    throw new Error(`ending mismatch for ${id}\n--- expected ---\n${expected}\n--- actual ---\n${actual}`)
  }
}

function liveRows(home) {
  const dbPath = path.join(home, '.cast', 'cast.db')
  if (!fs.existsSync(dbPath)) return []
  const db = new Database(dbPath, {readonly: true})
  try {
    return db.prepare(
      `SELECT id, agent_name, provider, deployment_url, volume_id, deployed_version, remote_version_state, deleted_at
       FROM deployments ORDER BY rowid`,
    ).all()
  } finally {
    db.close()
  }
}

function writeRemoteState(home, agent, value) {
  const db = new Database(path.join(home, '.cast', 'cast.db'))
  try {
    db.prepare(
      'UPDATE deployments SET remote_version_state = ? WHERE agent_name = ? AND deleted_at IS NULL',
    ).run(value, agent)
  } finally {
    db.close()
  }
}

function agentYaml(name, version) {
  const lines = [
    `name: ${name}`,
    'description: Mocked provider smoke agent',
  ]
  if (version) lines.push(`version: "${version}"`)
  lines.push('brain:', '  model: openrouter/anthropic/claude-3-7-sonnet', '')
  return lines.join('\n')
}

function writeAgent(home, version) {
  return writeAgentYaml(home, agentYaml(AGENT, version))
}

function writeAgentYaml(home, yaml) {
  const dir = path.join(home, '.cast', 'agents', AGENT)
  fs.mkdirSync(dir, {recursive: true})
  const text = yaml.endsWith('\n') ? yaml : `${yaml}\n`
  fs.writeFileSync(path.join(dir, 'agent.yaml'), text)
  return dir
}

function seedRelease(home, version) {
  const releases = path.join(home, '.cast', 'agents', AGENT, '.cast', 'releases')
  fs.mkdirSync(releases, {recursive: true})
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-e2e-rel-'))
  fs.writeFileSync(path.join(stage, 'agent.yaml'), agentYaml(AGENT, version))
  const tarPath = path.join(releases, `${version}.tar.gz`)
  execFileSync('tar', ['-czf', tarPath, '-C', stage, 'agent.yaml'])
  fs.rmSync(stage, {recursive: true, force: true})
  const manifestPath = path.join(releases, 'releases.json')
  const manifest = fs.existsSync(manifestPath)
    ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    : {releases: []}
  manifest.releases = (manifest.releases || []).filter(item => item.version !== version)
  manifest.releases.push({
    version,
    change_number: manifest.releases.length + 1,
    message: version,
    changelog: '',
    created_at: '2026-10-20T00:00:00Z',
    tarball_path: `.cast/releases/${version}.tar.gz`,
  })
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function linkShims(dir, names) {
  fs.mkdirSync(dir, {recursive: true})
  for (const name of names) {
    const dest = path.join(dir, name)
    if (!fs.existsSync(dest)) fs.symlinkSync(shimPath, dest)
  }
  const nodeLink = path.join(dir, 'node')
  if (!fs.existsSync(nodeLink)) fs.symlinkSync(process.execPath, nodeLink)
}

const tuiBundle = path.join(repoRoot, 'typescript/cast-tui/dist/index.js')
const hiddenTuiBundle = `${tuiBundle}.e2e-hidden`

function hideTuiBundle() {
  if (!fs.existsSync(tuiBundle) || fs.existsSync(hiddenTuiBundle)) return false
  fs.renameSync(tuiBundle, hiddenTuiBundle)
  return true
}

function restoreTuiBundle(hidden) {
  if (!hidden) return
  if (fs.existsSync(hiddenTuiBundle) && !fs.existsSync(tuiBundle)) {
    fs.renameSync(hiddenTuiBundle, tuiBundle)
  }
}

export async function withFixture(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-e2e-home-'))
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-e2e-state-'))
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-e2e-bin-'))
  fs.writeFileSync(path.join(stateDir, 'world.json'), '{}\n')
  fs.writeFileSync(path.join(stateDir, 'scenario.json'), '{}\n')
  fs.chmodSync(shimPath, 0o755)
  const {loadProviders, providerHttpHandlers, providerShims, providerTokens} = await import('./discover.mjs')
  const modules = await loadProviders()
  const tokens = providerTokens(modules)
  setActiveTokens(tokens)
  fs.writeFileSync(path.join(stateDir, 'tokens.json'), JSON.stringify(tokens))
  linkShims(shimDir, [...BUILTIN_SHIMS, ...providerShims(modules)])
  const http = await startFakeHttp(stateDir, tokens, providerHttpHandlers(modules))
  const env = allowedEnv({
    HOME: home,
    USERPROFILE: home,
    PATH: [shimDir, python.binDir, '/usr/bin', '/bin'].filter(Boolean).join(':'),
    CAST_PROVIDER_HTTP_BASE: http.base,
    CAST_E2E_STATE: stateDir,
    CAST_E2E_HTTP_BASE: http.base,
    ...tokens,
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    CI: '1',
    OCLIF_COLUMNS: '240',
    TERM: 'dumb',
    PYTHONPATH: python.pythonPath,
  })
  const fx = {
    home,
    stateDir,
    base: http.base,
    env,
    writeAgent: version => writeAgent(home, version),
    writeAgentYaml: yaml => writeAgentYaml(home, yaml),
    seedRelease: version => seedRelease(home, version),
    rows: () => liveRows(home),
    liveRows: () => liveRows(home).filter(row => !row.deleted_at),
    requests: () => readRequests(stateDir),
    world: () => readWorld(stateDir),
    setScenario: scenario => writeScenario(stateDir, scenario),
    resetCounts: () => resetCounts(stateDir),
    setRemoteState: value => writeRemoteState(home, AGENT, value),
    cast: (args, input) => runCast(env, args, input),
  }
  const hiddenTui = hideTuiBundle()
  try {
    await fn(fx)
  } finally {
    restoreTuiBundle(hiddenTui)
    await http.close()
    fs.rmSync(home, {recursive: true, force: true})
    fs.rmSync(stateDir, {recursive: true, force: true})
    fs.rmSync(shimDir, {recursive: true, force: true})
  }
}

function runCast(env, args, input) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [castBin, ...args], {
      cwd: repoRoot,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', chunk => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', chunk => {
      stderr += chunk.toString()
    })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, 90_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({code: code ?? 1, stdout, stderr, timedOut})
    })
    child.on('error', error => {
      clearTimeout(timer)
      resolve({code: 1, stdout, stderr: `${stderr}${error.message}\n`, timedOut})
    })
    if (input) child.stdin.write(input)
    child.stdin.end()
  })
}

export function startProcSampler(tokens = activeTokens) {
  const hits = []
  const values = Object.entries(tokens || {})
  const timer = setInterval(() => {
    let entries = []
    try {
      entries = fs.readdirSync('/proc')
    } catch {
      return
    }
    for (const pid of entries) {
      if (!/^\d+$/.test(pid)) continue
      let cmd
      try {
        cmd = fs.readFileSync(`/proc/${pid}/cmdline`)
      } catch {
        continue
      }
      const text = cmd.toString('utf8')
      for (const [name, value] of values) {
        if (value && text.includes(value)) hits.push({source: 'proc', name, pid})
      }
    }
  }, 30)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    stop() {
      clearInterval(timer)
      return hits
    },
  }
}

export function tokenHits(requests, procHits) {
  const hits = []
  for (const req of requests) {
    for (const name of req.tokenInArgv || []) hits.push({source: 'shim', name, bin: req.bin})
  }
  return hits.concat(procHits)
}

export function assertNoToken(requests, procHits) {
  const hits = tokenHits(requests, procHits)
  if (hits.length > 0) {
    throw new Error(`provider token appeared in argv: ${JSON.stringify(hits)}`)
  }
}

export function countCreatesSince(before, requests) {
  const prior = before.filter(req => req.bin === 'sprite' && req.argv[0] === 'create').length
  const after = requests.filter(req => req.bin === 'sprite' && req.argv[0] === 'create').length
  return after - prior
}

export function commandBlob(requests) {
  return requests.map(req => [req.bin, req.method, req.path, ...(req.argv || [])].filter(Boolean).join(' ')).join('\n')
}
