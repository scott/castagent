#!/usr/bin/env node
// Compare failing tests on this checkout with the base branch.
//
//   node scripts/compare-failures.mjs --run
//   node scripts/compare-failures.mjs --head <results-dir> --skip-base
//   node scripts/compare-failures.mjs --head <results-dir> --rerun-base
//   node scripts/compare-failures.mjs --base <results-dir> --head <results-dir>
//
// --run executes the head suites, then reruns only the failing ids on the
// base branch. A head with no failures does not check out the base.
// --skip-base classifies an existing head results dir and skips the base
// when that dir has no failures. --rerun-base reruns only those ids.
// Exit 1 only when the head has a failure the base does not.
import {execFileSync, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const repoRoot = process.cwd()
const REQUIRED_HEAD = ['mocha.json', 'pytest.xml', 'pytest-session.xml', 'smoke-summary.json', 'snapshot-summary.json']
const SUBPROCESS_TIMEOUT_MS = 12 * 60 * 1000

function argValue(flag) {
  const index = process.argv.indexOf(flag)
  if (index === -1) return ''
  return process.argv[index + 1] || ''
}

function hasFlag(flag) {
  return process.argv.includes(flag)
}

function stableTestPath(file) {
  if (!file) return ''
  const norm = String(file).replaceAll('\\', '/')
  const at = norm.lastIndexOf('/tests/')
  if (at !== -1) return norm.slice(at + 1)
  return norm
}

function decodeXml(value) {
  return String(value)
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
}

export function xmlAttributes(tag) {
  const attrs = {}
  const re = /\s([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let match
  while ((match = re.exec(` ${tag}`))) {
    attrs[match[1]] = decodeXml(match[2] ?? match[3] ?? '')
  }
  return attrs
}

function mochaFailures(file) {
  return mochaRecords(file).map(record => record.id)
}

function mochaRecords(file) {
  if (!fs.existsSync(file)) return []
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return (data.failures || []).map(test => {
    const title = test.fullTitle || test.title || 'untitled'
    const rel = stableTestPath(test.file)
    return {id: `mocha:${rel}::${title}`, file: rel, title}
  })
}

function mochaStats(file) {
  if (!fs.existsSync(file)) return {passes: 0, failures: 0, pending: 0}
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return {
    passes: data.stats?.passes || 0,
    failures: data.stats?.failures || 0,
    pending: data.stats?.pending || 0,
  }
}

export function pytestNodeId(file, classname, name) {
  const moduleFile = file || fileFromClassname(classname)
  if (!moduleFile) return ''
  const module = path.basename(moduleFile, '.py')
  const parts = String(classname || '').split('.').filter(Boolean)
  const at = parts.lastIndexOf(module)
  const tail = at === -1 ? [] : parts.slice(at + 1)
  return [moduleFile, ...tail, name].filter(Boolean).join('::')
}

function fileFromClassname(classname) {
  const parts = String(classname || '').split('.').filter(Boolean)
  while (parts.length > 0 && /^[A-Z]/.test(parts[parts.length - 1])) parts.pop()
  if (parts.length === 0) return ''
  return `${parts.join('/')}.py`
}

export function pytestRecordsFromXml(xml) {
  const records = []
  for (const chunk of String(xml).split(/<testcase\b/).slice(1)) {
    const tagEnd = chunk.indexOf('>')
    const tag = tagEnd === -1 ? chunk : chunk.slice(0, tagEnd)
    const attrs = xmlAttributes(tag)
    const name = attrs.name || ''
    const classname = attrs.classname || ''
    const bodyEnd = chunk.indexOf('</testcase>')
    const body = bodyEnd === -1 ? chunk : chunk.slice(0, bodyEnd)
    if (!body.includes('<failure') && !body.includes('<error')) continue
    records.push({
      id: `pytest:${classname}::${name}`,
      classname,
      name,
      file: attrs.file || fileFromClassname(classname),
      nodeId: pytestNodeId(attrs.file || '', classname, name),
    })
  }
  return records
}

export function pytestFailures(file) {
  if (!fs.existsSync(file)) return []
  return pytestRecordsFromXml(fs.readFileSync(file, 'utf8')).map(record => record.id)
}

function pytestRecords(file) {
  if (!fs.existsSync(file)) return []
  return pytestRecordsFromXml(fs.readFileSync(file, 'utf8'))
}

function smokeFailures(file) {
  return smokeRecords(file).map(record => record.id)
}

function smokeRecords(file) {
  if (!fs.existsSync(file)) return []
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return (data.cases || []).filter(item => item.status === 'fail').map(item => ({id: `smoke:${item.id}`, caseId: item.id}))
}

function smokeStats(file) {
  if (!fs.existsSync(file)) return {passes: 0, failures: 0, skipped: 0}
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const cases = data.cases || []
  return {
    passes: cases.filter(item => item.status === 'pass').length,
    failures: cases.filter(item => item.status === 'fail').length,
    skipped: cases.filter(item => item.status === 'skip').length,
  }
}

function snapshotFailures(file) {
  return snapshotRecords(file).map(record => record.id)
}

function snapshotRecords(file) {
  if (!fs.existsSync(file)) return []
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return (data.cases || []).filter(item => item.status === 'fail').map(item => ({id: `snapshot:${item.id}`, caseId: item.id}))
}

export function compareSets(baseIds, headIds) {
  const base = new Set(baseIds)
  const head = new Set(headIds)
  const newFailures = [...head].filter(id => !base.has(id)).sort()
  const alreadyFailing = [...head].filter(id => base.has(id)).sort()
  const fixed = [...base].filter(id => !head.has(id)).sort()
  return {newFailures, alreadyFailing, fixed}
}

function summaryAbsent(file) {
  if (!fs.existsSync(file)) return true
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Boolean(data && data.absent === true)
  } catch {
    return false
  }
}

function suiteEntry(file, absent, readIds) {
  if (absent) return {absent: true, ids: []}
  return {absent: false, ids: readIds(file)}
}

function collect(dir) {
  const mochaFile = path.join(dir, 'mocha.json')
  const pytestFile = path.join(dir, 'pytest.xml')
  const sessionFile = path.join(dir, 'pytest-session.xml')
  const smokeFile = path.join(dir, 'smoke-summary.json')
  const snapshotFile = path.join(dir, 'snapshot-summary.json')
  const suites = {
    mocha: suiteEntry(mochaFile, summaryAbsent(mochaFile), mochaFailures),
    pytest: suiteEntry(pytestFile, !fs.existsSync(pytestFile), pytestFailures),
    session: suiteEntry(sessionFile, !fs.existsSync(sessionFile), pytestFailures),
    smoke: suiteEntry(smokeFile, summaryAbsent(smokeFile), smokeFailures),
    snapshots: suiteEntry(snapshotFile, summaryAbsent(snapshotFile), snapshotFailures),
  }
  return {
    ids: Object.values(suites).flatMap(suite => suite.ids),
    suites,
    mocha: mochaStats(mochaFile),
    smoke: smokeStats(smokeFile),
  }
}

function emptyCollection() {
  const empty = {absent: true, ids: []}
  return {
    ids: [],
    suites: {mocha: empty, pytest: empty, session: empty, smoke: empty, snapshots: empty},
    mocha: {passes: 0, failures: 0, pending: 0},
    smoke: {passes: 0, failures: 0, skipped: 0},
  }
}

function compareCollected(base, head) {
  const newFailures = []
  const alreadyFailing = []
  const fixed = []
  for (const key of Object.keys(head.suites)) {
    const compared = compareSets(base.suites[key].ids, head.suites[key].ids)
    newFailures.push(...compared.newFailures)
    alreadyFailing.push(...compared.alreadyFailing)
    if (!head.suites[key].absent) fixed.push(...compared.fixed)
  }
  return {
    newFailures: newFailures.sort(),
    alreadyFailing: alreadyFailing.sort(),
    fixed: fixed.sort(),
  }
}

function headRecords(dir) {
  return {
    mocha: mochaRecords(path.join(dir, 'mocha.json')),
    pytest: pytestRecords(path.join(dir, 'pytest.xml')),
    session: pytestRecords(path.join(dir, 'pytest-session.xml')),
    smoke: smokeRecords(path.join(dir, 'smoke-summary.json')),
    snapshots: snapshotRecords(path.join(dir, 'snapshot-summary.json')),
  }
}

function sameFile(left, right) {
  const leftExists = fs.existsSync(left)
  const rightExists = fs.existsSync(right)
  if (!leftExists && !rightExists) return true
  if (!leftExists || !rightExists) return false
  return fs.readFileSync(left).equals(fs.readFileSync(right))
}

function linkNodeModules(fromRoot, toRoot) {
  const relatives = [
    'node_modules',
    'typescript/node_modules',
    'typescript/cast-cli/node_modules',
    'typescript/cast-tui/node_modules',
    'docs-site/node_modules',
  ]
  for (const rel of relatives) {
    const src = path.join(fromRoot, rel)
    const dest = path.join(toRoot, rel)
    if (!fs.existsSync(src) || fs.existsSync(dest)) continue
    fs.mkdirSync(path.dirname(dest), {recursive: true})
    fs.symlinkSync(src, dest)
  }
}

function timedOut(result) {
  return Boolean(result && result.error && result.error.code === 'ETIMEDOUT')
}

function timeoutError(cmd, args) {
  return new Error(`timed out after ${SUBPROCESS_TIMEOUT_MS}ms: ${cmd} ${args.join(' ')}`)
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, {stdio: 'inherit', ...options, timeout: SUBPROCESS_TIMEOUT_MS})
  if (timedOut(result)) throw timeoutError(cmd, args)
  return result.status ?? 1
}

function capture(cmd, args, options, outFile) {
  const result = spawnSync(cmd, args, {...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: SUBPROCESS_TIMEOUT_MS})
  if (timedOut(result)) throw timeoutError(cmd, args)
  fs.mkdirSync(path.dirname(outFile), {recursive: true})
  fs.writeFileSync(outFile, result.stdout || '')
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) process.stderr.write(`${result.error.message}\n`)
  return result.status ?? 1
}

