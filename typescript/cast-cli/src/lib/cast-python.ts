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
 * `cast migrate` copies migrate.py, releases.py, and versioning.py into
 * ~/.cast/python. That copy does not include undo.py, so system python3
 * with that directory on sys.path raises ModuleNotFoundError. Prefer the
 * checkout package and the virtualenv created next to it. System python3
 * is only the fallback when that virtualenv has not been created.
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
  // A checkout package that is missing undo.py is still this install.
  // The migrate copy is what made the import fail.
  for (const candidate of candidates.slice(0, 2)) {
    if (fs.existsSync(path.join(candidate, 'cast'))) {
      return candidate
    }
  }
  return candidates[candidates.length - 1]
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
