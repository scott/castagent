import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
function loadSessionContext(): {
  SessionContext: new () => {
    id: string | null
    start: (sessionId?: string | null) => void
    load: (sessionId: string, transcript: Array<{role: 'user' | 'agent'; text: string}>) => void
    bind: (sessionId: string) => void
    peek: () => {sessionId?: string; history?: Array<{role: string; text: string}>}
    commit: () => void
  }
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/session-context.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {exports: module.exports, module, require}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

describe('session context sent with message/send', () => {
  const {SessionContext} = loadSessionContext()

  it('starts a connection with an id and no transcript', () => {
    const ctx = new SessionContext()
    ctx.start(null)
    expect(ctx.peek()).to.deep.equal({})
    ctx.bind('conn-1')
    expect(ctx.peek()).to.deep.equal({sessionId: 'conn-1'})
    ctx.commit()
    expect(ctx.peek()).to.deep.equal({sessionId: 'conn-1'})
  })

  it('sends a resumed transcript once, then only the id', () => {
    const ctx = new SessionContext()
    const transcript = [
      {role: 'user' as const, text: 'the code is 42'},
      {role: 'agent' as const, text: 'I will remember 42'},
    ]
    ctx.load('resumed', transcript)
    expect(ctx.peek()).to.deep.equal({sessionId: 'resumed', history: transcript})
    expect(ctx.peek().history).to.have.length(2)
    ctx.commit()
    expect(ctx.peek()).to.deep.equal({sessionId: 'resumed'})
  })

  it('keeps the transcript when the loaded id is bound again', () => {
    const ctx = new SessionContext()
    ctx.load('resumed', [{role: 'user', text: 'earlier'}])
    ctx.bind('resumed')
    expect(ctx.peek().history).to.deep.equal([{role: 'user', text: 'earlier'}])
  })

  it('drops a waiting transcript when /session new picks another id', () => {
    const ctx = new SessionContext()
    ctx.load('old', [{role: 'user', text: 'do not carry'}])
    ctx.start('new-session')
    expect(ctx.id).to.equal('new-session')
    expect(ctx.peek()).to.deep.equal({sessionId: 'new-session'})
  })

  it('does not carry the previous agent when connect starts over', () => {
    const ctx = new SessionContext()
    ctx.load('agent-a', [{role: 'user', text: 'from A'}])
    ctx.start(null)
    ctx.bind('agent-b')
    expect(ctx.peek()).to.deep.equal({sessionId: 'agent-b'})
  })

  it('forks by loading the copied transcript under the new id', () => {
    const ctx = new SessionContext()
    ctx.load('original', [{role: 'user', text: 'original only'}])
    ctx.load('fork', [{role: 'user', text: 'original only'}])
    expect(ctx.id).to.equal('fork')
    expect(ctx.peek()).to.deep.equal({
      sessionId: 'fork',
      history: [{role: 'user', text: 'original only'}],
    })
    ctx.commit()
    expect(ctx.peek()).to.deep.equal({sessionId: 'fork'})
  })

  it('leaves the transcript armed when the send fails before commit', () => {
    const ctx = new SessionContext()
    ctx.load('resumed', [{role: 'user', text: 'keep'}])
    expect(ctx.peek().history).to.deep.equal([{role: 'user', text: 'keep'}])
    expect(ctx.peek().history).to.deep.equal([{role: 'user', text: 'keep'}])
  })
})
