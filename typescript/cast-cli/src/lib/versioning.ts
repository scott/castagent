import {execSync} from 'child_process'
import * as os from 'os'
import * as path from 'path'

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

    execSync(`${pythonCmd} -c "${script.replace(/\n/g, ';')}"`, {
      cwd: os.homedir(),
      stdio: 'ignore',
    })
  } catch (error) {
    // Versioning is best-effort, don't fail the main operation
    console.error('Warning: Failed to create version:', error)
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

    execSync(`${pythonCmd} -c "${script.replace(/\n/g, ';')}"`, {
      cwd: os.homedir(),
      stdio: 'inherit',
    })
  } catch (error: any) {
    throw new Error(`Revert failed: ${error.message}`)
  }
}