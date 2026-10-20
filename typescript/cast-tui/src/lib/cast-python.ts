import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Directory that contains the `cast` Python package (the parent of `cast/`).
 *
 * Resolution order: this checkout (dist or src layout), a shallower
 * checkout layout, then `~/.cast/python`. Prefer the checkout. That home
 * directory can still hold a partial copy from `cast migrate` in 2.5.1
 * or earlier, or an older `sessions.py`. After the sessions table gained
 * `topic`, an older `SessionMeta.from_db_row` crashes with an unexpected
 * keyword argument and `cast connect` prints the traceback over the chat.
 *
 * Keep this in step with typescript/cast-cli/src/lib/cast-python.ts.
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
