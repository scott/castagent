import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

/**
 * Directory that contains the `cast` Python package (the parent of `cast/`).
 *
 * Resolution order:
 * 1. This checkout (`<repo>/python`), from either the dist or src layout.
 * 2. A shallower checkout layout.
 * 3. `~/.cast/python`.
 *
 * Prefer the checkout. `~/.cast/python` can still hold a partial copy
 * written by `cast migrate` in 2.5.1 or earlier. That copy has no
 * `sessions.py` from this tree. After the sessions table gained `topic`,
 * an older `SessionMeta.from_db_row` crashes with an unexpected keyword
 * argument and `cast connect` prints the traceback over the chat.
 *
 * Keep the sessions lookup in step with
 * typescript/cast-tui/src/lib/cast-python.ts.
 */
export function resolveCastPythonPath(moduleDir: string = __dirname, homeDir?: string): string {
  const candidates = pythonPackageCandidates(moduleDir, homeDir)
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'cast', 'sessions.py'))) {
      return candidate
    }
  }
  return candidates[candidates.length - 1]
}

/**
 * Interpreter and package directory for modules that ship in this
 * checkout, such as `cast.undo`.
 *
 * Same directory order as `resolveCastPythonPath`. The virtualenv
 * created next to the chosen package is preferred. System python3 is
 * only the fallback when that virtualenv has not been created.
 *
 * A partial `~/.cast/python` from `cast migrate` in 2.5.1 or earlier
 * does not include `undo.py`. Putting that directory on `sys.path`
 * raises `ModuleNotFoundError`. A checkout `cast` package is still
 * this install when `undo.py` is missing, so it wins over that copy.
 */
export interface CastPythonRuntime {
  command: string
  pythonPath: string
}

export function resolveCastPythonRuntime(moduleDir: string = __dirname, homeDir?: string): CastPythonRuntime {
  const pythonPath = resolveUndoPackageDir(moduleDir, homeDir)
  return {
    command: resolveVenvPython(pythonPath),
    pythonPath,
  }
}

function pythonPackageCandidates(moduleDir: string, homeDir?: string): string[] {
  const home = homeDir ?? os.homedir()
  return [
    path.resolve(moduleDir, '../../../../python'),
    path.resolve(moduleDir, '../../../python'),
    path.join(home, '.cast', 'python'),
  ]
}

function resolveUndoPackageDir(moduleDir: string, homeDir?: string): string {
  const candidates = pythonPackageCandidates(moduleDir, homeDir)
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'cast', 'undo.py'))) {
      return candidate
    }
  }
  // Minimal guard for a stale ~/.cast/python. See resolveCastPythonRuntime.
  const checkout = candidates.slice(0, 2).find((candidate) =>
    fs.existsSync(path.join(candidate, 'cast')))
  return checkout ?? candidates[candidates.length - 1]
}

function resolveVenvPython(pythonPath: string): string {
  const binDir = process.platform === 'win32'
    ? path.join(pythonPath, '.venv', 'Scripts')
    : path.join(pythonPath, '.venv', 'bin')
  const names = process.platform === 'win32' ? ['python.exe'] : ['python3', 'python']
  for (const name of names) {
    const candidate = path.join(binDir, name)
    if (fs.existsSync(candidate)) return candidate
  }
  return process.platform === 'win32' ? 'python' : 'python3'
}