function gitExec(args, options = {}) {
  try {
    return execFileSync('git', args, {cwd: repoRoot, ...options, timeout: SUBPROCESS_TIMEOUT_MS})
  } catch (error) {
    if (error && error.code === 'ETIMEDOUT') throw timeoutError('git', args)
    throw error
  }
}

function suitesToRun() {
  const only = argValue('--only')
  if (!only) return new Set(['mocha', 'pytest', 'smoke', 'snapshots'])
  return new Set(only.split(',').map(item => item.trim()).filter(Boolean))
}

function mochaArgs() {
  const files = argValue('--mocha-files')
  if (files) return files.split(',').map(item => item.trim()).filter(Boolean)
  return ['tests/**/*.test.ts']
}

function prepareTree(root) {
  const status = run('node', ['scripts/ensure-providers-json.js'], {cwd: root})
  if (status !== 0) throw new Error(`providers.json failed in ${root}`)
}

function installTree(root) {
  if (run('npm', ['install'], {cwd: root}) !== 0) throw new Error('npm install failed')
  if (run('npm', ['install'], {cwd: path.join(root, 'typescript')}) !== 0) {
    throw new Error('typescript npm install failed')
  }
  if (fs.existsSync(path.join(root, 'docs-site', 'package-lock.json'))) {
    if (run('npm', ['ci', '--prefix', 'docs-site'], {cwd: root}) !== 0) {
      throw new Error('docs-site npm ci failed')
    }
  }
}

