#!/usr/bin/env node
// Compare failing tests on this checkout with the merge base.
//
//   node scripts/compare-failures.mjs --run
//   node scripts/compare-failures.mjs --base <dir> --head <dir>
//
// --run builds cast-cli in each tree and runs mocha (no coverage), pytest,
// the provider smoke suite, and CLI snapshots. node_modules is reused when
// the lockfiles match. A suite that does not exist in a tree records no
// failures. A failure that also fails on the base is "already failing". A
// failure that passes on the base is a new failure. The process exits 1
// only when there is a new failure.
import {execFileSync, spawnSync} from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const repoRoot = process.cwd()

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

function mochaFailures(file) {
  if (!fs.existsSync(file)) return []
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return (data.failures || []).map(test => {
    const title = test.fullTitle || test.title || 'untitled'
    return `mocha:${stableTestPath(test.file)}::${title}`
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

function pytestFailures(file) {
  if (!fs.existsSync(file)) return []
  const xml = fs.readFileSync(file, 'utf8')
  const failures = []
  for (const chunk of xml.split(/<testcase\b/).slice(1)) {
    const tagEnd = chunk.indexOf('>')
    const tag = tagEnd === -1 ? chunk : chunk.slice(0, tagEnd)
    const name = /name="([^"]*)"/.exec(tag)?.[1] || ''
    const classname = /classname="([^"]*)"/.exec(tag)?.[1] || ''
    const bodyEnd = chunk.indexOf('</testcase>')
    const body = bodyEnd === -1 ? chunk : chunk.slice(0, bodyEnd)
    if (body.includes('<failure') || body.includes('<error')) {
      failures.push(`pytest:${classname}::${name}`)
    }
  }
  return failures
}

function smokeFailures(file) {
  if (!fs.existsSync(file)) return []
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return (data.cases || []).filter(item => item.status === 'fail').map(item => `smoke:${item.id}`)
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
  if (!fs.existsSync(file)) return []
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  return (data.cases || []).filter(item => item.status === 'fail').map(item => `snapshot:${item.id}`)
}

export function compareSets(baseIds, headIds) {
  const base = new Set(baseIds)
  const head = new Set(headIds)
  const newFailures = [...head].filter(id => !base.has(id)).sort()
  const alreadyFailing = [...head].filter(id => base.has(id)).sort()
  const fixed = [...base].filter(id => !head.has(id)).sort()
  return {newFailures, alreadyFailing, fixed}
}

function collect(dir) {
  const ids = [
    ...mochaFailures(path.join(dir, 'mocha.json')),
    ...pytestFailures(path.join(dir, 'pytest.xml')),
    ...pytestFailures(path.join(dir, 'pytest-session.xml')),
    ...smokeFailures(path.join(dir, 'smoke-summary.json')),
    ...snapshotFailures(path.join(dir, 'snapshot-summary.json')),
  ]
  return {
    ids,
    mocha: mochaStats(path.join(dir, 'mocha.json')),
    smoke: smokeStats(path.join(dir, 'smoke-summary.json')),
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

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, {stdio: 'inherit', ...options})
  return result.status ?? 1
}

function capture(cmd, args, options, outFile) {
  const result = spawnSync(cmd, args, {...options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024})
  fs.mkdirSync(path.dirname(outFile), {recursive: true})
  fs.writeFileSync(outFile, result.stdout || '')
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) process.stderr.write(`${result.error.message}\n`)
  return result.status ?? 1
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

