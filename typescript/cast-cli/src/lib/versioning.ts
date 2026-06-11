import {execSync} from 'child_process'
import * as os from 'os'
import * as path from 'path'

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
 * Convert a multi-line Python script to a single-line `-c` argument.
 *
 * Multi-line scripts need newlines replaced with `;` to be passed inline
 * via `python3 -c "..."`. The template literals we pass in always start
 * with a newline, which becomes a leading `;` after substitution — and a
 * leading `;` is a Python `SyntaxError`. We strip that here so every
 * call site doesn't have to remember.
 */
function toSingleLine(script: string): string {
  return script.replace(/\n/g, ';').replace(/^\s*;/, '').trim()
}

/**
 * Run a Python script inline and return the output.
 */
function runPythonScript(script: string): string {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  return execSync(`${pythonCmd} -c "${toSingleLine(script)}"`, {
    cwd: os.homedir(),
    encoding: 'utf-8',
  }).trim()
}

/**
 * Create a version of an agent via the Python module.
 */
export async function createVersion(agentName: string, source: string = 'cli', message: string = ''): Promise<void> {
  try {
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

    const script = `
import sys
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import create_version
create_version('${agentName}', '${source}', '${message.replace(/'/g, "\\'")}')
print('Version created')
`

    execSync(`${pythonCmd} -c "${toSingleLine(script)}"`, {
      cwd: os.homedir(),
    })
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
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

    const versionArg = versionId === null ? 'None' : versionId.toString()

    const script = `
import sys
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import revert_to_version
result = revert_to_version('${agentName}', ${versionArg}, '${message.replace(/'/g, "\\'")}')
print(f'Reverted to version {result.id}')
`

    execSync(`${pythonCmd} -c "${toSingleLine(script)}"`, {
      cwd: os.homedir(),
      stdio: 'inherit',
    })
  } catch (error: any) {
    throw new Error(`Revert failed: ${error.message}`)
  }
}

/**
 * Get the current (latest) version number for an agent.
 */
export async function getCurrentVersion(agentName: string): Promise<number> {
  try {
    const output = runPythonScript(`
import sys
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import get_current_version
result = get_current_version('${agentName}')
print(result if result is not None else 'null')
`)

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
    const output = runPythonScript(`
import sys
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import get_version_info
import json
result = get_version_info('${agentName}', ${version})
if result is None:
    print('null')
else:
    print(json.dumps({'id': result.id, 'timestamp': str(result.timestamp), 'source': result.source, 'message': result.message or ''}))
`)

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
    const output = runPythonScript(`
import sys
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import list_versions
import json
results = list_versions('${agentName}')
print(json.dumps([{'id': v.id, 'timestamp': str(v.timestamp), 'source': v.source, 'message': v.message or ''} for v in results]))
`)

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
    const output = runPythonScript(`
import sys
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import version_exists
result = version_exists('${agentName}', ${version})
print('true' if result else 'false')
`)

    return output === 'true'
  } catch {
    return false
  }
}