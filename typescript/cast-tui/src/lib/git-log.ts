import {simpleGit} from 'simple-git'

/**
 * `/git log` with no count shows this many commits.
 * The CLI default is 10. The TUI has always used 5.
 */
export const DEFAULT_GIT_LOG_COUNT = 5

export const GIT_LOG_USAGE = 'Usage: /git log [-n <count>]'

export type GitLogCountResult =
  | {ok: true; maxCount: number}
  | {ok: false; message: string}

const LONG_COUNT_FLAGS = new Set(['--count', '--max-count'])

export interface GitLogCommitView {
  shortHash: string
  authorName: string
  date: string
  message: string
}

/**
 * Parse the commit count for `/git log`.
 *
 * `args` is everything after the `log` subcommand. Accepted forms match
 * the CLI flag (`-n`, `--count`) plus git's `--max-count`:
 * `/git log -n 1`, `/git log -n1`, `/git log --count=20`.
 * A later flag replaces an earlier one. The count must be at least 1.
 * simple-git drops `--max-count` when the value is 0, and git treats a
 * negative `--max-count` as unlimited, so both would print every commit.
 */
export function parseGitLogCount(args: readonly string[]): GitLogCountResult {
  let maxCount = DEFAULT_GIT_LOG_COUNT

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    const attached = attachedCount(token)
    if (attached) {
      const parsed = parseCountValue(attached)
      if (!parsed.ok) return parsed
      maxCount = parsed.maxCount
      continue
    }

    if (token === '-n' || LONG_COUNT_FLAGS.has(token)) {
      const value = args[i + 1]
      if (value === undefined) {
        return {ok: false, message: `Missing commit count after ${token}. ${GIT_LOG_USAGE}`}
      }
      const parsed = parseCountValue(value)
      if (!parsed.ok) return parsed
      maxCount = parsed.maxCount
      i += 1
      continue
    }

    return {ok: false, message: `Unexpected argument '${token}'. ${GIT_LOG_USAGE}`}
  }

  return {ok: true, maxCount}
}

function attachedCount(token: string): string | null {
  const eq = token.indexOf('=')
  if (eq !== -1) {
    const flag = token.slice(0, eq)
    if (flag === '-n' || LONG_COUNT_FLAGS.has(flag)) return token.slice(eq + 1)
    return null
  }
  if (token.startsWith('-n') && token.length > 2) return token.slice(2)
  return null
}

function parseCountValue(raw: string): GitLogCountResult {
  if (!/^\d+$/.test(raw)) {
    return invalidCount(raw)
  }
  const maxCount = Number(raw)
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) {
    return invalidCount(raw)
  }
  return {ok: true, maxCount}
}

function invalidCount(raw: string): GitLogCountResult {
  return {
    ok: false,
    message: `Invalid commit count '${raw}'. Count must be at least 1. ${GIT_LOG_USAGE}`,
  }
}

/**
 * Newest commits first, at most `maxCount`.
 * The result is sliced as well as requested, so a larger log cannot be printed.
 */
export async function loadRecentCommits(repoPath: string, maxCount: number): Promise<GitLogCommitView[]> {
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) {
    throw new Error('Commit count must be at least 1')
  }
  const git = simpleGit(repoPath)
  const log = await git.log({maxCount})
  return log.all.slice(0, maxCount).map((commit) => ({
    shortHash: commit.hash.substring(0, 7),
    authorName: commit.author_name,
    date: commit.date,
    message: commit.message,
  }))
}

export function formatGitLog(agentName: string, commits: readonly GitLogCommitView[]): string {
  if (commits.length === 0) return 'No commits yet.'

  const lines: string[] = [`Recent commits for '${agentName}'`, '']
  for (const commit of commits) {
    lines.push(`commit ${commit.shortHash}`)
    lines.push(`Author: ${commit.authorName}`)
    lines.push(`Date: ${new Date(commit.date).toLocaleString()}`)
    lines.push('')
    lines.push(`    ${commit.message}`)
    lines.push('')
  }
  return lines.join('\n')
}
