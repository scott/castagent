import * as fs from 'fs'
import * as path from 'path'

/**
 * SQLite files MemoryStore writes under an agent's memory directory.
 * Keep this list in sync with the TUI /git init ignore text.
 */
export const MEMORY_DATABASE_IGNORE_LINES = [
  'memory/memory.db',
  'memory/memory.db-journal',
  'memory/memory.db-wal',
  'memory/memory.db-shm',
] as const

export const CAST_IGNORE_LINES = [
  '.cast/versions/',
  'cast.db',
  '*.log',
  '.env',
  '__pycache__/',
  ...MEMORY_DATABASE_IGNORE_LINES,
] as const

export function defaultCastIgnoreContents(): string {
  return `${CAST_IGNORE_LINES.join('\n')}\n`
}

/** Write the default ignore rules to .castignore and .gitignore. */
export function writeDefaultIgnoreFiles(agentPath: string): void {
  const contents = defaultCastIgnoreContents()
  fs.writeFileSync(path.join(agentPath, '.castignore'), contents)
  fs.writeFileSync(path.join(agentPath, '.gitignore'), contents)
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

export function appendMissingIgnoreLines(filePath: string, lines: readonly string[]): boolean {
  const original = fs.readFileSync(filePath, 'utf8')
  const present = new Set(
    original
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#')),
  )
  const missing = lines.filter(line => !present.has(line))
  if (missing.length === 0) return false
  const prefix = original.length > 0 && !original.endsWith('\n') ? '\n' : ''
  fs.appendFileSync(filePath, `${prefix}${missing.join('\n')}\n`)
  return true
}

/**
 * Keep memory/memory.db out of an agent Git repository.
 *
 * Git reads .gitignore. Older cast git init releases wrote the rules only
 * to .castignore, which Git does not read, so the runtime database showed
 * up as untracked. This appends the memory database rules to ignore files
 * that already exist, and creates .gitignore from .castignore when the
 * repo has no .gitignore yet.
 */
export function ensureMemoryDatabaseIgnored(agentPath: string): void {
  if (!fs.existsSync(path.join(agentPath, '.git'))) return

  const castIgnorePath = path.join(agentPath, '.castignore')
  const gitignorePath = path.join(agentPath, '.gitignore')

  if (isFile(castIgnorePath)) {
    appendMissingIgnoreLines(castIgnorePath, MEMORY_DATABASE_IGNORE_LINES)
  }

  if (isFile(gitignorePath)) {
    appendMissingIgnoreLines(gitignorePath, MEMORY_DATABASE_IGNORE_LINES)
    return
  }

  if (isFile(castIgnorePath)) {
    fs.copyFileSync(castIgnorePath, gitignorePath)
    return
  }

  fs.writeFileSync(gitignorePath, `${MEMORY_DATABASE_IGNORE_LINES.join('\n')}\n`)
}
