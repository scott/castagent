import * as childProcess from 'child_process'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {resolveCastPythonRuntime} from './cast-python'

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
 * Run a Python script with Cast's interpreter and package tree.
 *
 * stderr is captured. The default execFileSync behavior copies a
 * traceback onto the terminal before the caller can turn the failure
 * into an error, which is how /undo painted over the TUI input line.
 */
function runPython(body: string): string {
  const runtime = resolveCastPythonRuntime()
  const script = `${header(runtime.pythonPath)}\n${body}`
  const tmp = path.join(
    os.tmpdir(),
    `cast_undo_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.py`,
  )
  try {
    fs.writeFileSync(tmp, script)
    return childProcess.execFileSync(runtime.command, [tmp], {
      cwd: os.homedir(),
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: pythonEnv(runtime.pythonPath),
    }).trim()
  } catch (error: unknown) {
    throw new Error(pythonFailureMessage(error))
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore
    }
  }
}

function pythonEnv(pythonPath: string): NodeJS.ProcessEnv {
  const env = {...process.env}
  env.PYTHONPATH = env.PYTHONPATH
    ? `${pythonPath}${path.delimiter}${env.PYTHONPATH}`
    : pythonPath
  return env
}

function header(pythonPath: string): string {
  return `import sys\nsys.path.insert(0, ${JSON.stringify(pythonPath)})\nfrom cast.undo import *\n`
}

function pythonFailureMessage(error: unknown): string {
  const err = error as {stderr?: unknown; message?: unknown}
  const stderr = Buffer.isBuffer(err?.stderr)
    ? err.stderr.toString('utf8')
    : typeof err?.stderr === 'string'
      ? err.stderr
      : ''
  const lines = stderr.split('\n').map((line) => line.trim()).filter(Boolean)
  const exception = [...lines].reverse().find((line) => /(?:Error|Exception):/.test(line))
  if (exception) return exception
  if (lines.length > 0) return lines[lines.length - 1]
  const message = String(err?.message ?? error ?? '').trim()
  return message || 'Python failed'
}

function escape(s: string): string {
  return s.replace(/'/g, "\\'")
}

function parseFlag(out: string, which: string): boolean {
  if (out === 'true') return true
  if (out === 'false') return false
  throw new Error(`Unexpected ${which} check output: ${out}`)
}

function recordsFromJson(out: string): ChangeRecord[] {
  return JSON.parse(out || '[]')
}

/**
 * Return true if the agent has at least one change to undo.
 * Python failures propagate. They are not reported as an empty log.
 */
export async function canUndo(agentName: string): Promise<boolean> {
  const out = runPython(`print('true' if can_undo('${escape(agentName)}') else 'false')`)
  return parseFlag(out, 'undo')
}

/**
 * Return true if the agent has a non-empty redo stack.
 * Python failures propagate. They are not reported as an empty stack.
 */
export async function canRedo(agentName: string): Promise<boolean> {
  const out = runPython(`print('true' if can_redo('${escape(agentName)}') else 'false')`)
  return parseFlag(out, 'redo')
}

/**
 * Undo the last `steps` changes for an agent. Returns the list of
 * undone entries, newest first.
 */
export async function undo(agentName: string, steps: number = 1, message?: string): Promise<ChangeRecord[]> {
  const msgArg = message ? `, message='${escape(message)}'` : ''
  try {
    const out = runPython(`
import json
result = undo('${escape(agentName)}', steps=${steps}${msgArg})
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
    return recordsFromJson(out)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Undo failed: ${detail}`)
  }
}

/**
 * Redo the last `steps` previously-undone changes.
 */
export async function redo(agentName: string, steps: number = 1, message?: string): Promise<ChangeRecord[]> {
  const msgArg = message ? `, message='${escape(message)}'` : ''
  try {
    const out = runPython(`
import json
result = redo('${escape(agentName)}', steps=${steps}${msgArg})
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
    return recordsFromJson(out)
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`Redo failed: ${detail}`)
  }
}

/**
 * Return the agent's change log (newest first).
 */
export async function getUndoHistory(agentName: string): Promise<ChangeRecord[]> {
  const out = runPython(`
import json
result = get_undo_history('${escape(agentName)}')
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
  return recordsFromJson(out)
}

/**
 * Return the agent's redo stack (oldest first).
 */
export async function getRedoStack(agentName: string): Promise<ChangeRecord[]> {
  const out = runPython(`
import json
result = get_redo_stack('${escape(agentName)}')
print(json.dumps([{'id': r.id, 'timestamp': str(r.timestamp), 'source': r.source, 'message': r.message} for r in result]))
`)
  return recordsFromJson(out)
}
