import {expect} from 'chai'
import {execFileSync, spawnSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {CastDatabase} from '../../../typescript/cast-cli/src/lib/sqlite'

/**
 * Production order for `cast connect` on a home whose sessions table
 * has no topic columns yet: opening the database adds `topic`, then
 * the CLI and TUI append through the checkout package. A stale package
 * planted at ~/.cast/python must not run, the message must land in the
 * session file, and the helper must not write a traceback to the terminal.
 */
describe('session append seam', () => {
  const repo = path.resolve(__dirname, '../../..')
  const worker = path.join(__dirname, 'session-append-worker.ts')
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-session-seam-'))
  const castHome = path.join(home, '.cast')
  const dbPath = path.join(castHome, 'cast.db')
  const sessionId = 'seam-session'
  const jsonPath = path.join(castHome, 'sessions', `${sessionId}.json`)

  before(() => {
    fs.mkdirSync(path.dirname(jsonPath), {recursive: true})
    fs.writeFileSync(jsonPath, JSON.stringify({
      id: sessionId,
      name: null,
      agent_name: 'demo-agent',
      agent_version_at_start: null,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      ended_at: null,
      mode: 'build',
      ui_mode: 'production',
      messages: [],
      files_in_context: [],
      parent_session_id: null,
      tags: [],
    }))
    execFileSync('python3', ['-c', `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
conn.execute("""
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    name TEXT,
    agent_name TEXT NOT NULL,
    mode TEXT,
    ui_mode TEXT,
    created_at DATETIME,
    updated_at DATETIME,
    ended_at DATETIME,
    message_count INTEGER DEFAULT 0,
    parent_session_id TEXT,
    first_user_message TEXT,
    last_user_message TEXT,
    json_path TEXT NOT NULL
)
""")
conn.execute(
    "INSERT INTO sessions (id, name, agent_name, mode, ui_mode, created_at, updated_at, ended_at, message_count, parent_session_id, first_user_message, last_user_message, json_path) VALUES (?, NULL, 'demo-agent', 'build', 'production', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, 0, NULL, NULL, NULL, ?)",
    (${JSON.stringify(sessionId)}, ${JSON.stringify(jsonPath)}),
)
conn.commit()
`], {stdio: ['ignore', 'pipe', 'pipe']})

    const staleDir = path.join(castHome, 'python', 'cast')
    fs.mkdirSync(staleDir, {recursive: true})
    fs.writeFileSync(path.join(staleDir, 'sessions.py'), [
      'from pathlib import Path',
      'Path.home().joinpath(".cast", "stale-python-imported").write_text("imported\\n")',
      '',
      'class SessionMeta:',
      '    def __init__(self, *args, **kwargs):',
      '        if "topic" in kwargs:',
      '            raise TypeError("SessionMeta.__init__() got an unexpected keyword argument \'topic\'")',
      '',
      'class SessionStore:',
      '    def append_message(self, *args, **kwargs):',
      '        raise TypeError("SessionMeta.__init__() got an unexpected keyword argument \'topic\'")',
      '',
    ].join('\n'))

    const db = new CastDatabase(dbPath)
    ;(db as unknown as {db: {close(): void}}).db.close()
  })

  after(() => {
    fs.rmSync(home, {recursive: true, force: true})
  })

  it('migrates topic columns, appends through the CLI and TUI, and ignores the stale package', () => {
    const columns = execFileSync('python3', ['-c', `
import sqlite3
conn = sqlite3.connect(${JSON.stringify(dbPath)})
print(",".join(row[1] for row in conn.execute("PRAGMA table_info(sessions)")))
`], {encoding: 'utf8'}).trim().split(',')
    expect(columns).to.include('topic')
    expect(columns).to.include('topic_message_count')

    const cli = runHelper('cli', 'hi there')
    const tui = runHelper('tui', 'welcome back')
    expect(cli.stderr, `cli stderr:\n${cli.stderr}`).to.equal('')
    expect(tui.stderr, `tui stderr:\n${tui.stderr}`).to.equal('')
    expect(cli.status, cli.stderr || cli.stdout).to.equal(0)
    expect(tui.status, tui.stderr || tui.stdout).to.equal(0)

    const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
    expect(saved.messages.map((message: {text: string}) => message.text)).to.deep.equal([
      'hi there',
      'welcome back',
    ])
    expect(fs.existsSync(path.join(castHome, 'stale-python-imported'))).to.equal(false)
  })

  function runHelper(which: 'cli' | 'tui', text: string): {status: number | null; stdout: string; stderr: string} {
    const result = spawnSync(process.execPath, [
      '-r', 'ts-node/register',
      worker,
      which,
      sessionId,
      text,
    ], {
      cwd: repo,
      env: {
        ...process.env,
        HOME: home,
        TS_NODE_TRANSPILE_ONLY: '1',
      },
      encoding: 'utf8',
    })
    return {
      status: result.status,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    }
  }
})
