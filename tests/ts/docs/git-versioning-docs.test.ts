import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import {defaultCastIgnoreContents} from '../../../typescript/cast-cli/src/lib/cast-ignore'

const repoRoot = path.resolve(__dirname, '../../..')

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8')
}

function fenceAfter(markdown: string, marker: string): string {
  const at = markdown.indexOf(marker)
  expect(at, marker).to.be.greaterThan(-1)
  const match = markdown.slice(at + marker.length).match(/```[^\n]*\n([\s\S]*?)```/)
  expect(match, `fenced block after ${marker}`).to.not.equal(null)
  return match![1]
}

/**
 * Issue #160: the Git page must describe the default ignore file and
 * the branch `cast git init` actually creates, without contradicting
 * itself.
 */
describe('Git versioning docs', () => {
  const gitPage = read('docs-site/content/building-agents/versioning/git.md')
  const overview = read('docs-site/content/building-agents/versioning/overview.md')
  const initSource = read('typescript/cast-cli/src/commands/git/init.ts')

  it('documents the default ignore file exactly', () => {
    const documented = fenceAfter(gitPage, 'The default contents are:')
    expect(documented).to.equal(defaultCastIgnoreContents())
    expect(documented).to.contain('.cast/versions/\n')
    expect(documented).to.not.contain('.cast/changes/')
  })

  it('says the current undo log is committed and the legacy path is ignored', () => {
    const flat = gitPage.replace(/\s+/g, ' ')
    expect(flat).to.include('Excluded from `cast git`? | no (not in `.castignore`)')
    expect(flat).to.include('includes both its releases and its undo log')
    expect(flat).to.include('excludes the legacy `.cast/versions/` directory, not `.cast/changes/`')
    expect(flat).to.not.include('not with the undo log')
    expect(flat).to.not.include('yes (`.castignore`)')
  })

  it('says cast git init checks out main and hints at git config', () => {
    const flat = gitPage.replace(/\s+/g, ' ')
    expect(flat).to.include('Runs `git init -b main`')
    expect(flat).to.include('checked-out branch is `main`')
    expect(flat).to.include('Git repo on `main`')
    expect(flat).to.include('git config --global user.email')
    expect(flat).to.include('GIT_AUTHOR_NAME')
    expect(flat).to.include('GIT_CONFIG_GLOBAL')
    expect(flat).to.include('that directory is removed')
    expect(flat).to.include('`/git init` checks out `main`')
    expect(flat).to.not.include('does not pass `-b main`')
    expect(flat).to.not.include('`master` when `init.defaultBranch` is unset')
    expect(initSource).to.include("git.raw(['init', '-b', 'main'])")
    expect(initSource).to.include('assertGitAuthorIdentity')
    expect(initSource).to.include("branch: 'main'")
  })

  it('keeps the release path, remote removal, and TUI commit docs', () => {
    const flat = gitPage.replace(/\s+/g, ' ')
    expect(flat).to.include('`releases.json` stores each `tarball_path` relative to the agent directory')
    expect(flat).to.include('`remove` also deletes `repository.url`')
    expect(flat).to.include('`/git commit -m tui-commit` stores `tui-commit`')
  })

  it('says the docker compose file does not store the deployment token', () => {
    const anatomy = read('docs-site/content/building-agents/anatomy.md').replace(/\s+/g, ' ')
    const settings = read('docs-site/content/getting-started/global-settings.md').replace(/\s+/g, ' ')
    const flat = gitPage.replace(/\s+/g, ' ')
    expect(flat).to.include('does not contain the deployment bearer token')
    expect(flat).to.include('/docker-compose.yml')
    expect(flat).to.include('does not start tracking `docker-compose.yml`')
    expect(anatomy).to.include('does not contain the deployment bearer token or provider API keys')
    expect(settings).to.include('does not write them into `docker-compose.yml`')
    expect(defaultCastIgnoreContents()).to.include('/docker-compose.yml\n')
    expect(defaultCastIgnoreContents()).to.include('/.cast-runtime/\n')
  })

  it('matches the versioning overview', () => {
    const flat = overview.replace(/\s+/g, ' ')
    expect(flat).to.include('do not exclude the current undo log at `.cast/changes/`')
    expect(flat).to.include('exclude the legacy `.cast/versions/` directory')
    expect(flat).to.not.include('undo log is intentionally excluded')
  })
})
