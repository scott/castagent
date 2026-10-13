import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

function loadSessionTopic(): {
  sessionDisplayTitle: (session: Record<string, unknown>) => string
  topicIsFresh: (session: Record<string, unknown>) => boolean
  topicNeedsRefresh: (session: Record<string, unknown>) => boolean
  sessionMetaFromRow: (row: Record<string, unknown>) => Record<string, unknown>
  refreshStaleSessionTopics: (
    sessions: Array<Record<string, unknown>>,
    options: {
      concurrency?: number
      refreshOne: (session: Record<string, unknown>) => Promise<Record<string, unknown> | null | void>
      onUpdated?: (index: number, session: Record<string, unknown>) => void
      isCancelled?: () => boolean
    },
  ) => Promise<void>
  SESSION_TOPIC_CONCURRENCY: number
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/session-topic.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {exports: module.exports, module, require, console}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('tui session topics', () => {
  const topic = loadSessionTopic()

  it('uses the same title rule as cast session list', () => {
    expect(topic.sessionDisplayTitle({
      name: 'Kept name',
      topic: 'Login redirect',
      first_user_message: 'please fix login',
    })).to.equal('Kept name')
    expect(topic.sessionDisplayTitle({
      topic: 'Login redirect',
      first_user_message: 'please fix login',
    })).to.equal('Login redirect')
    expect(topic.sessionDisplayTitle({
      first_user_message: 'please\nfix   login',
    })).to.equal('please fix login')
    expect(topic.sessionDisplayTitle({})).to.equal('(untitled)')
    expect(topic.topicIsFresh({topic: 'Login redirect', topic_message_count: 2, message_count: 2})).to.equal(true)
    expect(topic.topicIsFresh({topic: 'Login redirect', topic_message_count: 1, message_count: 2})).to.equal(false)
  })

  it('maps rows written before the topic columns existed', () => {
    const row = topic.sessionMetaFromRow({id: 'legacy', agent_name: 'alpha'})
    expect(row.topic).to.equal(null)
    expect(row.topic_message_count).to.equal(null)
    const stored = topic.sessionMetaFromRow({id: 'a', topic: 'Login redirect', topic_message_count: 2})
    expect(stored.topic).to.equal('Login redirect')
    expect(stored.topic_message_count).to.equal(2)
  })

  it('refreshes only stale unnamed sessions and repaints when a topic arrives', async () => {
    const sessions = [
      {id: 'named', name: 'Kept', first_user_message: 'hello', topic: null, topic_message_count: null, message_count: 1},
      {id: 'empty', name: null, first_user_message: null, topic: null, topic_message_count: null, message_count: 0},
      {id: 'fresh', name: null, first_user_message: 'hello', topic: 'Already', topic_message_count: 1, message_count: 1},
      {id: 'stale', name: null, first_user_message: 'please fix login', topic: null, topic_message_count: null, message_count: 1},
      {id: 'failed', name: null, first_user_message: 'other', topic: null, topic_message_count: null, message_count: 1},
    ]
    const calls: string[] = []
    const paints: string[] = []
    await topic.refreshStaleSessionTopics(sessions, {
      refreshOne: async (session) => {
        calls.push(String(session.id))
        if (session.id === 'failed') return null
        return {topic: 'Login redirect', topic_message_count: 1}
      },
      onUpdated: (_index, session) => paints.push(String(session.id)),
    })
    expect(calls).to.deep.equal(['stale', 'failed'])
    expect(paints).to.deep.equal(['stale'])
    expect(sessions[3].topic).to.equal('Login redirect')
    expect(sessions[4].topic).to.equal(null)
    expect(topic.sessionDisplayTitle(sessions[3])).to.equal('Login redirect')
    expect(topic.sessionDisplayTitle(sessions[0])).to.equal('Kept')
  })

  it('does not let a 50-row list exceed the concurrency bound', async () => {
    expect(topic.SESSION_TOPIC_CONCURRENCY).to.equal(3)
    const sessions = Array.from({length: 50}, (_value, index) => ({
      id: `s${index}`,
      name: null,
      first_user_message: 'hello',
      topic: null,
      topic_message_count: null,
      message_count: 1,
    }))
    let inFlight = 0
    let max = 0
    const queue: Array<(value: {topic: string; topic_message_count: number}) => void> = []
    const pending = topic.refreshStaleSessionTopics(sessions, {
      refreshOne: () => {
        inFlight += 1
        max = Math.max(max, inFlight)
        return new Promise((resolve) => {
          queue.push((value) => {
            inFlight -= 1
            resolve(value)
          })
        })
      },
    })
    await flush()
    expect(queue).to.have.length(3)
    expect(max).to.equal(3)
    while (queue.length > 0) {
      const resolve = queue.shift()
      resolve?.({topic: 'Topic line', topic_message_count: 1})
      await flush()
    }
    await pending
    expect(max).to.equal(3)
    expect(sessions.every((session) => session.topic === 'Topic line')).to.equal(true)
  })

  it('stops scheduling once the picker is closed', async () => {
    const sessions = Array.from({length: 5}, (_value, index) => ({
      id: `s${index}`,
      name: null,
      first_user_message: 'hello',
      topic: null,
      topic_message_count: null,
      message_count: 1,
    }))
    let closed = false
    let calls = 0
    const queue: Array<() => void> = []
    const pending = topic.refreshStaleSessionTopics(sessions, {
      concurrency: 1,
      isCancelled: () => closed,
      refreshOne: () => {
        calls += 1
        return new Promise((resolve) => {
          queue.push(() => resolve({topic: 'Topic line', topic_message_count: 1}))
        })
      },
    })
    await flush()
    expect(calls).to.equal(1)
    closed = true
    queue.shift()?.()
    await pending
    expect(calls).to.equal(1)
  })

  it('ignores a refresh that throws', async () => {
    const sessions = [{
      id: 's',
      name: null,
      first_user_message: 'hello',
      topic: null,
      topic_message_count: null,
      message_count: 1,
    }]
    await topic.refreshStaleSessionTopics(sessions, {
      refreshOne: async () => {
        throw new Error('provider down')
      },
    })
    expect(sessions[0].topic).to.equal(null)
    expect(topic.sessionDisplayTitle(sessions[0])).to.equal('hello')
  })
})
