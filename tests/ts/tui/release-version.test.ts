import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is ESM and the slash registry imports Bun-only modules.
// Transpile the pure helper so Node's mocha runner can load it.
function loadReleaseVersion(): typeof import('../../../typescript/cast-tui/src/lib/release-version') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/release-version.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = {exports: {} as any}
  const sandbox: any = {
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

const helper = loadReleaseVersion()

/** demo-agent releases.json from issue #21, oldest first in the file. */
const DEMO_RELEASES = [
  {version: '1.0', message: 'Initial release'},
  {version: '1.1', message: 'Add bash tool'},
  {version: '1.2', message: 'Add read tool'},
  {version: '1.3', message: 'Wire up glob tool'},
  {version: '1.4', message: 'Add MCP support'},
  {version: '1.4.1', message: 'Patch MCP tool discovery'},
]

describe('suggestNextVersions', () => {
  it('matches Python when the agent has no current release', () => {
    expect(helper.suggestNextVersions(null)).to.deep.equal({
      patch: '0.1.0',
      minor: '0.1.0',
      major: '1.0.0',
    })
    expect(helper.suggestNextVersions('')).to.deep.equal({
      patch: '0.1.0',
      minor: '0.1.0',
      major: '1.0.0',
    })
    expect(helper.suggestNextVersions(undefined).patch).to.equal('0.1.0')
  })

  it('suggests 1.4.2 from demo-agent current 1.4.1', () => {
    const suggestions = helper.suggestNextVersions('1.4.1')
    expect(suggestions).to.deep.equal({
      patch: '1.4.2',
      minor: '1.5.0',
      major: '2.0.0',
    })
    expect(suggestions.patch).to.not.equal('1.0.1')
  })

  it('keeps a two-part version such as 1.10 numeric', () => {
    expect(helper.suggestNextVersions('1.10')).to.deep.equal({
      patch: '1.10.1',
      minor: '1.11.0',
      major: '2.0.0',
    })
    expect(helper.suggestNextVersions('1.9')).to.deep.equal({
      patch: '1.9.1',
      minor: '1.10.0',
      major: '2.0.0',
    })
    expect(helper.semverParts('1.10')).to.deep.equal([1, 10, 0])
    expect(helper.compareSemverDescending('1.10', '1.9')).to.equal(-1)
  })

  it('bumps a two-part release the way Python suggest_version does', () => {
    expect(helper.suggestNextVersions('1.0')).to.deep.equal({
      patch: '1.0.1',
      minor: '1.1.0',
      major: '2.0.0',
    })
    expect(helper.suggestNextVersions('1.6')).to.deep.equal({
      patch: '1.6.1',
      minor: '1.7.0',
      major: '2.0.0',
    })
    expect(helper.suggestNextVersions('2.10.5')).to.deep.equal({
      patch: '2.10.6',
      minor: '2.11.0',
      major: '3.0.0',
    })
  })

  it('sets breaking without changing the three suggestions', () => {
    expect(helper.suggestNextVersions('1.4.1', true)).to.deep.equal({
      patch: '1.4.2',
      minor: '1.5.0',
      major: '2.0.0',
      breaking: true,
    })
  })

  it('treats an invalid current version as no release', () => {
    expect(helper.suggestNextVersions('1').patch).to.equal('0.1.0')
    expect(helper.suggestNextVersions('v1.4.1').patch).to.equal('0.1.0')
  })
})

describe('validateSemver', () => {
  for (const version of ['1.0', '1.6', '2.0', '1.0.0', '2.10.5', '100.200.300', '0.0.1', '1.10', '1.4.1', '1.4.2']) {
    it(`accepts ${version}`, () => {
      expect(helper.validateSemver(version)).to.equal(true)
    })
  }

  for (const version of ['1', '1.', '.1', '1.0.0.0', 'v1.0', '1.0-beta', 'abc', '', '1.0.0 ', ' 1.0.0', '-1.0', '1.-1', '01.2', '1.01']) {
    it(`rejects ${JSON.stringify(version)}`, () => {
      expect(helper.validateSemver(version)).to.equal(false)
    })
  }
})

describe('release picker rows', () => {
  it('lists demo-agent newest first and marks 1.4.1 latest', () => {
    const rows = helper.releasePickerRows(DEMO_RELEASES, '1.4.1')
    expect(rows.map((row) => row.label)).to.deep.equal([
      '1.4.1 (latest)',
      '1.4',
      '1.3',
      '1.2',
      '1.1',
      '1.0',
    ])
    expect(rows[0].latest).to.equal(true)
    expect(rows[0].message).to.equal('Patch MCP tool discovery')
    expect(helper.latestReleaseIndex(rows)).to.equal(0)
    expect(rows.filter((row) => row.latest)).to.have.length(1)
  })

  it('does not treat index 0 as latest when current is an older release', () => {
    const rows = helper.releasePickerRows(
      [
        {version: '1.0', message: 'oldest in the file'},
        {version: '1.9', message: 'current'},
        {version: '1.10', message: 'newer semver'},
      ],
      '1.9',
    )
    expect(rows.map((row) => row.label)).to.deep.equal([
      '1.10',
      '1.9 (latest)',
      '1.0',
    ])
    expect(helper.latestReleaseIndex(rows)).to.equal(1)
    expect(rows[0].latest).to.equal(false)
  })

  it('sorts 1.4.1 above 1.4 and 1.10 above 1.9', () => {
    const sorted = helper.sortReleasesDescending([
      {version: '1.4'},
      {version: '1.10'},
      {version: '1.4.1'},
      {version: '1.9'},
      {version: '1.2'},
    ])
    expect(sorted.map((row) => row.version)).to.deep.equal(['1.10', '1.9', '1.4.1', '1.4', '1.2'])
  })

  it('leaves every row unlabeled when there is no current version', () => {
    const rows = helper.releasePickerRows(DEMO_RELEASES, null)
    expect(rows.some((row) => row.latest)).to.equal(false)
    expect(rows[0].label).to.equal('1.4.1')
    expect(helper.latestReleaseIndex(rows)).to.equal(0)
  })
})

describe('release form state', () => {
  it('prefills demo-agent with patch 1.4.2 and shows current 1.4.1', () => {
    const form = helper.releaseFormState('1.4.1')
    expect(form.currentLabel).to.equal('1.4.1')
    expect(form.version).to.equal('1.4.2')
    expect(form.suggestions.patch).to.equal('1.4.2')
    expect(form.suggestions.minor).to.equal('1.5.0')
    expect(form.suggestions.major).to.equal('2.0.0')
  })

  it('prefills 1.10.1 for current 1.10', () => {
    const form = helper.releaseFormState('1.10')
    expect(form.currentLabel).to.equal('1.10')
    expect(form.version).to.equal('1.10.1')
  })

  it('uses a preset version and still reports suggestions from current', () => {
    const form = helper.releaseFormState('1.4.1', '2.0')
    expect(form.version).to.equal('2.0')
    expect(form.suggestions.patch).to.equal('1.4.2')
  })

  it('suggests 0.1.0 when the agent has no release', () => {
    const form = helper.releaseFormState(null)
    expect(form.currentLabel).to.equal('none')
    expect(form.version).to.equal('0.1.0')
  })
})

describe('current release lookup', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-release-version-'))
  })

  afterEach(() => {
    fs.rmSync(home, {recursive: true, force: true})
  })

  function writeReleases(agentName: string, body: unknown): void {
    const file = helper.releasesJsonPath(agentName, home)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, JSON.stringify(body))
  }

  it('reads demo-agent current 1.4.1 and returns releases newest first', () => {
    writeReleases('demo-agent', {
      releases: DEMO_RELEASES.map((release, index) => ({
        ...release,
        change_number: index + 1,
        changelog: '',
        created_at: '2026-05-01T00:00:00Z',
        tarball_path: `.cast/releases/${release.version}.tar.gz`,
      })),
      current: {version: '1.4.1', change_number: 6},
    })

    const loaded = helper.loadReleasesDocument('demo-agent', home)
    expect(loaded.currentVersion).to.equal('1.4.1')
    expect(loaded.releases.map((release) => release.version)).to.deep.equal([
      '1.4.1', '1.4', '1.3', '1.2', '1.1', '1.0',
    ])

    const rows = helper.releasePickerRows(loaded.releases, loaded.currentVersion)
    const form = helper.releaseFormState(loaded.currentVersion)
    expect(rows.map((row) => row.label)[0]).to.equal('1.4.1 (latest)')
    expect(form.currentLabel).to.equal('1.4.1')
    expect(form.version).to.equal('1.4.2')
  })

  it('falls back to the newest semver when current is missing', () => {
    writeReleases('demo-agent', {releases: DEMO_RELEASES})
    const loaded = helper.loadReleasesDocument('demo-agent', home)
    expect(loaded.currentVersion).to.equal('1.4.1')
    expect(helper.releaseFormState(loaded.currentVersion).version).to.equal('1.4.2')
  })

  it('keeps a stale current version instead of the first file row', () => {
    writeReleases('demo-agent', {
      releases: DEMO_RELEASES,
      current: {version: '1.0', change_number: 1},
    })
    const loaded = helper.loadReleasesDocument('demo-agent', home)
    expect(loaded.currentVersion).to.equal('1.0')
    const rows = helper.releasePickerRows(loaded.releases, loaded.currentVersion)
    expect(rows.map((row) => row.label)).to.include('1.0 (latest)')
    expect(rows[0].label).to.equal('1.4.1')
    expect(rows[0].latest).to.equal(false)
  })

  it('returns an empty list when releases.json is missing or unreadable', () => {
    expect(helper.loadReleasesDocument('missing-agent', home)).to.deep.equal({
      releases: [],
      currentVersion: null,
    })
    const file = helper.releasesJsonPath('broken-agent', home)
    fs.mkdirSync(path.dirname(file), {recursive: true})
    fs.writeFileSync(file, '{')
    expect(helper.loadReleasesDocument('broken-agent', home).releases).to.deep.equal([])
  })

  it('detects breaking change messages the way Python does', () => {
    expect(helper.changesIndicateBreaking(0, ['Removed tool: bash'])).to.equal(false)
    expect(helper.changesIndicateBreaking(2, ['Initial', 'Removed tool: bash'])).to.equal(true)
    expect(helper.changesIndicateBreaking(1, ['Updated the prompt'])).to.equal(false)

    const changes = path.join(home, '.cast', 'agents', 'demo-agent', '.cast', 'changes', 'changes.json')
    fs.mkdirSync(path.dirname(changes), {recursive: true})
    fs.writeFileSync(changes, JSON.stringify({
      current: 2,
      versions: [{message: 'Removed tool: bash'}],
    }))
    expect(helper.agentChangesIndicateBreaking('demo-agent', home)).to.equal(true)
    const form = helper.releaseFormState('1.4.1', '', true)
    expect(form.suggestions.breaking).to.equal(true)
    expect(form.version).to.equal('1.4.2')
  })
})

