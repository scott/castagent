#!/usr/bin/env node
// User-facing CLI output snapshots. Updating files is explicit:
//   UPDATE_SNAPSHOTS=1 node tests/cli-snapshots/run.mjs
// CI never rewrites them, even if UPDATE_SNAPSHOTS is set.
import fs from 'node:fs'
import {createRequire} from 'node:module'
import path from 'node:path'
import vm from 'node:vm'
import {fileURLToPath} from 'node:url'
import ts from 'typescript'
import {assert, assertFailed, assertIncludes, assertOk, oneLive} from '../e2e/lib/assert.mjs'
import {catA, normalizeOutput, repoRoot, withFixture} from '../e2e/lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const snapDir = path.join(here, 'snapshots')
const require = createRequire(path.join(repoRoot, 'package.json'))

if (process.env.CI && process.env.UPDATE_SNAPSHOTS === '1') {
  process.stderr.write('refusing to update snapshots in CI. Run UPDATE_SNAPSHOTS=1 node tests/cli-snapshots/run.mjs locally.\n')
  process.exit(2)
}

function brainYaml(body) {
  return `name: smoke\ndescription: Mocked provider smoke agent\n${body}brain:\n  model: openrouter/anthropic/claude-3-7-sonnet\n`
}

function snapshotText(result, home, recorded) {
  return [
    `# exit: ${result.code}`,
    `# recorded: ${recorded == null ? '' : recorded}`,
    '# stderr cat -A',
    catA(normalizeOutput(result.stderr, home).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>')),
    '# stdout cat -A',
    catA(normalizeOutput(result.stdout, home).replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<time>')),
    '',
  ].join('\n')
}

function checkSnapshot(id, actual) {
  const file = path.join(snapDir, `${id}.txt`)
  if (process.env.UPDATE_SNAPSHOTS === '1') {
    fs.mkdirSync(snapDir, {recursive: true})
    fs.writeFileSync(file, actual)
    process.stdout.write(`updated ${id}\n`)
    return
  }
  if (!fs.existsSync(file)) {
    throw new Error(`missing snapshot ${file}\nRun UPDATE_SNAPSHOTS=1 node tests/cli-snapshots/run.mjs\n--- actual ---\n${actual}`)
  }
  const expected = fs.readFileSync(file, 'utf8')
  if (expected !== actual) {
    throw new Error(`snapshot mismatch for ${id}\n--- expected ---\n${expected}\n--- actual ---\n${actual}`)
  }
}

async function deployVersion(fx, yaml) {
  fx.writeAgentYaml(yaml)
  return fx.cast(['deploy', 'smoke', '--provider', 'sprites'])
}

function versionCase(id, yaml, {recorded, refuse = false, includes = []} = {}) {
  return {
    id,
    async run() {
      await withFixture(async fx => {
        const result = await deployVersion(fx, brainYaml(yaml))
        if (refuse) {
          assertFailed(result, id)
          assert(fx.liveRows().length === 0, 'refused deploy recorded a row')
          for (const needle of includes) assertIncludes(`${result.stdout}\n${result.stderr}`, needle)
          checkSnapshot(id, snapshotText(result, fx.home, null))
          return
        }
        assertOk(result, id)
        const row = oneLive(fx)
        assert(row.deployed_version === recorded, `recorded ${row.deployed_version}`)
        for (const needle of includes) assertIncludes(result.stdout, needle)
        checkSnapshot(id, snapshotText(result, fx.home, row.deployed_version))
      })
    },
  }
}

function loadTs(relativePath) {
  const file = path.join(repoRoot, relativePath)
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = {exports: {}}
  const sandbox = {
    exports: module.exports,
    module,
    require,
    __dirname: path.dirname(file),
    __filename: file,
    console,
    process,
    Buffer,
  }
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox, {filename: file})
  return module.exports
}

const DEMO = [
  {version: '1.0', message: 'Initial release'},
  {version: '1.1', message: 'Add bash tool'},
  {version: '1.2', message: 'Add read tool'},
  {version: '1.3', message: 'Wire up glob tool'},
  {version: '1.4', message: 'Add MCP support'},
  {version: '1.4.1', message: 'Patch MCP tool discovery'},
]

function slashSnapshot() {
  const helper = loadTs('typescript/cast-tui/src/lib/release-version.ts')
  const picker = loadTs('typescript/cast-tui/src/lib/slash-picker.ts')
  const rows = helper.releasePickerRows(DEMO, '1.4.1')
  const form = helper.releaseFormState('1.4.1')
  const form10 = helper.releaseFormState('1.10')
  const help = picker.formatSlashHelp([
    {name: 'release', description: 'Create a release', category: 'agent', args: '[version]'},
    {name: 'releases', description: 'List releases', category: 'agent'},
    {name: 'deploy', description: 'Deploy the agent', category: 'agent', args: '[provider]'},
    {name: 'upgrade', description: 'Upgrade a deployed agent to a new version', category: 'agent'},
    {name: 'registry', description: 'List live deployments', category: 'session'},
    {name: 'connect', description: 'Connect to a deployment', category: 'session', args: '[sha]'},
  ])
  const lines = [
    '# Formatted output shared by the versioning slash commands.',
    '# Issue #18 stays open: modal keyboard flow is not covered, and',
    '# /changes, /versions, /diff, and /restore no longer exist under those names.',
    `suggest 1.4.1 ${JSON.stringify(helper.suggestNextVersions('1.4.1'))}`,
    `suggest 1.10 ${JSON.stringify(helper.suggestNextVersions('1.10'))}`,
    `picker ${rows.map(row => row.label).join(' | ')}`,
    `form 1.4.1 current=${form.currentLabel} version=${form.version} patch=${form.suggestions.patch}`,
    `form 1.10 current=${form10.currentLabel} version=${form10.version}`,
    `sha abc123 ${helper.isDeploymentSha('abc123')}`,
    `sha ABC123 ${helper.isDeploymentSha('ABC123')}`,
    `sha demo-agent ${helper.isDeploymentSha('demo-agent')}`,
    `typed empty ${JSON.stringify(helper.connectTypedTarget(''))}`,
    `typed abc123 ${JSON.stringify(helper.connectTypedTarget('abc123'))}`,
    `typed demo-agent ${JSON.stringify(helper.connectTypedTarget('demo-agent'))}`,
    'help:',
    help.replace(/\s+$/g, ''),
    '',
  ]
  return lines.join('\n')
}

const cases = [
  versionCase('version.missing', '', {
    recorded: '1.0',
    includes: ['Warning: agent.yaml has no version. Recorded 1.0.'],
  }),
  versionCase('version.unquoted-1-10', 'version: 1.10\n', {recorded: '1.10'}),
  versionCase('version.block-literal', 'version: |\n  1.10\n', {recorded: '1.10'}),
  versionCase('version.block-folded', 'version: >\n  1.10\n', {recorded: '1.10'}),
  versionCase('version.block-keep', 'version: |+\n  1.10\n', {recorded: '1.10'}),
  versionCase('version.anchor', 'version: &v 1.10\n', {recorded: '1.10'}),
  versionCase('version.alias', 'pinned: &v 1.10\nversion: *v\n', {recorded: '1.10'}),
  versionCase('version.str-tag', 'version: !!str 1.10\n', {recorded: '1.10'}),
  versionCase('version.float-tag', 'version: !!float 1.10\n', {recorded: '1.10'}),
  versionCase('version.bool-true', 'version: true\n', {
    recorded: 'true',
    includes: ['Warning: agent.yaml version "true" is not a semantic version'],
  }),
  versionCase('version.duplicate', 'version: 1.0\nversion: 2.0\n', {recorded: '2.0'}),
  versionCase('version.whitespace', 'version: |\n  1.4.5\n  extra\n', {
    refuse: true,
    includes: ['contains whitespace', 'version: "1.4.5"'],
  }),
  {
    id: 'slash.version-helpers',
    async run() {
      checkSnapshot('slash.version-helpers', slashSnapshot())
    },
  },
]

function selected(list) {
  const wanted = []
  const args = process.argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write('Usage: node tests/cli-snapshots/run.mjs [--case <id>]\nUPDATE_SNAPSHOTS=1 rewrites tests/cli-snapshots/snapshots/. CI refuses that.\n')
      process.exit(0)
    }
    if (arg === '--case' || arg === '-c') {
      wanted.push(...(args[++i] || '').split(',').map(item => item.trim()).filter(Boolean))
      continue
    }
    if (arg.startsWith('--case=')) {
      wanted.push(...arg.slice('--case='.length).split(',').map(item => item.trim()).filter(Boolean))
      continue
    }
    if (!arg.startsWith('-')) wanted.push(arg)
  }
  if (wanted.length === 0) return list
  const known = new Set(list.map(item => item.id))
  const unknown = wanted.filter(id => !known.has(id))
  if (unknown.length > 0) {
    process.stderr.write(`unknown snapshot: ${unknown.join(', ')}\nknown: ${[...known].join(', ')}\n`)
    process.exit(2)
  }
  return list.filter(item => wanted.includes(item.id))
}

const summaryPath = process.env.SNAPSHOT_SUMMARY
  ? path.resolve(process.env.SNAPSHOT_SUMMARY)
  : path.join(here, 'snapshot-summary.json')

const results = []
let failed = 0
for (const item of selected(cases)) {
  const started = Date.now()
  try {
    await item.run()
    const durationMs = Date.now() - started
    results.push({id: item.id, status: 'pass', durationMs})
    process.stdout.write(`pass  ${item.id} (${durationMs}ms)\n`)
  } catch (error) {
    failed += 1
    const message = error instanceof Error ? error.stack || error.message : String(error)
    results.push({id: item.id, status: 'fail', durationMs: Date.now() - started, error: message.split('\n').slice(0, 30).join('\n')})
    process.stdout.write(`fail  ${item.id}\n${message}\n`)
  }
}
const summary = {
  ok: failed === 0,
  cases: results,
}
fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`)
process.stdout.write(`\n${summary.ok ? 'pass' : 'fail'} ${results.filter(item => item.status === 'pass').length} passed, ${failed} failed\n`)
process.stdout.write(`summary ${summaryPath}\n`)
process.exit(summary.ok ? 0 : 1)
