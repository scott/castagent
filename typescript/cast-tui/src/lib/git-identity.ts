import {execFile} from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import {simpleGit, type SimpleGit} from 'simple-git'

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

/**
 * simple-git 4 strips ambient GIT_* variables before it spawns git.
 * These are the identity inputs `git commit` already reads. Allowing
 * them keeps cast git aligned with a normal git process. Other GIT_*
 * variables stay blocked.
 */
export const GIT_IDENTITY_ENV = [
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_CONFIG_GLOBAL',
] as const

export function createAgentGit(baseDir: string): SimpleGit {
  return simpleGit({
    baseDir,
    allowEnvironment: [...GIT_IDENTITY_ENV],
  })
}

const INIT_ROLLBACK_FILES = ['.gitignore', '.castignore', 'README.md', 'agent.yaml'] as const

export function snapshotInitFiles(agentPath: string): Map<string, string | null> {
  const snapshot = new Map<string, string | null>()
  for (const name of INIT_ROLLBACK_FILES) {
    const filePath = path.join(agentPath, name)
    snapshot.set(name, fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null)
  }
  return snapshot
}

/**
 * Remove a half-created repository so a failed init can be retried.
 * Restores the agent files init would have overwritten.
 */
export function rollbackFailedInit(agentPath: string, snapshot: Map<string, string | null>): void {
  fs.rmSync(path.join(agentPath, '.git'), {recursive: true, force: true})
  for (const [name, contents] of snapshot) {
    const filePath = path.join(agentPath, name)
    if (contents === null) {
      fs.rmSync(filePath, {force: true})
    } else {
      fs.writeFileSync(filePath, contents)
    }
  }
}