describe('parseDiffArgs', () => {
  it('parses two --change values', () => {
    expect(helper.parseDiffArgs(['--change', '1', '--change', '4'])).to.deep.equal({
      ok: true,
      kind: 'change',
      left: 1,
      right: 4,
    })
    expect(helper.parseDiffArgs(['--change=3', '--change=8'])).to.deep.equal({
      ok: true,
      kind: 'change',
      left: 3,
      right: 8,
    })
  })

  it('parses two --release values and keeps 1.10 as text', () => {
    const parsed = helper.parseDiffArgs(['--release', '1.0', '--release', '1.10'])
    expect(parsed).to.deep.equal({
      ok: true,
      kind: 'release',
      left: '1.0',
      right: '1.10',
    })
    if (parsed.ok && parsed.kind === 'release') {
      expect(parsed.right).to.equal('1.10')
      expect(parsed.right).to.not.equal('1.1')
    }
    expect(helper.parseDiffArgs(['--release=1.4.1', '--release=1.10'])).to.deep.equal({
      ok: true,
      kind: 'release',
      left: '1.4.1',
      right: '1.10',
    })
  })

  it('treats no arguments as the interactive picker', () => {
    expect(helper.parseDiffArgs([])).to.deep.equal({ok: true, kind: 'interactive'})
  })

  it('rejects a single side, mixed flags, and unknown tokens', () => {
    expect(helper.parseDiffArgs(['--change', '1']).ok).to.equal(false)
    expect(helper.parseDiffArgs(['--release', '1.0']).ok).to.equal(false)
    expect(helper.parseDiffArgs(['--change', '1', '--release', '1.0']).ok).to.equal(false)
    const unknown = helper.parseDiffArgs(['--file', 'agent.yaml'])
    expect(unknown.ok).to.equal(false)
    if (!unknown.ok) expect(unknown.error).to.include('--file')
    expect(helper.parseDiffArgs(['--change', '1.10']).ok).to.equal(false)
  })
})

