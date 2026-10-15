import {expect} from 'chai'
import {spawn} from 'child_process'
import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import {waitForAgentPort} from '../../../typescript/cast-cli/src/commands/session/resume'
import {resolveCastPythonRuntime} from '../../../typescript/cast-cli/src/lib/cast-python'
import {
  buildTuiArgs,
  devRuntimeArgs,
  tuiAuthEnv,
  isTcpPortOpen,
  planSessionResume,
  pythonModuleDirForCommand,
  resolveBun,
  resolveTuiEntry,
  takeAgentReadyPort,
  tuiEntryCandidates,
  type ResumePlanInput,
} from '../../../typescript/cast-cli/src/lib/session-resume'

const SESSION_ID = '1a1387fa362-31d34a188afd'

function planInput(overrides: Partial<ResumePlanInput> = {}): ResumePlanInput {
  return {
    session: {
      id: SESSION_ID,
      agent_name: 'bb-summarizer',
      ui_mode: 'dev',
    },
    agentExists: true,
    agentPath: '/home/box/.cast/agents/bb-summarizer',
    localUrl: null,
    deploymentUrl: null,
    deploymentError: null,
    deploymentProvider: null,
    token: null,
    onHostUrl: null,
    ...overrides,
  }
}

describe('session resume launch plan', () => {
  it('starts the local agent for a dev session that is not already running', () => {
    const plan = planSessionResume(planInput())
    expect(plan).to.deep.equal({
      action: 'start-dev',
      agentName: 'bb-summarizer',
      sessionId: SESSION_ID,
      agentPath: '/home/box/.cast/agents/bb-summarizer',
    })
  })

  it('attaches to a dev agent that is already accepting connections', () => {
    const plan = planSessionResume(planInput({localUrl: 'http://localhost:4312'}))
    expect(plan).to.deep.equal({
      action: 'launch',
      agentName: 'bb-summarizer',
      sessionId: SESSION_ID,
      url: 'http://localhost:4312',
      mode: 'dev',
      token: null,
      connectProvider: false,
    })
  })

  it('reports a missing dev agent directory', () => {
    const plan = planSessionResume(planInput({agentExists: false}))
    expect(plan.action).to.equal('error')
    if (plan.action === 'error') {
      expect(plan.message).to.include("Agent 'bb-summarizer' not found")
      expect(plan.message).to.include('/home/box/.cast/agents/bb-summarizer')
    }
  })

  it('connects a production session to its deployment', () => {
    const plan = planSessionResume(planInput({
      session: {id: SESSION_ID, agent_name: 'bb-summarizer', ui_mode: 'production'},
      deploymentUrl: 'https://bb.example.test',
      deploymentProvider: 'railway',
      token: 'secret-token',
    }))
    expect(plan).to.deep.equal({
      action: 'launch',
      agentName: 'bb-summarizer',
      sessionId: SESSION_ID,
      url: 'https://bb.example.test',
      mode: 'production',
      token: 'secret-token',
      connectProvider: true,
    })
  })

  it('returns the deployment error when a production session has no deployment', () => {
    const plan = planSessionResume(planInput({
      session: {id: SESSION_ID, agent_name: 'bb-summarizer', ui_mode: 'production'},
      deploymentError: "No deployment found for 'bb-summarizer'. Use 'cast deploy' to deploy.",
    }))
    expect(plan.action).to.equal('error')
    if (plan.action === 'error') {
      expect(plan.message).to.include('cast deploy')
    }
  })

  it('uses CAST_A2A_URL for an on-host session', () => {
    const plan = planSessionResume(planInput({
      session: {id: SESSION_ID, agent_name: 'bb-summarizer', ui_mode: 'on-host'},
      onHostUrl: 'http://localhost:8080',
    }))
    expect(plan.action).to.equal('launch')
    if (plan.action === 'launch') {
      expect(plan.url).to.equal('http://localhost:8080')
      expect(plan.mode).to.equal('on-host')
      expect(plan.connectProvider).to.equal(false)
    }
  })

  it('uses the deployment when an on-host session has no CAST_A2A_URL', () => {
    const plan = planSessionResume(planInput({
      session: {id: SESSION_ID, agent_name: 'bb-summarizer', ui_mode: 'on-host'},
      deploymentUrl: 'https://bb.example.test',
      token: 'tok',
    }))
    expect(plan.action).to.equal('launch')
    if (plan.action === 'launch') {
      expect(plan.mode).to.equal('production')
      expect(plan.url).to.equal('https://bb.example.test')
      expect(plan.connectProvider).to.equal(true)
    }
  })

  it('explains a missing URL for an on-host session', () => {
    const plan = planSessionResume(planInput({
      session: {id: SESSION_ID, agent_name: 'bb-summarizer', ui_mode: 'on-host'},
    }))
    expect(plan.action).to.equal('error')
    if (plan.action === 'error') {
      expect(plan.message).to.include('CAST_A2A_URL')
    }
  })

  it('passes an ambiguous deployment error through', () => {
    const plan = planSessionResume(planInput({
      session: {id: SESSION_ID, agent_name: 'bb-summarizer', ui_mode: 'on-host'},
      deploymentError: 'Multiple deployments found for bb-summarizer',
    }))
    expect(plan.action).to.equal('error')
    if (plan.action === 'error') {
      expect(plan.message).to.include('Multiple deployments')
    }
  })
})