function buildCli(root) {
  if (run('npm', ['run', 'build:cli'], {cwd: root}) !== 0) throw new Error(`build:cli failed in ${root}`)
}

function buildTui(root) {
  if (run('npm', ['run', 'build:tui'], {cwd: root}) !== 0) throw new Error(`build:tui failed in ${root}`)
}

function recordAbsentSuite(root, entry, summary, label) {
  if (fs.existsSync(path.join(root, entry))) return false
  process.stdout.write(`${label} is not in this tree; recording no failures\n`)
  fs.writeFileSync(summary, `${JSON.stringify({ok: true, cases: [], absent: true}, null, 2)}\n`)
  return true
}

function runMocha(root, outFile, extraArgs) {
  const mochaBin = path.join(root, 'node_modules', 'mocha', 'bin', 'mocha.js')
  const bin = fs.existsSync(mochaBin) ? process.execPath : 'npx'
  const report = ['--reporter', 'json', '--reporter-option', `output=${outFile}`, '--forbid-only', '--exit']
  const args = fs.existsSync(mochaBin)
    ? [mochaBin, ...report, ...extraArgs]
    : ['mocha', ...report, ...extraArgs]
  capture(bin, args, {cwd: root}, `${outFile}.stdout`)
  if (!fs.existsSync(outFile) || fs.statSync(outFile).size === 0) {
    throw new Error(`mocha produced no JSON in ${root}`)
  }
  JSON.parse(fs.readFileSync(outFile, 'utf8'))
}

