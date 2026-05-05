import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

const TRANSCRIPTS_DIR = path.join(os.homedir(), '.cast', 'transcripts')

function ensureTranscriptsDir(): void {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    fs.mkdirSync(TRANSCRIPTS_DIR, {recursive: true})
  }
}

function generateFilename(agentName: string): string {
  const now = new Date()
  const pad = (n: number) => n.toString().padStart(2, '0')
  const timestamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return `${agentName}-${timestamp}.txt`
}

/**
 * Save a conversation transcript to ~/.cast/transcripts/
 * @param agentName - Name of the agent
 * @param messages - Array of messages with role and text
 * @param filename - Optional custom filename (defaults to auto-generated)
 * @returns Full path to the saved transcript file
 */
export function saveTranscript(
  agentName: string,
  messages: Array<{role: 'user' | 'agent'; text: string}>,
  filename?: string,
): string {
  ensureTranscriptsDir()

  const finalFilename = filename || generateFilename(agentName)
  const filePath = path.join(TRANSCRIPTS_DIR, finalFilename)

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
