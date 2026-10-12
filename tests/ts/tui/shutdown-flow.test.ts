import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is ESM and imports @opentui/core from the slash registry.
// Transpile the pure helper (and its provider-name dependency) instead.
function loadTsModule(file: string, cache = new Map<string, any>()): any {
  const resolved = path.resolve(file)
  const cached = cache.get(resolved)
  if (cached) return cached
  const source = fs.readFileSync(resolved, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = {exports: {} as any}
  const dirname = path.dirname(resolved)
  function localRequire(id: string) {
    if (!id.startsWith('.')) return require(id)
    const target = path.resolve(dirname, id)
    const candidates = [target, `${target}.ts`, target.replace(/\.js$/, '.ts')]
    const hit = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile())
    if (!hit) throw new Error(`cannot resolve ${id} from ${resolved}`)
    return loadTsModule(hit, cache)
  }
  const sandbox: any = {
    exports: module.exports,
    module,
    require: localRequire,
    __dirname: dirname,
    __filename: resolved,
    console,
    process,
  }
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox, {filename: resolved})
  cache.set(resolved, module.exports)
  return module.exports
}

const shutdownFlow = loadTsModule(
  path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/shutdown-flow.ts'),
)
const providers = loadTsModule(
  path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/deployment-providers.ts'),
)

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))

