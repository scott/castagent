import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  GIT_IDENTITY_HINT,
  assertGitAuthorIdentity,
  isGitIdentityFailure,
} from '../../../typescript/cast-cli/src/lib/git-identity'

const IDENTITY_ENV_KEYS = [
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_COUNT',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'EMAIL',
]

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(IDENTITY_ENV_KEYS.map(key => [key, process.env[key]]))
}

function restoreEnv(saved: Map<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('git author identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-git-identity-'))

  after(() => {
    fs.rmSync(root, {recursive: true, force: true})
  })

  it('accepts a configured name and email', async () => {
    const saved = snapshotEnv()
    process.env.GIT_AUTHOR_NAME = 'Cast Test'
    process.env.GIT_AUTHOR_EMAIL = 'cast-test@example.com'
    process.env.GIT_COMMITTER_NAME = 'Cast Test'
    process.env.GIT_COMMITTER_EMAIL = 'cast-test@example.com'
    try {
      await assertGitAuthorIdentity(root)
    } finally {
      restoreEnv(saved)
    }
  })

  it('reports a missing email with a git config hint', async () => {
    const saved = snapshotEnv()
    const empty = path.join(root, 'empty-gitconfig')
    fs.writeFileSync(empty, '')
    process.env.GIT_CONFIG_GLOBAL = empty
    process.env.GIT_CONFIG_SYSTEM = empty
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    delete process.env.GIT_CONFIG_COUNT
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'EMAIL']) {
      delete process.env[key]
    }

    try {
      let caught: unknown
      try {
        await assertGitAuthorIdentity(root)
      } catch (error) {
        caught = error
      }
      expect(caught, 'missing identity should fail').to.not.equal(undefined)
      expect(isGitIdentityFailure(caught)).to.equal(true)
      expect((caught as Error).message).to.equal(GIT_IDENTITY_HINT)
      expect((caught as Error).message).to.include('git config --global user.email')
      expect((caught as Error).message).to.include('git config --global user.name')
    } finally {
      restoreEnv(saved)
    }
  })

  it('recognizes the raw auto-detect email failure', () => {
    const raw = 'fatal: unable to auto-detect email address (got \'ubuntu@cursor.(none)\')'
    expect(isGitIdentityFailure(new Error(raw))).to.equal(true)
    expect(isGitIdentityFailure(new Error('Authentication failed'))).to.equal(false)
  })

  it('matches the failure git commit prints without an email', () => {
    const repo = path.join(root, 'no-email')
    fs.mkdirSync(repo)
    const empty = path.join(root, 'commit-gitconfig')
    fs.writeFileSync(empty, '')
    execFileSync('git', ['init', '-b', 'main'], {cwd: repo})
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
    execFileSync('git', ['add', 'README.md'], {cwd: repo})
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: empty,
      GIT_CONFIG_SYSTEM: empty,
      GIT_CONFIG_NOSYSTEM: '1',
    }
    delete env.GIT_CONFIG_COUNT
    delete env.GIT_AUTHOR_NAME
    delete env.GIT_AUTHOR_EMAIL
    delete env.GIT_COMMITTER_NAME
    delete env.GIT_COMMITTER_EMAIL
    delete env.EMAIL
    let stderr = ''
    try {
      execFileSync('git', ['commit', '-m', 'initial'], {
        cwd: repo,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error: any) {
      stderr = `${error.stderr ?? ''}\n${error.message}`
    }
    expect(stderr).to.match(/unable to auto-detect email address/)
    expect(isGitIdentityFailure(new Error(stderr))).to.equal(true)
  })
})
