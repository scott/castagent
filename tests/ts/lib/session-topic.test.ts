import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import {CastDatabase, mapSessionRow} from '../../../typescript/cast-cli/src/lib/sqlite'
import {sessionDisplayTitle, topicIsFresh} from '../../../typescript/cast-cli/src/lib/session-topic'

describe('session display title', () => {
  it('prefers name, then topic, then the first message, then untitled', () => {
    expect(sessionDisplayTitle({
      name: 'Kept name',
      topic: 'Login redirect',
      first_user_message: 'please fix login',
    })).to.equal('Kept name')
    expect(sessionDisplayTitle({
      name: null,
      topic: 'Login redirect',
      first_user_message: 'please fix login',
    })).to.equal('Login redirect')
    expect(sessionDisplayTitle({
      name: '  ',
      topic: '',
      first_user_message: 'please\nfix   login',
    })).to.equal('please fix login')
    expect(sessionDisplayTitle({
      name: null,
      topic: null,
      first_user_message: null,
    })).to.equal('(untitled)')
  })

  it('cuts a long first message to 60 characters', () => {
    const title = sessionDisplayTitle({first_user_message: 'word '.repeat(30)})
    expect(title).to.have.length(60)
    expect(title.endsWith('…')).to.equal(true)
  })

  it('shows a stored topic even when the count is stale', () => {
    const session = {
      name: null,
      topic: 'Old topic',
      first_user_message: 'please fix login',
      topic_message_count: 1,
      message_count: 2,
    }
    expect(sessionDisplayTitle(session)).to.equal('Old topic')
    expect(topicIsFresh(session)).to.equal(false)
    expect(topicIsFresh({...session, message_count: 1})).to.equal(true)
    expect(topicIsFresh({topic: '', topic_message_count: 1, message_count: 1})).to.equal(false)
    expect(topicIsFresh({topic: 'Old topic', topic_message_count: null, message_count: 1})).to.equal(false)
  })
})

describe('session topic sqlite index', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-session-topic-'))
  const dbPath = path.join(dir, 'cast.db')

  after(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  it('defaults topic fields when the row has no such columns', () => {
    const mapped = mapSessionRow({id: 'legacy', agent_name: 'alpha', first_user_message: 'Hello'})
    expect(mapped.topic).to.equal(null)
    expect(mapped.topic_message_count).to.equal(null)
    expect(mapped.first_user_message).to.equal('Hello')
  })

  it('adds topic columns to an existing sessions table and round-trips them', () => {
    const raw = new Database(dbPath)
    raw.exec(`
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
    `)
    raw.prepare(`
      INSERT INTO sessions (
        id, name, agent_name, mode, ui_mode, created_at, updated_at,
        message_count, first_user_message, json_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-1',
      null,
      'alpha',
      'build',
      'dev',
      '2020-01-01T00:00:00Z',
      '2020-01-01T00:00:00Z',
      1,
      'Hello from before',
      '/tmp/legacy.json',
    )
    raw.close()

    const db = new CastDatabase(dbPath)
    const legacy = db.getSession('legacy-1')
    expect(legacy.agent_name).to.equal('alpha')
    expect(legacy.topic).to.equal(null)
    expect(legacy.topic_message_count).to.equal(null)
    expect(legacy.first_user_message).to.equal('Hello from before')

    db.upsertSession({
      id: 'topic-1',
      name: null,
      agent_name: 'alpha',
      mode: 'build',
      ui_mode: 'dev',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
      ended_at: null,
      message_count: 2,
      parent_session_id: null,
      first_user_message: 'please fix login',
      last_user_message: 'please fix login',
      topic: 'Login redirect',
      topic_message_count: 2,
      json_path: '/tmp/topic-1.json',
    })

    const stored = db.getSession('topic-1')
    expect(stored.topic).to.equal('Login redirect')
    expect(stored.topic_message_count).to.equal(2)
    const listed = db.listSessions('alpha')
    const match = listed.find((row: {id: string}) => row.id === 'topic-1')
    expect(match.topic).to.equal('Login redirect')
    expect(match.topic_message_count).to.equal(2)

    const again = new CastDatabase(dbPath)
    expect(again.getSession('legacy-1').id).to.equal('legacy-1')
    expect(again.getSession('topic-1').topic).to.equal('Login redirect')

    const check = new Database(dbPath, {readonly: true})
    const names = (check.prepare('PRAGMA table_info(sessions)').all() as {name: string}[]).map((col) => col.name)
    check.close()
    expect(names.filter((name) => name === 'topic')).to.deep.equal(['topic'])
    expect(names.filter((name) => name === 'topic_message_count')).to.deep.equal(['topic_message_count'])
  })
})
