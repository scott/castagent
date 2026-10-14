import {execFile} from 'child_process'

/**
 * Missing author identity stops `/git init` before it creates a repo.
 * Keep this in sync with typescript/cast-cli/src/lib/git-identity.ts.
 */
export const GIT_IDENTITY_HINT = [
  'Git could not determine your name and email.',
  'Set them with git config, then try again:',
  '  git config --global user.name "Your Name"',
  '  git config --global user.email "you@example.com"',
].join('\n')

export class GitIdentityError extends Error {
  constructor() {
    super(GIT_IDENTITY_HINT)
    this.name = 'GitIdentityError'
  }
}

const IDENTITY_FAILURE = /unable to auto-detect email address|Author identity unknown|empty ident name|no email was given and auto-detection is disabled/i

export function isGitIdentityFailure(error: unknown): boolean {
  if (error instanceof GitIdentityError) return true
  const message = error instanceof Error ? error.message : String(error)
  return IDENTITY_FAILURE.test(message)
}

/**
 * Fail when `git commit` would refuse to record an author.
 * `git var GIT_AUTHOR_IDENT` uses the same name and email lookup as commit.
 */
export function assertGitAuthorIdentity(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['var', 'GIT_AUTHOR_IDENT'],
      {cwd, env: process.env, windowsHide: true},
      (error, stdout, stderr) => {
        if (!error) {
          if (String(stdout).trim().length === 0) {
            reject(new GitIdentityError())
            return
          }
          resolve()
          return
        }
        const message = `${error.message}\n${stderr ?? ''}`
        if (IDENTITY_FAILURE.test(message)) {
          reject(new GitIdentityError())
          return
        }
        reject(error)
      },
    )
  })
}
