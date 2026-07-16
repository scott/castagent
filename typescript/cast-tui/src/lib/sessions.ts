import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {getDb, type DbApi} from './db.js'

/**
 * Lightweight session metadata. Mirrors the shape of the SQLite `sessions`
 * row.
 */
export interface SessionMeta {
  id: string
  name: string | null
  agent_name: string
  mode: string | null
  ui_mode: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  message_count: number
  parent_session_id: string | null
  first_user_message: string | null
  last_user_message: string | null
  json_path: string
}

/**
 * Full session, including the message transcript.
 */
export interface SessionMessage {
  role: 'user' | 'agent'
  text: string
  ts: string
  ui_action?: Record<string, unknown> | null
}

export interface Session {
  id: string
  name: string | null
  agent_name: string
  agent_version_at_start: string | null
  created_at: string
  updated_at: string
  ended_at: string | null
  mode: string
  ui_mode: string
  messages: SessionMessage[]
  files_in_context: string[]
  parent_session_id: string | null
  tags: string[]
}

/**
 * Run a Python script and return trimmed stdout. We shell out to the cast-cli
 * Python wrapper, which already knows how to find cast.sessions.
 */
function runPython(script: string): string {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  const tmp = path.join(
    os.tmpdir(),
    `cast_session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
  )
  try {
    fs.writeFileSync(tmp, script)
    return execFileSync(pythonCmd, [tmp], {
      cwd: os.homedir(),
      encoding: 'utf-8',
    }).trim()
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // ignore
    }
  }
}

function pythonPath(): string {
  return path.join(os.homedir(), '.cast', 'python')
}

function toJson(value: any): string {
  return JSON.stringify(value).replace(/'/g, "\\'")
}

/**
 * Read the metadata index via the local DB so the TUI can list sessions
 * without shelling out to Python. Falls back to an empty list if the DB
 * isn't reachable.
 */
export async function listSessions(agentName?: string, limit: number = 50, includeEnded: boolean = true): Promise<SessionMeta[]> {
  const db = (await getDb()) as DbApi | null
  if (!db) return []
  return db.listSessions(agentName, limit, includeEnded) as SessionMeta[]
}

/**
 * Read the full session (including transcript) by shelling out to Python.
 * Used by `/session resume` to load the message history into the chat.
 */
export async function getSession(identifier: string): Promise<Session | null> {
  try {
    const out = runPython(`
import sys
sys.path.insert(0, '${pythonPath()}')
from cast.sessions import SessionStore
store = SessionStore()
sess = store.get('${identifier.replace(/'/g, "\\'")}')
import json
if sess is None:
    print('null')
else:
    print(json.dumps(sess.to_json()))
`)
    return out === 'null' ? null : JSON.parse(out)
  } catch {
    return null
  }
}

/**
 * Create a new session via the Python wrapper. Used on first message in the
 * chat screen when no session has been created yet.
 */
export async function createSession(opts: {
  agentName: string
  mode?: string
  uiMode?: string
  name?: string | null
  agentVersionAtStart?: string | null
}): Promise<Session> {
  const script = `
import sys
sys.path.insert(0, '${pythonPath()}')
from cast.sessions import SessionStore
store = SessionStore()
sess = store.create(
    agent_name='${opts.agentName.replace(/'/g, "\\'")}',
    mode='${opts.mode ?? 'build'}',
    ui_mode='${opts.uiMode ?? 'dev'}',
    name=${opts.name ? `'${opts.name.replace(/'/g, "\\'")}'` : 'None'},
    agent_version_at_start=${opts.agentVersionAtStart ? `'${opts.agentVersionAtStart}'` : 'None'},
)
import json
print(json.dumps(sess.to_json()))
`
  return JSON.parse(runPython(script))
}

/**
 * Append a message to an active session. Called on every chat turn.
 * Failures are non-fatal: the chat should still work if sessions break.
 */
export async function appendMessage(
  sessionId: string,
  role: 'user' | 'agent',
  text: string,
  uiAction?: Record<string, unknown> | null,
): Promise<void> {
  try {
    runPython(`
import sys
sys.path.insert(0, '${pythonPath()}')
from cast.sessions import SessionStore
store = SessionStore()
store.append_message(
    session_id='${sessionId}',
    role='${role}',
    text=${toJson(text)},
    ui_action=${uiAction ? toJson(uiAction) : 'None'},
)
`)
  } catch {
    // Best-effort: a failed session append must not break the chat.
  }
}

/**
 * Mark a session as ended. Called when the user quits the TUI or starts
 * a new session.
 */
export async function endSession(sessionId: string): Promise<void> {
  try {
    runPython(`
import sys
sys.path.insert(0, '${pythonPath()}')
from cast.sessions import SessionStore
store = SessionStore()
store.end('${sessionId}')
`)
  } catch {
    // ignore
  }
}

/**
 * Rename a session by id.
 */
export async function renameSession(identifier: string, name: string): Promise<Session> {
  const out = runPython(`
import sys
sys.path.insert(0, '${pythonPath()}')
from cast.sessions import SessionStore
store = SessionStore()
sess = store.rename('${identifier.replace(/'/g, "\\'")}', '${name.replace(/'/g, "\\'")}')
import json
print(json.dumps(sess.to_json()))
`)
  return JSON.parse(out)
}

/**
 * Fork a session.
 */
export async function forkSession(identifier: string, name?: string | null): Promise<Session> {
  const out = runPython(`
import sys
sys.path.insert(0, '${pythonPath()}')
from cast.sessions import SessionStore
store = SessionStore()
sess = store.fork('${identifier.replace(/'/g, "\\'")}', name=${name ? `'${name.replace(/'/g, "\\'")}'` : 'None'})
import json
print(json.dumps(sess.to_json()))
`)
  return JSON.parse(out)
}

/**
 * Delete a session.
 */
export async function deleteSession(identifier: string): Promise<void> {
  try {
    runPython(`
import sys
sys.path.insert(0, '${pythonPath()}')
from cast.sessions import SessionStore
store = SessionStore()
store.delete('${identifier.replace(/'/g, "\\'")}')
`)
  } catch {
    // ignore
  }
}