describe('session resume TUI argv', () => {
  const tuiPath = '/opt/cast/typescript/cast-tui/dist/index.js'

  it('passes --session to cast-tui instead of the cast CLI', () => {
    const args = buildTuiArgs({
      tuiPath,
      agentName: 'bb-summarizer',
      url: 'http://localhost:4312',
      mode: 'dev',
      sessionId: SESSION_ID,
    })
    expect(args[0]).to.equal(tuiPath)
    expect(args).to.deep.equal([
      tuiPath,
      '--agent', 'bb-summarizer',
      '--url', 'http://localhost:4312',
      '--mode', 'dev',
      '--session', SESSION_ID,
    ])
    expect(args[0]).to.not.equal('cast')
  })

  it('keeps bearer and edge credentials out of argv', () => {
    const token = 'sentinel-bearer-token'
    const edgeToken = 'sentinel-edge-token'
    const args = buildTuiArgs({
      tuiPath,
      agentName: 'bb-summarizer',
      url: 'https://bb.example.test',
      mode: 'production',
      sessionId: SESSION_ID,
    })
    const joined = args.join('\0')
    expect(args.slice(args.indexOf('--session'))).to.deep.equal([
      '--session', SESSION_ID,
    ])
    expect(joined).to.not.include(token)
    expect(joined).to.not.include(edgeToken)
    expect(args).to.not.include('--token')
    expect(args).to.not.include('--edge-token')

    const base = {AUTH_TOKEN: 'inherited-bearer', CAST_EDGE_TOKEN: 'stale-edge'}
    const env = tuiAuthEnv(base, {token, edgeToken})
    expect(env.AUTH_TOKEN).to.equal(token)
    expect(env.CAST_EDGE_TOKEN).to.equal(edgeToken)
    expect(base.CAST_EDGE_TOKEN).to.equal('stale-edge')
  })

  it('inherits AUTH_TOKEN and drops a stale edge credential when none is set', () => {
    const env = tuiAuthEnv({AUTH_TOKEN: 'inherited-bearer', CAST_EDGE_TOKEN: 'stale-edge'}, {})
    expect(env.AUTH_TOKEN).to.equal('inherited-bearer')
    expect(env.CAST_EDGE_TOKEN).to.equal(undefined)
  })

  it('places credentials in the child environment and not on the command line', function (done) {
    if (process.platform !== 'linux') {
      this.skip()
    }
    const token = 'sentinel-bearer-token'
    const edgeToken = 'sentinel-edge-token'
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: tuiAuthEnv({PATH: process.env.PATH}, {token, edgeToken}),
      stdio: 'ignore',
    })
    let finished = false
    const finish = (error?: unknown) => {
      if (finished) return
      finished = true
      if (!child.killed) child.kill()
      done(error)
    }
    child.once('error', finish)
    child.once('exit', () => finish())
    if (!child.pid) {
      finish(new Error('child pid was not assigned'))
      return
    }
    try {
      const cmdline = fs.readFileSync(`/proc/${child.pid}/cmdline`)
      const environ = fs.readFileSync(`/proc/${child.pid}/environ`)
      const commandText = cmdline.toString('utf8')
      const entries = environ.toString('utf8').split('\0')
      expect(commandText).to.not.include(token)
      expect(commandText).to.not.include(edgeToken)
      expect(commandText).to.not.include('--token')
      expect(commandText).to.not.include('--edge-token')
      expect(entries).to.include(`AUTH_TOKEN=${token}`)
      expect(entries).to.include(`CAST_EDGE_TOKEN=${edgeToken}`)
      finish()
    } catch (error) {
      finish(error)
    }
  })

  it('builds the local runtime command with a dynamic port', () => {
    expect(devRuntimeArgs('/home/box/.cast/agents/bb-summarizer', 0)).to.deep.equal([
      '-m', 'cast.runtime',
      '--agent-path', '/home/box/.cast/agents/bb-summarizer',
      '--port', '0',
    ])
  })

  it('reads the ready port when it is split across chunks', () => {
    const first = takeAgentReadyPort('boot\nAgent ready on port 43')
    expect(first.port).to.equal(null)
    expect(first.logs).to.equal('boot\n')
    const second = takeAgentReadyPort(`${first.leftover}\n`)
    expect(second.port).to.equal(43)
  })

  it('resolves bun from the home directory before PATH', () => {
    const home = '/home/box'
    const bun = resolveBun(home, (candidate) => candidate === path.join(home, '.bun', 'bin', 'bun'))
    expect(bun).to.equal(path.join(home, '.bun', 'bin', 'bun'))
    expect(resolveBun(home, () => false)).to.equal('bun')
  })

  it('finds cast-tui next to the session command', () => {
    const commandDir = path.resolve(__dirname, '../../../typescript/cast-cli/src/commands/session')
    const expected = path.resolve(__dirname, '../../../typescript/cast-tui/dist/index.js')
    expect(tuiEntryCandidates(commandDir)[0]).to.equal(expected)
    expect(resolveTuiEntry(commandDir, (candidate) => candidate === expected)).to.equal(expected)
    expect(resolveTuiEntry(commandDir, () => false)).to.equal(null)
  })

  it('points the Python runtime at this checkout', () => {
    const commandDir = path.resolve(__dirname, '../../../typescript/cast-cli/src/commands/session')
    const runtime = resolveCastPythonRuntime(pythonModuleDirForCommand(commandDir))
    expect(runtime.pythonPath).to.equal(path.resolve(__dirname, '../../../python'))
    expect(fs.existsSync(path.join(runtime.pythonPath, 'cast', 'runtime.py'))).to.equal(true)
  })
})

