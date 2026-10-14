import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

// cast-tui is an ES module, so Mocha's CJS loader cannot import it.
// Transpile the subject-agent helper and run that JavaScript instead.
function loadSubjectAgent(): typeof import('../../../typescript/cast-tui/src/lib/subject-agent') {
  const file = path.resolve(__dirname, '../../../typescript/cast-tui/src/lib/subject-agent.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {exports: module.exports, module, require, Buffer, process, console}
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

describe('slash command subject agent', () => {
  const {
    BUILDER_SESSION_NAME,
    CAPTURED_CHILD_STDIO,
    NO_AGENT_LOADED_MESSAGE,
    childProcessFailureReason,
    isFreshTimestamp,
    pickCreatedAgent,
    resolveSubjectAgent,
  } = loadSubjectAgent()

  function writeAgent(agentsDir: string, name: string): void {
    const agentDir = path.join(agentsDir, name)
    fs.mkdirSync(agentDir, {recursive: true})
    fs.writeFileSync(path.join(agentDir, 'agent.yaml'), `name: ${name}\ndescription: test\n`)
  }

  it('keeps the agent open in cast dev or cast edit', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-subject-'))
    const marker = path.join(root, 'created-agent')
    fs.writeFileSync(marker, 'bb-summarizer\n')
    const result = resolveSubjectAgent({
      sessionAgentName: 'email-assistant',
      agentsDir: path.join(root, 'missing'),
      markerPath: marker,
      sessionStartedAtMs: Date.now(),
    })
    expect(result).to.deep.equal({ok: true, name: 'email-assistant'})
  })

  it('does not guess an agent when the wizard start time is missing', () => {
    const result = resolveSubjectAgent({
      sessionAgentName: BUILDER_SESSION_NAME,
      agentsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cast-subject-')),
      markerPath: path.join(os.tmpdir(), 'cast-subject-missing-marker'),
    })
    expect(result).to.deep.equal({ok: false, message: NO_AGENT_LOADED_MESSAGE})
  })

  it('says no agent is loaded before the wizard creates one', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-subject-'))
    const agentsDir = path.join(root, 'agents')
    fs.mkdirSync(agentsDir)
    writeAgent(agentsDir, 'already-there')
    const marker = path.join(root, 'created-agent')
    fs.writeFileSync(marker, 'already-there\n')
    const sessionStartedAtMs = Date.now() + 60_000
    const result = resolveSubjectAgent({
      sessionAgentName: BUILDER_SESSION_NAME,
      agentsDir,
      markerPath: marker,
      sessionStartedAtMs,
    })
    expect(result).to.deep.equal({ok: false, message: NO_AGENT_LOADED_MESSAGE})
  })

  it('targets the agent the wizard just created', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-subject-'))
    const agentsDir = path.join(root, 'agents')
    writeAgent(agentsDir, 'bb-summarizer')
    writeAgent(agentsDir, 'other-agent')
    const marker = path.join(root, 'created-agent')
    fs.writeFileSync(marker, 'bb-summarizer\n')
    const result = resolveSubjectAgent({
      sessionAgentName: BUILDER_SESSION_NAME,
      agentsDir,
      markerPath: marker,
      sessionStartedAtMs: Date.now() - 60_000,
    })
    expect(result).to.deep.equal({ok: true, name: 'bb-summarizer'})
  })

  it('falls back to a new agent directory when the marker name is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-subject-'))
    const agentsDir = path.join(root, 'agents')
    writeAgent(agentsDir, 'bb-summarizer')
    const marker = path.join(root, 'created-agent')
    fs.writeFileSync(marker, 'not-created\n')
    const result = resolveSubjectAgent({
      sessionAgentName: '__new__',
      agentsDir,
      markerPath: marker,
      sessionStartedAtMs: Date.now() - 60_000,
    })
    expect(result).to.deep.equal({ok: true, name: 'bb-summarizer'})
  })

  it('picks the newest agent created during the session', () => {
    expect(isFreshTimestamp(1000, 2500)).to.equal(true)
    expect(isFreshTimestamp(1000, 2501)).to.equal(false)
    expect(pickCreatedAgent([
      {name: 'older', createdAtMs: 1000},
      {name: 'bb-summarizer', createdAtMs: 5000},
    ], 4000)).to.equal('bb-summarizer')
    expect(pickCreatedAgent([
      {name: 'older', createdAtMs: 1000},
    ], 4000)).to.equal(null)
  })

  it('shows the CLI error line instead of a blank reason', () => {
    const stderr = " ›   Error: Agent 'Cast Builder' not found at /home/box/.cast/agents/Cast Builder.\n"
    expect(childProcessFailureReason({stderr, message: 'Command failed: cast undo\n'})).to.equal(
      "Agent 'Cast Builder' not found at /home/box/.cast/agents/Cast Builder.",
    )
    expect(childProcessFailureReason({
      stderr: Buffer.from(' ›   Error: Nothing to redo for agent \'bb-summarizer\'.\n'),
    })).to.equal("Nothing to redo for agent 'bb-summarizer'.")
    expect(childProcessFailureReason({
      message: 'Command failed: cast undo Cast Builder --steps 1 --json\n',
    })).to.equal('unknown error')
  })

  it('keeps child stderr off the parent terminal', () => {
    const script = "process.stderr.write('Agent missing on purpose.\\n'); process.exit(1)"
    let painted = ''
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string | Uint8Array) => {
      painted += chunk.toString()
      return true
    }) as typeof process.stderr.write
    try {
      let caught: unknown
      try {
        execFileSync(process.execPath, ['-e', script], {
          encoding: 'utf-8',
          stdio: CAPTURED_CHILD_STDIO,
        })
      } catch (err) {
        caught = err
      }
      expect(childProcessFailureReason(caught)).to.equal('Agent missing on purpose.')
      expect(painted).to.equal('')
    } finally {
      process.stderr.write = original
    }
  })
})
