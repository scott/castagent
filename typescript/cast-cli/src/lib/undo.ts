import {execFileSync} from 'child_process'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'

/**
 * One entry in the change log (used by undo/redo).
 */
export interface ChangeRecord {
  id: number
  timestamp: string
  source: string
  message: string
}

/**
 * Run a Python script as a temp file and return the trimmed stdout.
 * Mirrors the pattern in lib/releases.ts.
 */
function runPython(script: string): string {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  const tmp = path.join(
    os.tmpdir(),
    `cast_undo_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.py`,
  )
  try {
    require('fs').writeFileSync(tmp, script)
    return execFileSync(pythonCmd, [tmp], {
      cwd: os.homedir(),
      encoding: 'utf-8',
    }).trim()
  } finally {
    try {
      require('fs').unlinkSync(tmp)
    } catch {
      // ignore
    }
  }
}

function pythonPath(): string {
  return path.join(os.homedir(), '.cast', 'python')
}

function header(): string {
  return `import sys\nsys.path.insert(0, '${pythonPath()}')\nfrom cast.undo import *\n`
}

function escape(s: string): string {
  return s.replace(/'/g, "\\'")
}

/**
 * Return true if the agent has at least one change to undo.
 */
export async function canUndo(agentName: string): Promise<boolean> {
  try {
    const out = runPython(`
${header()}
print('true' if can_undo('${escape(agentName)}') else 'false')
`)
    return out === 'true'
  } catch {
    return false
  }
}

/**
 * Return true if the agent has a non-empty redo stack.
 */
export async function canRedo(agentName: string): Promise<boolean> {
  try {
    const out = runPython(`
${header()}
print('true' if can_redo('${escape(agentName)}') else 'false')
`)
    return out === 'true'
  } catch {
    return false
  }
}

/**
 * Undo the last `steps` changes for an agent. Returns the list of
 * undone entries, newest first.
 */
export async function undo(agentName: string, steps: number = 1, message?: string): Promise<ChangeRecord[]> {
  const msgArg = message ? `, message='${escape(message)}'` : ''
  try {
    const out = runPython(`
${header()}
import json
result = undo('${escape(agentName)}', steps=${steps}${msgArg})
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
    return JSON.parse(out || '[]')
  } catch (error: any) {
    throw new Error(`Undo failed: ${error.message || error}`)
  }
}

/**
 * Redo the last `steps` previously-undone changes.
 */
export async function redo(agentName: string, steps: number = 1, message?: string): Promise<ChangeRecord[]> {
  const msgArg = message ? `, message='${escape(message)}'` : ''
  try {
    const out = runPython(`
${header()}
import json
result = redo('${escape(agentName)}', steps=${steps}${msgArg})
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
    return JSON.parse(out || '[]')
  } catch (error: any) {
    throw new Error(`Redo failed: ${error.message || error}`)
  }
}

/**
 * Return the agent's change log (newest first).
 */
export async function getUndoHistory(agentName: string): Promise<ChangeRecord[]> {
  try {
    const out = runPython(`
${header()}
import json
result = get_undo_history('${escape(agentName)}')
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
    return JSON.parse(out || '[]')
  } catch {
    return []
  }
}

/**
 * Return the agent's redo stack (oldest first).
 */
export async function getRedoStack(agentName: string): Promise<ChangeRecord[]> {
  try {
    const out = runPython(`
${header()}
import json
result = get_redo_stack('${escape(agentName)}')
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
    return JSON.parse(out || '[]')
  } catch {
    return []
  }
}
