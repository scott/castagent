#!/usr/bin/env node
// Provider smoke runner. Mocha's glob is tests/**/*.test.ts, so this file
// stays .mjs and is not collected by the unit suite.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {loadProviders, providerCases, providerTokens} from './lib/discover.mjs'
import {assertNoToken, repoRoot, setActiveTokens, startProcSampler, withFixture} from './lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const summaryPath = process.env.SMOKE_SUMMARY
  ? path.resolve(process.env.SMOKE_SUMMARY)
  : path.join(here, 'smoke-summary.json')

function printHelp() {
  process.stdout.write(`Usage: node tests/e2e/run.mjs [--provider <name>] [--case <id>]

Run every discovered provider, or limit the run.

  --provider fly,sprites     one or more provider module names
  --case fly.deploy          one or more case ids (provider.case)
  fly.upgrade-failure        a positional id or provider name is the same filter
  --list                     print matching case ids and exit

--provider and --case combine with AND. Both flags together run only the
named cases of the named providers.

Adding a provider is a new file in tests/e2e/providers/. See tests/e2e/README.md.
`)
}

function selection(argv, cases) {
  const providers = new Set()
  const ids = new Set()
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      printHelp()
      process.exit(0)
    }
    if (arg === '--list') continue
    const take = flag => {
      const value = args[++i]
      if (!value || value.startsWith('--')) {
        process.stderr.write(`missing value for ${flag}\n`)
        process.exit(2)
      }
      return value.split(',').map(item => item.trim()).filter(Boolean)
    }
    if (arg === '--provider' || arg === '-p') {
      for (const name of take(arg)) providers.add(name)
      continue
    }
    if (arg === '--case' || arg === '-c') {
      for (const name of take(arg)) ids.add(name)
      continue
    }
    if (arg.startsWith('--provider=')) {
      for (const name of arg.slice('--provider='.length).split(',')) if (name.trim()) providers.add(name.trim())
      continue
    }
    if (arg.startsWith('--case=')) {
      for (const name of arg.slice('--case='.length).split(',')) if (name.trim()) ids.add(name.trim())
      continue
    }
    if (arg.startsWith('-')) {
      process.stderr.write(`unknown flag ${arg}\n`)
      printHelp()
      process.exit(2)
    }
    if (arg.includes('.')) ids.add(arg)
    else providers.add(arg)
  }
  if (providers.size === 0 && ids.size === 0) return cases
  const chosen = cases.filter(item => {
    const providerOk = providers.size === 0 || providers.has(item.provider)
    const idOk = ids.size === 0 || ids.has(item.id)
    return providerOk && idOk
  })
  const knownIds = new Set(cases.map(item => item.id))
  const knownProviders = new Set(cases.map(item => item.provider))
  const unknown = []
  for (const id of ids) if (!knownIds.has(id)) unknown.push(id)
  for (const name of providers) if (!knownProviders.has(name)) unknown.push(name)
  if (unknown.length > 0) {
    process.stderr.write(`unknown case or provider: ${unknown.join(', ')}\n`)
    process.stderr.write(`known: ${[...knownIds].sort().join(', ')}\n`)
    process.exit(2)
  }
  return chosen
}

if (process.env.CI && (process.env.UPDATE_ENDINGS === '1' || process.env.UPDATE_SNAPSHOTS === '1')) {
  process.stderr.write('refusing to update snapshots in CI\n')
  process.exit(2)
}

const modules = await loadProviders()
setActiveTokens(providerTokens(modules))
const cases = selection(process.argv, providerCases(modules))
if (process.argv.includes('--list')) {
  for (const item of cases) process.stdout.write(`${item.id}\n`)
  process.exit(0)
}
const started = Date.now()
const results = []

for (const item of cases) {
  const caseStarted = Date.now()
  if (item.skip) {
    results.push({
      id: item.id,
      provider: item.provider,
      case: item.name,
      status: 'skip',
      reason: item.skip,
      durationMs: 0,
    })
    process.stdout.write(`skip  ${item.id}\n`)
    continue
  }
  try {
    if (item.ownSampler) {
      await item.run()
    } else {
      const sampler = startProcSampler()
      let procHits = []
      await withFixture(async fx => {
        try {
          await item.run(fx)
        } finally {
          procHits = sampler.stop()
        }
        assertNoToken(fx.requests(), procHits)
      })
    }
    const durationMs = Date.now() - caseStarted
    results.push({id: item.id, provider: item.provider, case: item.name, status: 'pass', durationMs})
    process.stdout.write(`pass  ${item.id} (${durationMs}ms)\n`)
  } catch (error) {
    const durationMs = Date.now() - caseStarted
    const message = error instanceof Error ? error.stack || error.message : String(error)
    results.push({
      id: item.id,
      provider: item.provider,
      case: item.name,
      status: 'fail',
      durationMs,
      error: message.split('\n').slice(0, 40).join('\n'),
    })
    process.stdout.write(`fail  ${item.id} (${durationMs}ms)\n${message}\n`)
  }
}

const summary = {
  ok: results.every(item => item.status !== 'fail'),
  durationMs: Date.now() - started,
  repo: repoRoot,
  cases: results,
}
fs.mkdirSync(path.dirname(summaryPath), {recursive: true})
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
process.stdout.write(`\n${summary.ok ? 'pass' : 'fail'} ${results.filter(item => item.status === 'pass').length} passed, ${results.filter(item => item.status === 'fail').length} failed, ${results.filter(item => item.status === 'skip').length} skipped\n`)
process.stdout.write(`summary ${summaryPath}\n`)
process.exit(summary.ok ? 0 : 1)
