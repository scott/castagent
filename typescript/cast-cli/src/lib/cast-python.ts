import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Directory that contains the `cast` Python package (the parent of `cast/`).
 *
 * Prefer this checkout. `~/.cast/python` is a one-time copy from an older
 * install. After the sessions table gained `topic`, that copy's
 * `SessionMeta.from_db_row` crashes with an unexpected keyword argument
 * and `cast connect` prints the traceback over the chat.
 */
export function resolveCastPythonPath(moduleDir: string = __dirname, homeDir?: string): string {
  const home = homeDir ?? os.homedir()
  const candidates = [
    path.resolve(moduleDir, '../../../../python'),
    path.resolve(moduleDir, '../../../python'),
    path.join(home, '.cast', 'python'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'cast', 'sessions.py'))) {
      return candidate
    }
  }
  return path.join(home, '.cast', 'python')
}
