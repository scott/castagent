import {execFileSync} from 'child_process'
import type {ExecFileSyncOptionsWithStringEncoding} from 'child_process'
import * as os from 'os'
import * as path from 'path'
import {resolveCastPythonRuntime} from './cast-python'

/**
 * Represents version metadata for an agent version.
 */
export interface VersionInfo {
  id: number
  timestamp: string
  source: string
  message: string
}

/**
 * Version text is passed as argv. It is never interpolated into the
 * script or into a shell command.
 */
const VERSIONING_SCRIPT = `
import json, sys
sys.path.insert(0, sys.argv[1])
action = sys.argv[2]
rest = sys.argv[3:]

def arg(index, default=''):
    return rest[index] if index < len(rest) else default

if action == 'create':
    from cast.versioning import create_version
    create_version(arg(0), arg(1, 'cli'), arg(2))
    print('Version created')
elif action == 'revert':
    from cast.versioning import revert_to_version
    raw_version = arg(1)
    version = None if raw_version == '' else int(raw_version)
    result = revert_to_version(arg(0), version, arg(2))
    print(f'Reverted to version {result.id}')
elif action == 'current':
    from cast.versioning import get_current_version
    result = get_current_version(arg(0))
    print(result if result is not None else 'null')
elif action == 'info':
    from cast.versioning import get_version_info
    result = get_version_info(arg(0), int(arg(1, '0')))
    if result is None:
        print('null')
    else:
        print(json.dumps({'id': result.id, 'timestamp': str(result.timestamp), 'source': result.source, 'message': result.message or ''}))
elif action == 'list':
    from cast.versioning import list_versions
    results = list_versions(arg(0))
    print(json.dumps([{'id': v.id, 'timestamp': str(v.timestamp), 'source': v.source, 'message': v.message or ''} for v in results]))
elif action == 'exists':
    from cast.versioning import version_exists
    result = version_exists(arg(0), int(arg(1, '0')))
    print('true' if result else 'false')
else:
    raise SystemExit('unknown versioning action')
`.trim()

type VersioningStdio = 'pipe' | 'inherit'

function runVersioning(action: string, args: string[], stdio: VersioningStdio = 'pipe'): string {
  const runtime = resolveCastPythonRuntime()
  const options: ExecFileSyncOptionsWithStringEncoding = {
    cwd: os.homedir(),
    encoding: 'utf-8',
    env: versioningEnv(runtime.pythonPath),
    stdio: stdio === 'inherit' ? ['pipe', 'inherit', 'inherit'] : ['pipe', 'pipe', 'pipe'],
  }
  const output = execFileSync(runtime.command, ['-c', VERSIONING_SCRIPT, runtime.pythonPath, action, ...args], options)
  return typeof output === 'string' ? output.trim() : ''
}

function versioningEnv(pythonPath: string): NodeJS.ProcessEnv {
  const env = {...process.env}
  env.PYTHONPATH = env.PYTHONPATH
    ? `${pythonPath}${path.delimiter}${env.PYTHONPATH}`
    : pythonPath
  return env
}

/**
 * Create a version of an agent via the Python module.
 */
export async function createVersion(agentName: string, source: string = 'cli', message: string = ''): Promise<void> {
  try {
    runVersioning('create', [agentName, source, message])
  } catch (error: any) {
    // Versioning is best-effort, don't fail the main operation
    // Use a clearer message that includes the Python error (if any).
    const detail = String(
      error?.stderr || error?.stdout || error?.message || error,
    )
    console.error(`Warning: Failed to create version: ${detail}`)
  }
}

/**
 * Revert an agent to a specific version via the Python module.
 */
export async function revertVersion(agentName: string, versionId: number | null, message: string = ''): Promise<void> {
  try {
    const versionArg = versionId === null ? '' : String(versionId)
    runVersioning('revert', [agentName, versionArg, message], 'inherit')
  } catch (error: any) {
    throw new Error(`Revert failed: ${error.message}`)
  }
}

/**
 * Get the current (latest) version number for an agent.
 */
export async function getCurrentVersion(agentName: string): Promise<number> {
  try {
    const output = runVersioning('current', [agentName])
    return output === 'null' ? 0 : parseInt(output, 10)
  } catch {
    return 0
  }
}

/**
 * Get version info for a specific version of an agent.
 */
export async function getVersionInfo(agentName: string, version: number): Promise<VersionInfo | null> {
  try {
    const output = runVersioning('info', [agentName, String(version)])
    return output === 'null' ? null : JSON.parse(output)
  } catch {
    return null
  }
}

/**
 * List all versions of an agent (newest first).
 */
export async function listVersions(agentName: string): Promise<VersionInfo[]> {
  try {
    const output = runVersioning('list', [agentName])
    return JSON.parse(output || '[]')
  } catch {
    return []
  }
}

/**
 * Check if a specific version exists for an agent.
 */
export async function versionExists(agentName: string, version: number): Promise<boolean> {
  try {
    const output = runVersioning('exists', [agentName, String(version)])
    return output === 'true'
  } catch {
    return false
  }
}