function installHead(root) {
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

function runSuites(root, outDir) {
  fs.mkdirSync(outDir, {recursive: true})
  const wanted = suitesToRun()
  prepareTree(root)
  if (wanted.has('mocha')) {
    const mochaJson = path.join(outDir, 'mocha.json')
    const mochaBin = path.join(root, 'node_modules', 'mocha', 'bin', 'mocha.js')
    const bin = fs.existsSync(mochaBin) ? process.execPath : 'npx'
    const report = ['--reporter', 'json', '--reporter-option', `output=${mochaJson}`, '--forbid-only', '--exit']
    const args = fs.existsSync(mochaBin)
      ? [mochaBin, ...report, ...mochaArgs()]
      : ['mocha', ...report, ...mochaArgs()]
    // The JSON reporter writes mocha.json itself. Stdout also contains prompts
    // from commands under test, so it is not the report.
    capture(bin, args, {cwd: root}, path.join(outDir, 'mocha.stdout'))
    if (!fs.existsSync(mochaJson) || fs.statSync(mochaJson).size === 0) {
      throw new Error(`mocha produced no JSON in ${root}`)
    }
    JSON.parse(fs.readFileSync(mochaJson, 'utf8'))
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
}

function mergeBase() {
  const explicit = argValue('--base-ref') || process.env.COMPARE_BASE_REF || ''
  if (explicit && /^[0-9a-f]{7,40}$/i.test(explicit)) return explicit
  const ref = explicit || process.env.GITHUB_BASE_REF || 'main'
  const remote = ref.startsWith('origin/') ? ref : `origin/${ref}`
  try {
    execFileSync('git', ['rev-parse', '--verify', remote], {cwd: repoRoot, stdio: 'ignore'})
  } catch {
    execFileSync('git', ['fetch', 'origin', ref.replace(/^origin\//, '')], {cwd: repoRoot, stdio: 'inherit'})
  }
  return execFileSync('git', ['merge-base', 'HEAD', remote], {cwd: repoRoot, encoding: 'utf8'}).trim()
}

function runBoth() {
  const baseSha = mergeBase()
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-compare-'))
  const baseRoot = path.join(work, 'base')
  const headOut = path.join(work, 'head')
  const baseOut = path.join(work, 'base-out')
  process.stdout.write(`merge base ${baseSha}\n`)
  execFileSync('git', ['worktree', 'add', '--detach', baseRoot, baseSha], {cwd: repoRoot, stdio: 'inherit'})
  try {
    const locks = ['package-lock.json', 'typescript/package-lock.json', 'docs-site/package-lock.json']
    const reusable = locks.every(rel => sameFile(path.join(repoRoot, rel), path.join(baseRoot, rel)))
    if (reusable) {
      process.stdout.write('lockfiles match; reusing node_modules\n')
      linkNodeModules(repoRoot, baseRoot)
    } else {
      process.stdout.write('lockfiles differ; installing dependencies on the base\n')
      installHead(baseRoot)
    }
    buildCli(repoRoot)
    buildCli(baseRoot)
    buildTui(repoRoot)
    buildTui(baseRoot)
    process.stdout.write('running suites on head\n')
    runSuites(repoRoot, headOut)
    process.stdout.write('running suites on merge base\n')
    runSuites(baseRoot, baseOut)
    return {headOut, baseOut, baseSha, work}
  } catch (error) {
    execFileSync('git', ['worktree', 'remove', '--force', baseRoot], {cwd: repoRoot, stdio: 'ignore'})
    throw error
  }
}

function writeSummary(baseDir, headDir, baseSha) {
  const base = collect(baseDir)
  const head = collect(headDir)
  const compared = compareSets(base.ids, head.ids)
  const summary = {
    ok: compared.newFailures.length === 0,
    baseSha: baseSha || null,
    newFailures: compared.newFailures,
    alreadyFailing: compared.alreadyFailing,
    fixed: compared.fixed,
    head: {mocha: head.mocha, smoke: head.smoke, failures: head.ids.length},
    base: {mocha: base.mocha, smoke: base.smoke, failures: base.ids.length},
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
  process.stdout.write(`summary ${dest}\n`)
  return summary
}

function cleanupWorktree(baseRoot) {
  if (!baseRoot) return
  try {
    execFileSync('git', ['worktree', 'remove', '--force', baseRoot], {cwd: repoRoot, stdio: 'ignore'})
  } catch {
    fs.rmSync(baseRoot, {recursive: true, force: true})
  }
}

if (hasFlag('--help') || hasFlag('-h')) {
  process.stdout.write(`Usage:
  node scripts/compare-failures.mjs --run [--only mocha,pytest,smoke,snapshots] [--mocha-files a.test.ts]
  node scripts/compare-failures.mjs --base <results-dir> --head <results-dir>

Results dirs contain mocha.json, pytest.xml, pytest-session.xml, smoke-summary.json, and snapshot-summary.json.
Missing files are treated as empty. Exit 1 when the head has a failure the base does not.
`)
  process.exit(0)
}

let summary
if (hasFlag('--run')) {
  let baseRoot = ''
  try {
    const ran = runBoth()
    baseRoot = path.join(path.dirname(ran.headOut), 'base')
    summary = writeSummary(ran.baseOut, ran.headOut, ran.baseSha)
  } finally {
    cleanupWorktree(baseRoot)
  }
} else if (argValue('--base') && argValue('--head')) {
  summary = writeSummary(path.resolve(argValue('--base')), path.resolve(argValue('--head')), argValue('--base-ref'))
} else {
  process.stderr.write('pass --run, or --base and --head\n')
  process.exit(2)
}
process.exit(summary.ok ? 0 : 1)
