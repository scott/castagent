import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')

function walk(dir: string): string[] {
  const entries = fs.readdirSync(dir, {withFileTypes: true})
  const files: string[] = []
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(full))
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(full)
    }
  }
  return files
}

/**
 * Issue #140: published docs and the strings the CLI prints must use
 * commands that exist. `cast upgrade` takes VERSION as a positional,
 * `cast shutdown` has no --destroy-volume flag, and there is no
 * `cast git tag` subcommand.
 */
describe('documented CLI surface', () => {
  const sources = [
    path.join(repoRoot, 'README.md'),
    ...walk(path.join(repoRoot, 'docs-site', 'content')),
    path.join(repoRoot, 'typescript/cast-cli/src/commands/upgrade.ts'),
    path.join(repoRoot, 'typescript/cast-cli/src/commands/releases.ts'),
    path.join(repoRoot, 'typescript/cast-cli/src/commands/shutdown.ts'),
    path.join(repoRoot, 'typescript/cast-tui/src/commands/slash-registry.ts'),
  ]

  function offendingLines(pattern: RegExp): string[] {
    const hits: string[] = []
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8')
      const relative = path.relative(repoRoot, file)
      text.split('\n').forEach((line, index) => {
        if (pattern.test(line)) {
          hits.push(`${relative}:${index + 1}: ${line.trim()}`)
        }
      })
    }
    return hits
  }

  it('does not document cast upgrade --version', () => {
    expect(offendingLines(/upgrade[^\n]*--version/)).to.deep.equal([])
  })

  it('does not document cast shutdown --destroy-volume', () => {
    expect(offendingLines(/--destroy-volume/)).to.deep.equal([])
  })

  it('does not document a cast git tag command', () => {
    expect(offendingLines(/cast git tag\b/)).to.deep.equal([])
  })

  it('does not ship a git tag subcommand', () => {
    const gitDir = path.join(repoRoot, 'typescript/cast-cli/src/commands/git')
    const names = fs.readdirSync(gitDir)
      .filter(name => name.endsWith('.ts'))
      .map(name => name.replace(/\.ts$/, ''))
    expect(names).to.not.include('tag')
    expect(names).to.include.members(['init', 'status', 'commit', 'log', 'diff', 'push', 'remote'])
  })

  it('invokes cast upgrade from the TUI with a positional version', () => {
    const source = fs.readFileSync(
      path.join(repoRoot, 'typescript/cast-tui/src/commands/slash-registry.ts'),
      'utf8',
    )
    expect(source).to.include("['upgrade', agent.name, version]")
    expect(source).to.include("['upgrade', agent.name, targetVersion.toString()]")
    expect(source).to.not.include("'--version', version")
  })
})
