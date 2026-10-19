import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  GIT_IDENTITY_HINT,
  assertGitAuthorIdentity,
  createAgentGit,
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
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_DATE',
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
    expect(stderr).to.match(/unable to auto-detect email address|Author identity unknown/)
    expect(isGitIdentityFailure(new Error(stderr))).to.equal(true)
  })

  it('commits with author env when the global gitconfig has no identity', async () => {
    const saved = snapshotEnv()
    const empty = path.join(root, 'env-empty-gitconfig')
    fs.writeFileSync(empty, '')
    const repo = path.join(root, 'env-repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['init', '-b', 'main'], {cwd: repo})
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
    process.env.GIT_CONFIG_GLOBAL = empty
    process.env.GIT_CONFIG_SYSTEM = empty
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    delete process.env.GIT_CONFIG_COUNT
    delete process.env.EMAIL
    process.env.GIT_AUTHOR_NAME = 'Env Author'
    process.env.GIT_AUTHOR_EMAIL = 'env-author@example.com'
    process.env.GIT_COMMITTER_NAME = 'Env Committer'
    process.env.GIT_COMMITTER_EMAIL = 'env-committer@example.com'
    process.env.GIT_AUTHOR_DATE = '2020-01-02T03:04:05Z'
    process.env.GIT_COMMITTER_DATE = '2021-05-06T07:08:09Z'
    try {
      const git = createAgentGit(repo)
      await git.add(['README.md'])
      await git.commit('from env')
      const ident = execFileSync('git', ['log', '-1', '--format=%an|%ae|%cn|%ce|%aI|%cI'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()
      expect(ident.replace(/Z(?=\||$)/g, '+00:00')).to.equal(
        'Env Author|env-author@example.com|Env Committer|env-committer@example.com|2020-01-02T03:04:05+00:00|2021-05-06T07:08:09+00:00',
      )
    } finally {
      restoreEnv(saved)
    }
  })

  it('commits with the name and email from GIT_CONFIG_GLOBAL', async () => {
    const saved = snapshotEnv()
    const config = path.join(root, 'identity-gitconfig')
    fs.writeFileSync(config, [
      '[user]',
      '\tname = Config User',
      '\temail = config-user@example.com',
      '',
    ].join('\n'))
    const empty = path.join(root, 'config-empty-system')
    fs.writeFileSync(empty, '')
    const repo = path.join(root, 'config-repo')
    fs.mkdirSync(repo)
    execFileSync('git', ['init', '-b', 'main'], {cwd: repo})
    fs.writeFileSync(path.join(repo, 'README.md'), 'hello\n')
    process.env.GIT_CONFIG_GLOBAL = config
    process.env.GIT_CONFIG_SYSTEM = empty
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    delete process.env.GIT_CONFIG_COUNT
    for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_AUTHOR_DATE', 'GIT_COMMITTER_DATE', 'EMAIL']) {
      delete process.env[key]
    }
    try {
      const git = createAgentGit(repo)
      await git.add(['README.md'])
      await git.commit('from config')
      const ident = execFileSync('git', ['log', '-1', '--format=%an|%ae'], {
        cwd: repo,
        encoding: 'utf8',
      }).trim()
      expect(ident).to.equal('Config User|config-user@example.com')
    } finally {
      restoreEnv(saved)
    }
  })
})
