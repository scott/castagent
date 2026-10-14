import {execFileSync} from 'child_process'
import type {ExecFileSyncOptionsWithStringEncoding} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import {db} from './sqlite'
import {resolveCastPythonRuntime, type CastPythonRuntime} from './cast-python'

export interface ReleaseInfo {
  version: string
  change_number: number
  message: string
  changelog: string
  created_at: string
  tarball_path: string
}

type PythonExec = (
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
) => string

function defaultExec(
  command: string,
  args: string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string {
  return execFileSync(command, args, options)
}

let execPython: PythonExec = defaultExec
let runtimeOverride: CastPythonRuntime | null = null

/**
 * Test hooks. Node exposes `execFileSync` as a non-configurable binding,
 * so tests replace this wrapper instead of patching `child_process`.
 */
export function _setExecPythonForTests(impl: PythonExec | null): void {
  execPython = impl ?? defaultExec
}

export function _setPythonRuntimeForTests(runtime: CastPythonRuntime | null): void {
  runtimeOverride = runtime
}

/**
 * Interpreter and package directory for cast.releases.
 *
 * Prefer the checkout virtualenv (python/.venv). System python3 often has
 * no PyYAML, and create_release needs it to bump agent.yaml. System
 * python3 is only the fallback when that virtualenv has not been created.
 * The package directory stays on this checkout so a stale ~/.cast/python
 * copy is not the one that writes the release.
 */
function currentRuntime(): CastPythonRuntime {
  return runtimeOverride ?? resolveCastPythonRuntime()
}

function pythonPrelude(): string {
  return `import sys\nsys.path.insert(0, ${JSON.stringify(currentRuntime().pythonPath)})\n`
}

function pythonEnv(pythonPath: string): NodeJS.ProcessEnv {
  const env = {...process.env}
  env.PYTHONPATH = env.PYTHONPATH
    ? `${pythonPath}${path.delimiter}${env.PYTHONPATH}`
    : pythonPath
  return env
}

function pythonFailureMessage(error: unknown): string {
  const err = error as {message?: unknown}
  const lines = stderrText(error).split('\n').map((line) => line.trim()).filter(Boolean)
  const exception = [...lines].reverse().find((line) => /(?:Error|Exception):/.test(line))
  if (exception) return exception
  if (lines.length > 0) return lines[lines.length - 1]
  const message = String(err?.message ?? error ?? '').trim()
  return message || 'Python failed'
}

function recordReleaseIfAbsent(agentName: string, release: ReleaseInfo): void {
  // Python create_release is the writer. This only fills a row when that
  // module is an older copy, and it does not replace a stored row.
  if (db.getRelease(agentName, release.version)) return
  db.createRelease(
    agentName,
    release.version,
    release.change_number,
    release.message || '',
    release.changelog || '',
    release.tarball_path || '',
  )
}

function stderrText(error: unknown): string {
  const stderr = (error as {stderr?: unknown}).stderr
  if (typeof stderr === 'string') return stderr
  if (Buffer.isBuffer(stderr)) return stderr.toString('utf8')
  return ''
}

function pythonValueError(error: unknown): string | null {
  // create_release raises ValueError for a backwards version. Surface
  // that sentence instead of the traceback from the temp script.
  const line = stderrText(error)
    .split('\n')
    .map(part => part.trim())
    .reverse()
    .find(part => part.startsWith('ValueError:'))
  if (!line) return null
  const message = line.slice('ValueError:'.length).trim()
  return message || null
}

function runPythonScript(script: string, _captureStderr = false): string {
  const runtime = currentRuntime()
  // Write script to temp file to avoid quoting issues
  const scriptHash = crypto.randomBytes(8).toString('hex')
  const tempDir = os.tmpdir()
  const tempScript = path.join(tempDir, `cast_script_${scriptHash}.py`)

  try {
    fs.writeFileSync(tempScript, script)
    const result = execPython(runtime.command, [tempScript], {
      cwd: os.homedir(),
      encoding: 'utf-8',
      // Capture stderr so a rejected release can show the ValueError
      // sentence instead of painting the traceback on the terminal.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pythonEnv(runtime.pythonPath),
    }).trim()
    return result
  } catch (error: unknown) {
    const valueError = pythonValueError(error)
    if (valueError) throw new Error(valueError)
    throw new Error(pythonFailureMessage(error))
  } finally {
    try {
      fs.unlinkSync(tempScript)
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function createRelease(agentName: string, version: string, message: string = ''): Promise<ReleaseInfo> {
  let output: string
  try {
    output = runPythonScript(`
${pythonPrelude()}from cast.releases import create_release
import json
result = create_release('${agentName}', '${version}', '${message.replace(/'/g, "\\'")}')
print(json.dumps({
  'version': result.version,
  'change_number': result.change_number,
  'message': result.message,
  'changelog': result.changelog,
  'created_at': result.created_at,
  'tarball_path': str(result.tarball_path)
}))
`, true)
  } catch (error) {
    const message = pythonValueError(error)
    if (message) throw new Error(message)
    throw error
  }
  const release = JSON.parse(output) as ReleaseInfo
  recordReleaseIfAbsent(agentName, release)
  return release
}

export async function listReleases(agentName: string): Promise<ReleaseInfo[]> {
  try {
    const output = runPythonScript(`
${pythonPrelude()}from cast.releases import list_releases
import json
results = list_releases('${agentName}')
print(json.dumps([{
  'version': r.version,
  'change_number': r.change_number,
  'message': r.message,
  'changelog': r.changelog,
  'created_at': r.created_at,
  'tarball_path': str(r.tarball_path)
} for r in results]))
`)
    return JSON.parse(output || '[]')
  } catch {
    return []
  }
}

export async function getRelease(agentName: string, version: string): Promise<ReleaseInfo | null> {
  try {
    const output = runPythonScript(`
${pythonPrelude()}from cast.releases import get_release
import json
result = get_release('${agentName}', '${version}')
if result is None:
    print('null')
else:
    print(json.dumps({
      'version': result.version,
      'change_number': result.change_number,
      'message': result.message,
      'changelog': result.changelog,
      'created_at': result.created_at,
      'tarball_path': str(result.tarball_path)
    }))
`)
    return output === 'null' ? null : JSON.parse(output)
  } catch {
    return null
  }
}

export async function getCurrentRelease(agentName: string): Promise<string | null> {
  try {
    const output = runPythonScript(`
${pythonPrelude()}from cast.releases import get_current_release
result = get_current_release('${agentName}')
print(result if result is not None else 'null')
`)
    return output === 'null' ? null : output
  } catch {
    return null
  }
}

export async function suggestVersion(agentName: string): Promise<{patch: string; minor: string; major: string; breaking?: boolean}> {
  try {
    const output = runPythonScript(`
${pythonPrelude()}from cast.releases import suggest_version
import json
result = suggest_version('${agentName}')
print(json.dumps(result))
`)
    return JSON.parse(output)
  } catch {
    return {patch: '0.1.0', minor: '0.1.0', major: '1.0.0'}
  }
}

export async function validateSemver(version: string): Promise<boolean> {
  try {
    const output = runPythonScript(`
${pythonPrelude()}from cast.releases import validate_semver
result = validate_semver('${version}')
print('true' if result else 'false')
`)
    return output === 'true'
  } catch {
    return false
  }
}

export async function extractRelease(agentName: string, version: string, targetDir: string): Promise<void> {
  // Python extract_release writes the snapshot over targetDir and removes
  // project files that are not in it. .castignore paths, .cast/, and .git/ stay.
  try {
    runPythonScript(`
${pythonPrelude()}from cast.releases import extract_release
from pathlib import Path
extract_release(${JSON.stringify(agentName)}, ${JSON.stringify(version)}, Path(${JSON.stringify(targetDir)}))
`)
  } catch (error: unknown) {
    const err = error as {stderr?: Buffer | string; message?: string}
    const stderr = Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : String(err.stderr || '')
    const line = stderr.trim().split('\n').filter(Boolean).pop()
    throw new Error(line || err.message || `Failed to extract release ${version}`)
  }
}