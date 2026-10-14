import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
function loadTranscript(): {
  resolveTranscriptPath: (agentName: string, filename?: string) => string
  saveTranscript: (
    agentName: string,
    messages: Array<{role: 'user' | 'agent'; text: string}>,
    filename?: string,
  ) => string
} {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/transcript.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = {exports: {} as Record<string, unknown>}
  const sandbox = {exports: module.exports, module, require}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports as ReturnType<typeof loadTranscript>
}

describe('TUI /save transcript paths', () => {
  const {resolveTranscriptPath, saveTranscript} = loadTranscript()
  const messages = [
    {role: 'user' as const, text: 'hello'},
    {role: 'agent' as const, text: 'hi there'},
  ]

  let home: string
  let previousHome: string | undefined
  const scratch: string[] = []

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-transcript-home-'))
    previousHome = process.env.HOME
    process.env.HOME = home
    scratch.length = 0
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    fs.rmSync(home, {recursive: true, force: true})
    for (const dir of scratch) {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  function transcriptsDir(): string {
    return path.join(home, '.cast', 'transcripts')
  }

  it('writes an absolute path as given and creates missing parents', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-transcript-abs-'))
    scratch.push(root)
    const dest = path.join(root, 'nested', 'transcript.md')

    const saved = saveTranscript('helper', messages, dest)

    expect(saved).to.equal(dest)
    expect(fs.existsSync(dest)).to.equal(true)
    expect(fs.existsSync(path.join(transcriptsDir(), 'nested', 'transcript.md'))).to.equal(false)
    expect(fs.existsSync(transcriptsDir())).to.equal(false)
    expect(fs.readFileSync(dest, 'utf8')).to.include('=== Conversation with helper ===')
  })

  it('does not join an absolute path under ~/.cast/transcripts', () => {
    const saved = resolveTranscriptPath('helper', '/tmp/transcript.md')
    expect(saved).to.equal(path.normalize('/tmp/transcript.md'))
    expect(saved.startsWith(transcriptsDir())).to.equal(false)
  })

  it('expands a leading ~ to the home directory and creates parents', () => {
    const saved = saveTranscript('helper', messages, '~/notes/transcript.md')
    const expected = path.join(home, 'notes', 'transcript.md')
    expect(saved).to.equal(expected)
    expect(fs.existsSync(expected)).to.equal(true)
    expect(fs.existsSync(transcriptsDir())).to.equal(false)
  })

  it('treats ~name as a relative filename', () => {
    const saved = saveTranscript('helper', messages, '~notes.txt')
    expect(saved).to.equal(path.join(transcriptsDir(), '~notes.txt'))
    expect(fs.existsSync(saved)).to.equal(true)
  })

  it('keeps a relative name under ~/.cast/transcripts', () => {
    const saved = saveTranscript('helper', messages, 'name.md')
    expect(saved).to.equal(path.join(transcriptsDir(), 'name.md'))
    const body = fs.readFileSync(saved, 'utf8')
    expect(body).to.include('[User]\nhello\n')
    expect(body).to.include('[Agent]\nhi there\n')
    expect(body).to.match(/^=== Conversation with helper ===\nDate: /)
  })

  it('creates parent directories for a relative path', () => {
    const saved = saveTranscript('helper', messages, 'nested/dir/note.txt')
    expect(saved).to.equal(path.join(transcriptsDir(), 'nested', 'dir', 'note.txt'))
    expect(fs.existsSync(saved)).to.equal(true)
  })

  it('defaults to a plain text <agent>-<timestamp>.txt file', () => {
    const saved = saveTranscript('helper', messages)
    expect(path.dirname(saved)).to.equal(transcriptsDir())
    expect(path.basename(saved)).to.match(/^helper-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/)
    const body = fs.readFileSync(saved, 'utf8')
    expect(body.startsWith('=== Conversation with helper ===\n')).to.equal(true)
    expect(body).to.include('[User]\nhello\n')
    expect(body).to.not.match(/^# /m)
    expect(body).to.not.include('**')
  })
})
