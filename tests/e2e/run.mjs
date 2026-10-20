#!/usr/bin/env node
// Provider smoke runner. Mocha's glob is tests/**/*.test.ts, so this file
// stays .mjs and is not collected by the unit suite.
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {cases} from './lib/cases.mjs'
import {assertNoToken, repoRoot, startProcSampler, withFixture} from './lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const summaryPath = process.env.SMOKE_SUMMARY
  ? path.resolve(process.env.SMOKE_SUMMARY)
  : path.join(here, 'smoke-summary.json')

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