describe('session resume command source', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../typescript/cast-cli/src/commands/session/resume.ts'),
    'utf8',
  )

  it('spawns cast-tui with the session id and credentials in the environment', () => {
    expect(source).to.include('buildTuiArgs')
    expect(source).to.include('resolveTuiEntry')
    expect(source).to.include("spawn(resolveBun(), buildTuiArgs(")
    expect(source).to.include('tuiAuthEnv(process.env, {token: opts.token, edgeToken: opts.edgeToken})')
    expect(source).to.not.include('--token')
    expect(source).to.not.include('--edge-token')
  })

  it('records the dev runtime stdout and stderr for cast logs', () => {
    expect(source).to.include('attachRuntimeLog')
    expect(source).to.include("stdio: ['pipe', 'pipe', 'pipe']")
  })

  it('does not exec the cast binary', () => {
    expect(source).to.not.include('execFileSync')
    expect(source).to.not.include('which')
    expect(source).to.not.match(/\[.?'--session',\s*sess\.id\]/)
  })
})

describe('waitForAgentPort', () => {
  it('resolves when the runtime prints its port', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("Agent ready on port 4321\\n")'])
    expect(await waitForAgentPort(child)).to.equal(4321)
  })

  it('rejects when the runtime exits before it is ready', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(3)'])
    try {
      await waitForAgentPort(child)
      expect.fail('expected the wait to reject')
    } catch (error) {
      expect((error as Error).message).to.include('exited with code 3')
    }
  })
})

describe('isTcpPortOpen', () => {
  it('reports an open port and a closed port', async () => {
    const server = net.createServer()
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected a TCP address')
    }
    try {
      expect(await isTcpPortOpen(address.port, 500)).to.equal(true)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    expect(await isTcpPortOpen(address.port, 200)).to.equal(false)
  })
})