function runSuites(root, outDir) {
  fs.mkdirSync(outDir, {recursive: true})
  const wanted = suitesToRun()
  prepareTree(root)
  if (wanted.has('mocha')) buildTui(root)
  if (wanted.has('smoke')) {
    const summary = path.join(outDir, 'smoke-summary.json')
    if (!recordAbsentSuite(root, 'tests/e2e/run.mjs', summary, 'provider smoke')) {
      const status = run('node', ['tests/e2e/run.mjs'], {cwd: root, env: {...process.env, SMOKE_SUMMARY: summary}})
      if (!fs.existsSync(summary)) throw new Error(`smoke summary missing (exit ${status})`)
    }
  }
  if (wanted.has('snapshots')) {
    const summary = path.join(outDir, 'snapshot-summary.json')
    if (!recordAbsentSuite(root, 'tests/cli-snapshots/run.mjs', summary, 'CLI snapshots')) {
      const status = run('node', ['tests/cli-snapshots/run.mjs'], {cwd: root, env: {...process.env, SNAPSHOT_SUMMARY: summary}})
      if (!fs.existsSync(summary)) throw new Error(`snapshot summary missing (exit ${status})`)
    }
  }
  if (wanted.has('pytest')) {
    const pytestXml = path.join(outDir, 'pytest.xml')
    const sessionXml = path.join(outDir, 'pytest-session.xml')
    capture('python3', ['-m', 'pytest', 'tests/python', 'tests', '--junitxml', pytestXml, '-q'], {
      cwd: path.join(root, 'python'),
    }, path.join(outDir, 'pytest.stdout'))
    capture('python3', ['-m', 'pytest', 'tests/python/unit/test_sessions.py', 'tests/python/unit/test_session_topic.py', '--junitxml', sessionXml, '-q'], {
      cwd: root,
      env: {...process.env, PYTHONPATH: path.join(root, 'python')},
    }, path.join(outDir, 'pytest-session.stdout'))
    if (!fs.existsSync(pytestXml) || !fs.existsSync(sessionXml)) {
      throw new Error(`pytest did not write junit XML in ${root}`)
    }
  }
  if (wanted.has('mocha')) {
    runMocha(root, path.join(outDir, 'mocha.json'), mochaArgs())
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function emptyJson(file, body) {
  fs.mkdirSync(path.dirname(file), {recursive: true})
  fs.writeFileSync(file, `${JSON.stringify(body)}\n`)
}

function listedIds(root, script) {
  if (!fs.existsSync(path.join(root, script))) return null
  const result = spawnSync(process.execPath, [script, '--list'], {
    cwd: root,
    encoding: 'utf8',
    timeout: SUBPROCESS_TIMEOUT_MS,
  })
  if (timedOut(result)) throw timeoutError(script, ['--list'])
  if ((result.status ?? 1) !== 0) return new Set()
  return new Set(result.stdout.split('\n').map(line => line.trim()).filter(Boolean))
}

function rerunMocha(root, outDir, records) {
  const present = records.filter(record => record.file && fs.existsSync(path.join(root, record.file)))
  const outFile = path.join(outDir, 'mocha.json')
  if (present.length === 0) {
    emptyJson(outFile, {stats: {passes: 0, failures: 0, pending: 0}, failures: []})
    return
  }
  prepareTree(root)
  buildTui(root)
  const files = [...new Set(present.map(record => record.file))]
  const pattern = `^(?:${present.map(record => escapeRegExp(record.title)).join('|')})$`
  runMocha(root, outFile, [...files, '--grep', pattern])
}

function resolvePytest(root, record) {
  if (!record.file || !record.nodeId) return null
  if (fs.existsSync(path.join(root, record.file))) return {cwd: root, nodeId: record.nodeId}
  if (fs.existsSync(path.join(root, 'python', record.file))) {
    return {cwd: path.join(root, 'python'), nodeId: record.nodeId}
  }
  return null
}

function rerunPytest(root, outDir, records, xmlName) {
  const xml = path.join(outDir, xmlName)
  const groups = new Map()
  for (const record of records) {
    const resolved = resolvePytest(root, record)
    if (!resolved) continue
    if (!groups.has(resolved.cwd)) groups.set(resolved.cwd, [])
    groups.get(resolved.cwd).push(resolved.nodeId)
  }
  if (groups.size === 0) {
    fs.writeFileSync(xml, '<testsuite></testsuite>\n')
    return
  }
  const venv = path.join(outDir, 'py-venv')
  const pythonBin = path.join(venv, 'bin', 'python')
  const env = {
    ...process.env,
    VIRTUAL_ENV: venv,
    PYTHONNOUSERSITE: '1',
    PATH: `${path.join(venv, 'bin')}${path.delimiter}${process.env.PATH || ''}`,
  }
  delete env.PYTHONPATH
  if (!fs.existsSync(pythonBin)) {
    if (run('python3', ['-m', 'venv', venv], {cwd: root}) !== 0) {
      throw new Error(`python venv failed in ${root}`)
    }
    if (run(pythonBin, ['-m', 'pip', 'install', '-e', `${path.join(root, 'python')}[test]`, 'langchain-openai', 'langchain-core', 'pyyaml'], {cwd: root, env}) !== 0) {
      throw new Error(`python install failed in ${root}`)
    }
  }
  const parts = ['<testsuites>']
  let index = 0
  for (const [cwd, nodeIds] of groups) {
    const piece = path.join(outDir, `${xmlName}.${index}.xml`)
    index += 1
    run(pythonBin, ['-m', 'pytest', ...nodeIds, '--junitxml', piece, '-q'], {cwd, env})
    if (!fs.existsSync(piece)) throw new Error(`pytest did not write ${piece}`)
    parts.push(fs.readFileSync(piece, 'utf8'))
  }
  parts.push('</testsuites>')
  fs.writeFileSync(xml, parts.join('\n'))
}

function rerunSmoke(root, outDir, records) {
  const summary = path.join(outDir, 'smoke-summary.json')
  const known = listedIds(root, 'tests/e2e/run.mjs')
  if (known === null) {
    recordAbsentSuite(root, 'tests/e2e/run.mjs', summary, 'provider smoke')
    return
  }
  const ids = records.map(record => record.caseId).filter(id => known.has(id))
  if (ids.length === 0) {
    emptyJson(summary, {ok: true, cases: []})
    return
  }
  buildCli(root)
  const status = run('node', ['tests/e2e/run.mjs', '--case', ids.join(',')], {
    cwd: root,
    env: {...process.env, SMOKE_SUMMARY: summary},
  })
  if (!fs.existsSync(summary)) throw new Error(`smoke summary missing (exit ${status})`)
}

function rerunSnapshots(root, outDir, records) {
  const summary = path.join(outDir, 'snapshot-summary.json')
  const known = listedIds(root, 'tests/cli-snapshots/run.mjs')
  if (known === null) {
    recordAbsentSuite(root, 'tests/cli-snapshots/run.mjs', summary, 'CLI snapshots')
    return
  }
  const ids = records.map(record => record.caseId).filter(id => known.has(id))
  if (ids.length === 0) {
    emptyJson(summary, {ok: true, cases: []})
    return
  }
  buildCli(root)
  const status = run('node', ['tests/cli-snapshots/run.mjs', '--case', ids.join(',')], {
    cwd: root,
    env: {...process.env, SNAPSHOT_SUMMARY: summary},
  })
  if (!fs.existsSync(summary)) throw new Error(`snapshot summary missing (exit ${status})`)
}

function rerunFailures(root, outDir, records) {
  fs.mkdirSync(outDir, {recursive: true})
  const needsCli = records.smoke.length > 0 || records.snapshots.length > 0
  if (needsCli) buildCli(root)
  if (records.mocha.length > 0) {
    buildCli(root)
    rerunMocha(root, outDir, records.mocha)
  } else {
    emptyJson(path.join(outDir, 'mocha.json'), {stats: {passes: 0, failures: 0, pending: 0}, failures: []})
  }
  rerunPytest(root, outDir, records.pytest, 'pytest.xml')
  rerunPytest(root, outDir, records.session, 'pytest-session.xml')
  if (records.smoke.length > 0) rerunSmoke(root, outDir, records.smoke)
  else emptyJson(path.join(outDir, 'smoke-summary.json'), {ok: true, cases: []})
  if (records.snapshots.length > 0) rerunSnapshots(root, outDir, records.snapshots)
  else emptyJson(path.join(outDir, 'snapshot-summary.json'), {ok: true, cases: []})
}

function fetchBaseSha() {
  const explicit = argValue('--base-ref') || process.env.COMPARE_BASE_REF || ''
  if (explicit && /^[0-9a-f]{7,40}$/i.test(explicit)) return explicit
  const ref = (explicit || process.env.GITHUB_BASE_REF || 'main').replace(/^origin\//, '')
  gitExec(['fetch', '--no-tags', '--depth=1', 'origin', ref], {stdio: 'inherit'})
  return String(gitExec(['rev-parse', '--verify', 'FETCH_HEAD'], {encoding: 'utf8'})).trim()
}

function prepareBase(baseRoot) {
  const locks = ['package-lock.json', 'typescript/package-lock.json', 'docs-site/package-lock.json']
  const reusable = locks.every(rel => sameFile(path.join(repoRoot, rel), path.join(baseRoot, rel)))
  if (reusable) {
    process.stdout.write('lockfiles match; reusing node_modules\n')
    linkNodeModules(repoRoot, baseRoot)
    return
  }
  process.stdout.write('lockfiles differ; installing dependencies on the base\n')
  installTree(baseRoot)
}

function withBase(fn) {
  const sha = fetchBaseSha()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-compare-'))
  const baseRoot = path.join(work, 'base')
  let added = false
  let cleanupError
  try {
    process.stdout.write(`base ${sha} (shallow fetch)\n`)
    gitExec(['worktree', 'add', '--detach', baseRoot, sha], {stdio: 'inherit'})
    added = true
    prepareBase(baseRoot)
    return fn(baseRoot, sha)
  } finally {
    if (added) {
      try {
        gitExec(['worktree', 'remove', '--force', baseRoot], {stdio: 'ignore'})
      } catch (error) {
        fs.rmSync(baseRoot, {recursive: true, force: true})
        if (error && error.message && error.message.startsWith('timed out after')) cleanupError = error
      }
    }
    fs.rmSync(work, {recursive: true, force: true})
    if (cleanupError) throw cleanupError
  }
}

function junitProblem(file) {
  if (!fs.existsSync(file)) return 'missing'
  const text = fs.readFileSync(file, 'utf8')
  if (text.length === 0) return 'empty'
  if (!/<testsuites?\b/.test(text)) return 'not junit XML'
  return ''
}

function requireHead(dir) {
  if (process.env.COMPARE_REQUIRE_ARTIFACTS !== '1') return
  const missing = REQUIRED_HEAD.filter(name => !fs.existsSync(path.join(dir, name)))
  if (missing.length > 0) throw new Error(`head results missing ${missing.join(', ')}`)
  for (const name of ['pytest.xml', 'pytest-session.xml']) {
    const problem = junitProblem(path.join(dir, name))
    if (problem && problem !== 'missing') throw new Error(`head results unusable ${name} (${problem})`)
  }
}

function markOutput(needed) {
  if (!process.env.GITHUB_OUTPUT) return
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `need_base=${needed ? 'true' : 'false'}\n`)
}

function writeSummary(baseDir, headDir, baseSha, timings) {
  const base = baseDir ? collect(baseDir) : emptyCollection()
  const head = collect(headDir)
  const compared = compareCollected(base, head)
  const summary = {
    ok: compared.newFailures.length === 0,
    baseSha: baseSha || null,
    baseSkipped: Boolean(timings.baseSkipped),
    newFailures: compared.newFailures,
    alreadyFailing: compared.alreadyFailing,
    fixed: compared.fixed,
    head: {mocha: head.mocha, smoke: head.smoke, failures: head.ids.length},
    base: {mocha: base.mocha, smoke: base.smoke, failures: base.ids.length},
    timings,
  }
  const dest = process.env.COMPARE_SUMMARY
    ? path.resolve(process.env.COMPARE_SUMMARY)
    : path.join(repoRoot, 'compare-summary.json')
  fs.writeFileSync(dest, `${JSON.stringify(summary, null, 2)}\n`)
  const line = summary.ok
    ? `PR vs main: no new failures (${summary.alreadyFailing.length} already failing on main)`
    : `PR vs main: fail (${summary.newFailures.length} new, ${summary.alreadyFailing.length} already failing on main)`
  process.stdout.write(`${line}\n`)
  if (summary.newFailures.length > 0) {
    process.stdout.write('new failures:\n')
    for (const id of summary.newFailures) process.stdout.write(`  ${id}\n`)
  }
  if (summary.alreadyFailing.length > 0) {
    process.stdout.write('already failing on main:\n')
    for (const id of summary.alreadyFailing) process.stdout.write(`  ${id}\n`)
  }
  if (summary.fixed.length > 0) {
    process.stdout.write('fixed since main:\n')
    for (const id of summary.fixed) process.stdout.write(`  ${id}\n`)
  }
  process.stdout.write(`compare timing: head ${timings.headMs}ms, base ${timings.baseMs}ms, total ${timings.totalMs}ms, baseSkipped ${timings.baseSkipped}\n`)
  process.stdout.write(`summary ${dest}\n`)
  return summary
}

function classify(headDir, started, skipBase) {
  requireHead(headDir)
  const head = collect(headDir)
  if (head.ids.length === 0) {
    markOutput(false)
    const totalMs = Date.now() - started
    return writeSummary(null, headDir, null, {
      headReused: !hasFlag('--run'),
      baseSkipped: true,
      headMs: totalMs,
      baseMs: 0,
      totalMs,
    })
  }
  if (skipBase) {
    markOutput(true)
    process.stdout.write(`head has ${head.ids.length} failure(s); base rerun still required\n`)
    for (const id of head.ids) process.stdout.write(`  ${id}\n`)
    return {ok: false, pendingBase: true}
  }
  const records = headRecords(headDir)
  const baseStarted = Date.now()
  let summary
  withBase((baseRoot, baseSha) => {
    const baseOut = path.join(path.dirname(baseRoot), 'base-out')
    rerunFailures(baseRoot, baseOut, records)
    const totalMs = Date.now() - started
    summary = writeSummary(baseOut, headDir, baseSha, {
      headReused: !hasFlag('--run'),
      baseSkipped: false,
      headMs: baseStarted - started,
      baseMs: Date.now() - baseStarted,
      totalMs,
    })
  })
  return summary
}

function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    process.stdout.write(`Usage:
  node scripts/compare-failures.mjs --run [--only mocha,pytest,smoke,snapshots] [--mocha-files a.test.ts]
  node scripts/compare-failures.mjs --head <results-dir> --skip-base
  node scripts/compare-failures.mjs --head <results-dir> --rerun-base
  node scripts/compare-failures.mjs --base <results-dir> --head <results-dir>

--skip-base writes the summary when the head has no failures and sets
need_base in GITHUB_OUTPUT otherwise. --rerun-base checks out the base
branch tip with a depth-1 fetch and reruns only the head's failing ids.
Exit 1 when the head has a failure the base does not.
`)
    return {ok: true}
  }
  const started = Date.now()
  if (hasFlag('--run')) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-compare-'))
    try {
      const headOut = path.join(work, 'head')
      buildCli(repoRoot)
      process.stdout.write('running suites on head\n')
      runSuites(repoRoot, headOut)
      const summary = classify(headOut, started, false)
      return summary.pendingBase ? {ok: false} : summary
    } finally {
      fs.rmSync(work, {recursive: true, force: true})
    }
  }
  const headDir = argValue('--head')
  if (headDir && hasFlag('--skip-base')) {
    const summary = classify(path.resolve(headDir), started, true)
    return summary.pendingBase ? {ok: true, pendingBase: true} : summary
  }
  if (headDir && hasFlag('--rerun-base')) {
    return classify(path.resolve(headDir), started, false)
  }
  if (argValue('--base') && headDir) {
    const totalMs = Date.now() - started
    return writeSummary(path.resolve(argValue('--base')), path.resolve(headDir), argValue('--base-ref'), {
      headReused: true,
      baseSkipped: false,
      headMs: 0,
      baseMs: 0,
      totalMs,
    })
  }
  process.stderr.write('pass --run, --head with --skip-base or --rerun-base, or --base and --head\n')
  return {ok: false, usage: true}
}

const isDirect = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isDirect) {
  try {
    const summary = main()
    if (summary.usage) process.exit(2)
    if (summary.pendingBase) process.exit(0)
    process.exit(summary.ok ? 0 : 1)
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
    process.exit(1)
  }
}
