/**
 * Parse the tokens that follow `/git commit`.
 *
 * The TUI splits slash input on spaces, so `/git commit -m tui-commit`
 * arrives as ['-m', 'tui-commit']. `-m` and `--message` are flags, and
 * the text after the flag is the commit message. A matching quote pair
 * around that text is removed, which is how
 * `/git commit -m "Switched to Claude 3.7"` is written in the docs.
 *
 * With no flag and no text, message is empty and the caller builds a
 * summary. A flag with no text is an error, so `-m` is never stored as
 * the commit message.
 */

export const GIT_COMMIT_FLAG_USAGE = [
  'Usage: /git commit [-m] <msg>',
  '',
  '-m is the message flag. Example: /git commit -m "Switched to Claude 3.7"',
].join('\n')

export interface GitCommitArgs {
  /** Text to commit. Empty when the user omitted a message. */
  message: string
  /** Set when -m or --message was given without any message text. */
  error?: string
}

export function parseGitCommitArgs(args: readonly string[]): GitCommitArgs {
  const tokens = [...args]
  let flagged = false

  if (tokens[0] === '-m' || tokens[0] === '--message') {
    flagged = true
    tokens.shift()
  } else if (tokens[0]?.startsWith('--message=')) {
    flagged = true
    tokens[0] = tokens[0].slice('--message='.length)
  }

  const message = stripWrappingQuotes(tokens.join(' '))
  if (flagged && message.length === 0) {
    return {message: '', error: GIT_COMMIT_FLAG_USAGE}
  }
  return {message}
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const open = trimmed[0]
    const close = trimmed[trimmed.length - 1]
    if ((open === '"' || open === "'") && close === open) {
      return trimmed.slice(1, -1).trim()
    }
  }
  return trimmed
}
