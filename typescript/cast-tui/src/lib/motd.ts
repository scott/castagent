import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

/**
 * Decode the CAST_MOTD env var. The deploy writes it base64-encoded
 * so it survives being passed through `docker run -e` without shell
 * escape issues. Plain-text values are accepted as a fallback.
 */
function readEnvMotd(): string | null {
  const raw = process.env.CAST_MOTD
  if (!raw) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Heuristic: if it looks like base64 (only base64 chars and len % 4 == 0),
  // try to decode. Otherwise treat as plain text.
  const base64Like = /^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0
  if (base64Like) {
    try {
      const decoded = Buffer.from(trimmed, 'base64').toString('utf8').trim()
      if (decoded) return decoded
    } catch {
      // fall through to plain-text interpretation
    }
  }
  return trimmed
}

/**
 * Ordered list of MOTD file paths to check.
 * The first file found is used.
 */
function getMotdPaths(): string[] {
  const paths: string[] = []

  // 1. Explicit override via env var
  const envPath = process.env.CAST_MOTD_FILE
  if (envPath) {
    paths.push(envPath)
  }

  // 2. User-local path
  paths.push(path.join(os.homedir(), '.cast', 'motd'))

  // 3. System-wide path
  paths.push('/etc/cast/motd')

  // 4. CWD path
  paths.push(path.join(process.cwd(), 'motd'))

  return paths
}

/**
 * Load the Message of the Day (MOTD).
 *
 * Source priority (highest first):
 *   1. $CAST_MOTD env var (set by `cast deploy`/`cast upgrade`)
 *   2. $CAST_MOTD_FILE env var
 *   3. ~/.cast/motd
 *   4. /etc/cast/motd
 *   5. ./motd
 *
 * Returns the file contents trimmed, or null if no MOTD is found.
 */
export function loadMotd(): string | null {
  const envMotd = readEnvMotd()
  if (envMotd) return envMotd

  for (const filePath of getMotdPaths()) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim()
      if (content) {
        return content
      }
    } catch {
      // File not found or not readable — try next path
    }
  }
  return null
}
