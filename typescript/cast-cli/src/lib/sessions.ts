import {execFileSync} from 'child_process'
import * as os from 'os'
import * as path from 'path'

/**
 * Metadata for a session, as stored in the SQLite index.
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
  topic?: string | null
  topic_message_count?: number | null
  json_path: string
}

/**
 * One transcript message inside a session.
 */
export interface SessionMessage {
  role: 'user' | 'agent'
  text: string
  ts: string
  ui_action?: Record<string, unknown> | null
}

/**
 * Full session content, as stored in the JSON file.
 */
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
  topic?: string | null
  topic_message_count?: number | null
}

/**
 * Run a Python script as a temp file and return the trimmed stdout.
 * Mirrors the pattern in lib/releases.ts so we don't fight shell quoting.
 */
function runPython(script: string): string {
  const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
  const tmp = path.join(os.tmpdir(), `cast_sessions_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
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
      // Ignore cleanup errors
    }
  }
}

function pythonPath(): string {
  return path.join(os.homedir(), '.cast', 'python')
}

function header(): string {
  return `import sys\nsys.path.insert(0, '${pythonPath()}')\nfrom cast.sessions import SessionStore\n`
}

function toJson(value: any): string {
  return JSON.stringify(value).replace(/'/g, "\\'")
}

/**
 * Create a new session and return the full Session object.
 */
export async function createSession(opts: {
  agentName: string
  mode?: string
  uiMode?: string
  parentSessionId?: string | null
  name?: string | null
  agentVersionAtStart?: string | null
}): Promise<Session> {
  const script = `
${header()}
store = SessionStore()
sess = store.create(
    agent_name='${opts.agentName.replace(/'/g, "\\'")}',
    mode='${opts.mode ?? 'build'}',
    ui_mode='${opts.uiMode ?? 'dev'}',
    parent_session_id=${opts.parentSessionId ? `'${opts.parentSessionId}'` : 'None'},
    name=${opts.name ? `'${opts.name.replace(/'/g, "\\'")}'` : 'None'},
    agent_version_at_start=${opts.agentVersionAtStart ? `'${opts.agentVersionAtStart}'` : 'None'},
)
import json
print(json.dumps(sess.to_json()))
`
  return JSON.parse(runPython(script))
}

/**
 * Append a message to a session and return the updated Session.
 */
export async function appendMessage(opts: {
  sessionId: string
  role: 'user' | 'agent'
  text: string
  uiAction?: Record<string, unknown> | null
}): Promise<Session> {
  const script = `
${header()}
store = SessionStore()
store.append_message(
    session_id='${opts.sessionId}',
    role='${opts.role}',
    text=${toJson(opts.text)},
    ui_action=${opts.uiAction ? toJson(opts.uiAction) : 'None'},
)
sess = store.get('${opts.sessionId}')
import json
print(json.dumps(sess.to_json() if sess else {}))
`
  return JSON.parse(runPython(script))
}

/**
 * Look up a session by id or by name.
 */
export async function getSession(identifier: string): Promise<Session | null> {
  const script = `
${header()}
store = SessionStore()
sess = store.get('${identifier.replace(/'/g, "\\'")}')
import json
if sess is None:
    print('null')
else:
    print(json.dumps(sess.to_json()))
`
  const out = runPython(script)
  return out === 'null' ? null : JSON.parse(out)
}

/**
 * Look up just the metadata for a session.
 */
export async function getSessionMeta(identifier: string): Promise<SessionMeta | null> {
  const script = `
${header()}
from cast.sessions import SessionStore
store = SessionStore()
meta = store._resolve_meta('${identifier.replace(/'/g, "\\'")}')
import json
if meta is None:
    print('null')
else:
    print(json.dumps(meta.to_db_row()))
`
  const out = runPython(script)
  return out === 'null' ? null : JSON.parse(out)
}

/**
 * List sessions, most-recent first.
 */
export async function listSessions(opts: {
  agentName?: string
  limit?: number
  includeEnded?: boolean
} = {}): Promise<SessionMeta[]> {
  const args = [
    opts.agentName ? `agent_name='${opts.agentName.replace(/'/g, "\\'")}'` : null,
    `limit=${opts.limit ?? 50}`,
    `include_ended=${opts.includeEnded === false ? 'False' : 'True'}`,
  ].filter(Boolean)
  const script = `
${header()}
store = SessionStore()
metas = store.list(${args.join(', ')})
import json
print(json.dumps([m.to_db_row() for m in metas]))
`
  return JSON.parse(runPython(script) || '[]')
}

/**
 * Rename a session.
 */
export async function renameSession(identifier: string, name: string): Promise<Session> {
  const script = `
${header()}
store = SessionStore()
sess = store.rename('${identifier.replace(/'/g, "\\'")}', '${name.replace(/'/g, "\\'")}')
import json
print(json.dumps(sess.to_json()))
`
  return JSON.parse(runPython(script))
}

/**
 * Fork a session into a new one.
 */
export async function forkSession(identifier: string, name?: string | null): Promise<Session> {
  const script = `
${header()}
store = SessionStore()
sess = store.fork('${identifier.replace(/'/g, "\\'")}', name=${name ? `'${name.replace(/'/g, "\\'")}'` : 'None'})
import json
print(json.dumps(sess.to_json()))
`
  return JSON.parse(runPython(script))
}

/**
 * Mark a session as ended.
 */
export async function endSession(identifier: string): Promise<void> {
  const script = `
${header()}
store = SessionStore()
store.end('${identifier.replace(/'/g, "\\'")}')
`
  runPython(script)
}

/**
 * Delete a session (and its JSON file).
 */
export async function deleteSession(identifier: string): Promise<void> {
  const script = `
${header()}
store = SessionStore()
store.delete('${identifier.replace(/'/g, "\\'")}')
`
  runPython(script)
}

/**
 * Export a session to a JSON file. Returns the absolute output path.
 */
export async function exportSession(identifier: string, outPath: string): Promise<string> {
  const script = `
${header()}
store = SessionStore()
out = store.export('${identifier.replace(/'/g, "\\'")}', __import__('pathlib').Path('${outPath.replace(/'/g, "\\'")}'))
print(str(out))
`
  return runPython(script)
}

/**
 * Import a session JSON file. Returns the imported session.
 */
export async function importSession(inPath: string, newId: boolean = true): Promise<Session> {
  const script = `
${header()}
store = SessionStore()
sess = store.import_(__import__('pathlib').Path('${inPath.replace(/'/g, "\\'")}'), new_id=${newId ? 'True' : 'False'})
import json
print(json.dumps(sess.to_json()))
`
  return JSON.parse(runPython(script))
}

/**
 * Delete sessions that have ended and are older than the cutoff.
 * Returns the number deleted.
 */
export async function pruneSessions(olderThanDays: number = 30): Promise<number> {
  const script = `
${header()}
store = SessionStore()
print(store.prune(${olderThanDays}))
`
  return parseInt(runPython(script) || '0', 10)
}

/**
 * Delete all sessions for an agent. Returns the number deleted.
 */
export async function deleteSessionsForAgent(agentName: string): Promise<number> {
  const script = `
${header()}
store = SessionStore()
print(store.delete_for_agent('${agentName.replace(/'/g, "\\'")}'))
`
  return parseInt(runPython(script) || '0', 10)
}