describe('isDeploymentSha', () => {
  it('matches a 6-character lowercase alphanumeric SHA', () => {
    expect(helper.isDeploymentSha('abc123')).to.equal(true)
    expect(helper.isDeploymentSha('000000')).to.equal(true)
    expect(helper.isDeploymentSha('a1b2c3')).to.equal(true)
  })

  it('rejects other lengths, uppercase, and agent names', () => {
    expect(helper.isDeploymentSha('abc12')).to.equal(false)
    expect(helper.isDeploymentSha('abc1234')).to.equal(false)
    expect(helper.isDeploymentSha('ABC123')).to.equal(false)
    expect(helper.isDeploymentSha('demo-agent')).to.equal(false)
    expect(helper.isDeploymentSha('')).to.equal(false)
    expect(helper.isDeploymentSha('abc-12')).to.equal(false)
  })
})

describe('slash registry wiring', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
    'utf8',
  )

  it('deploy labels latest from the current version', () => {
    expect(source).to.include("from '../lib/release-version.js'")
    expect(source).to.include('releasePickerRows')
    expect(source).to.include('latestReleaseIndex')
    expect(source).to.not.include('i === 0 ? `${r.version} (latest)`')
  })

  it('release uses the shared form state and semver check', () => {
    expect(source).to.include('releaseFormState')
    expect(source).to.include('validateSemver(v)')
    expect(source).to.not.include('function suggestNextVersions')
    expect(source).to.not.include('function getCurrentReleaseVersion')
    expect(source).to.not.include('/^\\d+(\\.\\d+){0,2}$/')
  })

  it('connect accepts a typed value only when it is a deployment SHA', () => {
    expect(source).to.include('isDeploymentSha(shaInput)')
  })
})