describe('shutdown flow helpers', () => {
  const {
    CAST_CLI_NOT_FOUND_MESSAGE,
    NO_DEPLOYED_AGENTS_MESSAGE,
    SHUTDOWN_SUCCESS_STATUS,
    deploymentVersionLabel,
    formatRelativeTime,
    shortDeploymentSha,
    shouldKillShutdownOnEscape,
    shutdownConfirmationLines,
    shutdownFailureStatus,
    shutdownSpawnArgs,
    shutdownStageFromLine,
  } = shutdownFlow

  it('formats compact and long relative times from SQLite UTC timestamps', () => {
    expect(formatRelativeTime('2026-10-09 12:00:00', NOW)).to.equal('3d ago')
    expect(formatRelativeTime('2026-10-09 12:00:00', NOW, 'long')).to.equal('3 days ago')
    expect(formatRelativeTime('2026-10-11 12:00:00', NOW, 'long')).to.equal('1 day ago')
    expect(formatRelativeTime('2026-10-12 10:00:00', NOW)).to.equal('2h ago')
    expect(formatRelativeTime('2026-10-12 10:00:00', NOW, 'long')).to.equal('2 hours ago')
    expect(formatRelativeTime('2026-10-12 11:00:00', NOW, 'long')).to.equal('1 hour ago')
    expect(formatRelativeTime('2026-10-12 11:55:00', NOW)).to.equal('5m ago')
    expect(formatRelativeTime('2026-10-12 11:55:00', NOW, 'long')).to.equal('5 minutes ago')
    expect(formatRelativeTime('2026-10-12 11:59:30', NOW)).to.equal('just now')
    expect(formatRelativeTime('2025-10-12 12:00:00', NOW)).to.equal('1y ago')
    expect(formatRelativeTime('2025-10-12 12:00:00', NOW, 'long')).to.equal('1 year ago')
    expect(formatRelativeTime('2026-10-09T12:00:00Z', NOW, 'compact')).to.equal('3d ago')
    expect(formatRelativeTime(null, NOW)).to.equal('-')
    expect(formatRelativeTime('', NOW)).to.equal('-')
    expect(formatRelativeTime('not-a-date', NOW)).to.equal('-')
  })

  it('slices the deployment id to 8 characters', () => {
    expect(shortDeploymentSha('a1b2c3d4ffff')).to.equal('a1b2c3d4')
    expect(shortDeploymentSha('abc123')).to.equal('abc123')
    expect(shortDeploymentSha(null)).to.equal('-')
    expect(shortDeploymentSha('')).to.equal('-')
    expect(shortDeploymentSha('   ')).to.equal('-')
  })

  it('renders version or a dash', () => {
    expect(deploymentVersionLabel('v1.2.0')).to.equal('v1.2.0')
    expect(deploymentVersionLabel(null)).to.equal('-')
    expect(deploymentVersionLabel(undefined)).to.equal('-')
    expect(deploymentVersionLabel('')).to.equal('-')
  })

  it('builds the Y/N confirmation, including provider display names', () => {
    const lines = shutdownConfirmationLines({
      agentName: 'my-agent',
      provider: 'digitalocean',
      id: 'a1b2c3d4ffff',
      deployedVersion: 'v1.2.0',
      deployedAt: '2026-10-09 12:00:00',
    }, NOW)
    expect(lines.join('\n')).to.equal(
      [
        "Shut down 'my-agent'?",
        '  Provider:  DigitalOcean',
        '  Version:   v1.2.0',
        '  Deployed:  3 days ago',
        '  SHA:       a1b2c3d4',
        '',
        '  This will destroy the remote droplet and',
        '  all associated resources. This cannot be undone.',
        '',
        '  [Y] Yes, shut it down    [N] Cancel',
      ].join('\n'),
    )

    const microvm = shutdownConfirmationLines({
      agentName: 'edge',
      provider: 'microvm',
      id: 'deadbeef',
      deployedVersion: null,
      deployedAt: null,
    }, NOW)
    expect(microvm[1]).to.equal('  Provider:  DigitalOcean MicroVM')
    expect(microvm[2]).to.equal('  Version:   -')
    expect(microvm[3]).to.equal('  Deployed:  -')
    expect(microvm[4]).to.equal('  SHA:       deadbeef')

    const local = shutdownConfirmationLines({
      agentName: 'edge',
      provider: 'local',
      id: 'abc',
      deployedVersion: '1.0.0',
      deployedAt: '2026-10-12 11:55:00',
    }, NOW)
    expect(local[1]).to.equal('  Provider:  Local (no container)')
    expect(local[3]).to.equal('  Deployed:  5 minutes ago')
  })

  it('maps every provider list key, and keeps unknown keys', () => {
    for (const provider of providers.DEPLOYMENT_PROVIDERS) {
      expect(providers.providerDisplayName(provider.key)).to.equal(provider.name)
    }
    expect(providers.providerDisplayName('custom-cloud')).to.equal('custom-cloud')
    expect(providers.providerDisplayName(null)).to.equal('-')
    expect(providers.providerDisplayName('microvm')).to.equal('DigitalOcean MicroVM')
    expect(providers.providerDisplayName('local')).to.equal('Local (no container)')
  })

  it('spawns cast shutdown --force with the agent name', () => {
    expect(shutdownSpawnArgs('my-agent')).to.deep.equal(['shutdown', '--force', 'my-agent'])
    expect(shutdownSpawnArgs('other agent')).to.deep.equal(['shutdown', '--force', 'other agent'])
  })

  it('uses the empty-state and missing-binary copy', () => {
    expect(NO_DEPLOYED_AGENTS_MESSAGE).to.equal('No deployed agents to shut down.')
    expect(CAST_CLI_NOT_FOUND_MESSAGE).to.equal('cast CLI not found. Install cast first.')
    expect(SHUTDOWN_SUCCESS_STATUS).to.equal('Shutdown completed!')
    expect(shutdownFailureStatus(2)).to.equal('Shutdown failed (exit code: 2)')
    expect(shutdownFailureStatus(null)).to.equal('Shutdown failed (exit code: null)')
  })

  it('does not kill the child when ESC closes the stream', () => {
    expect(shouldKillShutdownOnEscape()).to.equal(false)
  })

  it('detects shutdown stages from CLI log lines', () => {
    expect(shutdownStageFromLine("Shutting down email on fly...")).to.equal('Destroying remote resources')
    expect(shutdownStageFromLine('Remote resources destroyed on fly.')).to.equal('Removing local records')
    expect(shutdownStageFromLine('Marked all deployments as deleted in database.')).to.equal('Updating database')
    expect(shutdownStageFromLine('Removed auth token from keychain.')).to.equal('Removing credentials')
    expect(shutdownStageFromLine("Agent 'email' has been shut down.")).to.equal('Finished')
    expect(shutdownStageFromLine('nothing to see')).to.equal(null)
  })

  it('registers /shutdown for dev and production and wires the terminal helpers', () => {
    const registry = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/commands/slash-registry.ts'),
      'utf8',
    )
    const at = registry.indexOf("name: 'shutdown'")
    expect(at).to.be.greaterThan(0)
    const block = registry.slice(at, at + 500)
    expect(block).to.include("category: 'agent'")
    expect(block).to.include("modes: ['dev', 'production']")
    expect(block).to.not.include('on-host')
    expect(registry).to.include('NO_DEPLOYED_AGENTS_MESSAGE')
    expect(registry).to.include('CAST_CLI_NOT_FOUND_MESSAGE')
    expect(registry).to.include('runShutdownInTerminal')

    const terminal = fs.readFileSync(
      path.resolve(__dirname, '../../../typescript/cast-tui/src/components/terminal.ts'),
      'utf8',
    )
    expect(terminal).to.include('shouldKillShutdownOnEscape()')
    expect(terminal).to.include('shutdownSpawnArgs(')
    expect(terminal).to.include('SHUTDOWN_SUCCESS_STATUS')
    expect(terminal).to.include('shutdownFailureStatus(')
    expect(terminal).to.include('export async function runShutdownInTerminal')
  })
})
