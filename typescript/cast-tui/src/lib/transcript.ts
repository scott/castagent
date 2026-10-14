import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

function transcriptsDir(): string {
  return path.join(os.homedir(), '.cast', 'transcripts')
}

/**
 * Expand a leading ~ to the current user's home directory.
 * `~name` is left alone so it stays a relative filename.
 */
function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

function generateFilename(agentName: string): string {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `${agentName}-${timestamp}.txt`
}

/**
 * Choose where /save writes a transcript.
 * A relative name is placed under ~/.cast/transcripts.
 * An absolute path, or a path that starts with ~, is used as given.
 *
 * path.join would fold an absolute later segment back into the transcripts
 * directory (`join(dir, '/tmp/a.md')` becomes `dir/tmp/a.md`), so those
 * paths are resolved on their own.
 */
export function resolveTranscriptPath(agentName: string, filename?: string): string {
  const requested = filename ? expandHome(filename) : generateFilename(agentName)
  if (path.isAbsolute(requested)) {
    return path.normalize(requested)
  }
  return path.normalize(path.join(transcriptsDir(), requested))
}

/**
 * Save a conversation transcript as plain text.
 * The default file is `<agent>-<timestamp>.txt` in ~/.cast/transcripts.
 * @param agentName - Name of the agent
 * @param messages - Array of messages with role and text
 * @param filename - Optional path or filename. Relative names stay in ~/.cast/transcripts.
 * @returns Full path to the saved transcript file
 */
export function saveTranscript(
  agentName: string,
  messages: Array<{role: 'user' | 'agent'; text: string}>,
  filename?: string,
): string {
  const filePath = resolveTranscriptPath(agentName, filename)
  fs.mkdirSync(path.dirname(filePath), {recursive: true})

  const timestamp = new Date().toISOString()
  const lines: string[] = [
    `=== Conversation with ${agentName} ===`,
    `Date: ${timestamp}`,
    '',
  ]

  for (const msg of messages) {
    const roleLabel = msg.role === 'user' ? 'User' : 'Agent'
    lines.push(`[${roleLabel}]`)
    lines.push(msg.text)
    lines.push('')
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8')
  return filePath
}
