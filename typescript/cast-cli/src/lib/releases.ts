import {execSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import {db} from './sqlite'

export interface ReleaseInfo {
  version: string
  change_number: number
  message: string
  changelog: string
  created_at: string
  tarball_path: string
}

function castPythonPath(): string {
  // Prefer this checkout so /release and `cast release` do not keep calling
  // a stale copy under ~/.cast/python that never writes SQLite.
  const candidates = [
    path.resolve(__dirname, '../../../../python'),
    path.resolve(__dirname, '../../../python'),
    path.join(os.homedir(), '.cast', 'python'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'cast', 'releases.py'))) {
      return candidate
    }
  }
  return path.join(os.homedir(), '.cast', 'python')
}

function pythonPrelude(): string {
  return `import sys\nsys.path.insert(0, ${JSON.stringify(castPythonPath())})\n`
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

function runPythonScript(script: string): string {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  // Write script to temp file to avoid quoting issues
  const scriptHash = crypto.randomBytes(8).toString('hex')
  const tempDir = os.tmpdir()
  const tempScript = path.join(tempDir, `cast_script_${scriptHash}.py`)

  try {
    fs.writeFileSync(tempScript, script)
    const result = execSync(`${pythonCmd} "${tempScript}"`, {
      cwd: os.homedir(),
      encoding: 'utf-8',
    }).trim()
    return result
  } finally {
    try {
      fs.unlinkSync(tempScript)
    } catch {
      // Ignore cleanup errors
    }
  }
}

export async function createRelease(agentName: string, version: string, message: string = ''): Promise<ReleaseInfo> {
  const output = runPythonScript(`
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
`)
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
  const tar = await import('tar')
  const release = await getRelease(agentName, version)
  if (!release) {
    throw new Error(`Release ${version} not found for agent '${agentName}'`)
  }

  if (!fs.existsSync(release.tarball_path)) {
    throw new Error(`Release tarball not found: ${release.tarball_path}`)
  }

  // Clear agent files first (keep .cast and .git directories)
  const agentFiles = fs.readdirSync(targetDir).filter(f =>
    !f.startsWith('.cast') && !f.startsWith('.git')
  )
  for (const file of agentFiles) {
    const filePath = path.join(targetDir, file)
    if (fs.statSync(filePath).isDirectory()) {
      fs.rmSync(filePath, {recursive: true})
    } else {
      fs.unlinkSync(filePath)
    }
  }

  // Extract release tarball
  await tar.extract({file: release.tarball_path, cwd: targetDir})
}