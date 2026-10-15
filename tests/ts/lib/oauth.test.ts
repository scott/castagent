/**
 * Proves the OAuth callback cannot be injected from another host or process,
 * and that vault files are not left readable by the process umask.
 */
import {expect} from 'chai'
import * as fs from 'fs'
import * as http from 'http'
import * as net from 'net'
import * as os from 'os'
import * as path from 'path'
import axios from 'axios'
import sinon from 'sinon'
import {OAuthManager} from '../../../typescript/cast-cli/src/lib/oauth'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

const CLIENT_ID = 'test-client-id'
const CLIENT_SECRET = 'test-client-secret'
const STORED_ACCESS_TOKEN = 'stored-access-token'
const STORED_REFRESH_TOKEN = 'stored-refresh-token'
const REFRESHED_ACCESS_TOKEN = 'refreshed-access-token'

function modeOf(filePath: string): number {
  return fs.statSync(filePath).mode & 0o777
}

function assertFixture(actual: string | null, expected: string, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label} did not match the test fixture`)
  }
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = http.createServer()
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      if (!address || typeof address === 'string') {
        probe.close()
        reject(new Error('could not allocate a loopback port'))
        return
      }
      const {port} = address
      probe.close((err) => err ? reject(err) : resolve(port))
    })
    probe.on('error', reject)
  })
}

function callbackResult(port: number, pathAndQuery: string): Promise<{status: number, body: string}> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathAndQuery,
      method: 'GET',
      family: 4,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

function connectOutcome(host: string, port: number, family: 4 | 6): Promise<'open' | 'refused'> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({host, port, family})
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`timed out connecting to ${host}:${port}`))
    }, 1000)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.end()
      resolve('open')
    })
    socket.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer)
      if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' || err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') {
        resolve('refused')
        return
      }
      reject(err)
    })
  })
}

function externalIPv4(): string | null {
  const interfaces = os.networkInterfaces()
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = entry.family as string | number
      const isIpv4 = family === 'IPv4' || family === 4
      if (isIpv4 && !entry.internal) return entry.address
    }
  }
  return null
}

interface ProcListener {
  family: 'ipv4' | 'ipv6'
  local: string
}

function procListeners(port: number): ProcListener[] {
  const found: ProcListener[] = []
  const files: Array<[string, 'ipv4' | 'ipv6']> = [
    ['/proc/net/tcp', 'ipv4'],
    ['/proc/net/tcp6', 'ipv6'],
  ]
  for (const [file, family] of files) {
    if (!fs.existsSync(file)) continue
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').slice(1)
    for (const line of lines) {
      const parts = line.trim().split(/\s+/)
      const local = parts[1]
      const state = parts[3]
      if (!local || state !== '0A') continue
      const [ipHex, portHex] = local.split(':')
      if (parseInt(portHex, 16) !== port) continue
      found.push({family, local: ipHex.toUpperCase()})
    }
  }
  return found
}

describe('OAuth callback security', () => {
  let sandbox: sinon.SinonSandbox
  let vault: string
  let previousUmask: number
  const envBackup: Record<string, string | undefined> = {}

  beforeEach(() => {
    sandbox = sinon.createSandbox()
    vault = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-oauth-'))
    previousUmask = process.umask(0o000)
    envBackup.CAST_OAUTH_GOOGLE_CLIENT_ID = process.env.CAST_OAUTH_GOOGLE_CLIENT_ID
    envBackup.CAST_OAUTH_GOOGLE_CLIENT_SECRET = process.env.CAST_OAUTH_GOOGLE_CLIENT_SECRET
    process.env.CAST_OAUTH_GOOGLE_CLIENT_ID = CLIENT_ID
    process.env.CAST_OAUTH_GOOGLE_CLIENT_SECRET = CLIENT_SECRET
    sandbox.stub(db, 'getProviderConfig').returns(null)
    sandbox.stub(db, 'updateAgentMcpCredentials')
    sandbox.stub(console, 'log')
    sandbox.stub(console, 'error')
  })

  afterEach(() => {
    process.umask(previousUmask)
    sandbox.restore()
    if (vault) fs.rmSync(vault, {recursive: true, force: true})
    for (const [key, value] of Object.entries(envBackup)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('rejects an injected code, binds to loopback, and stores tokens mode 0600', async () => {
    const agent = 'oauth-state-agent'
    const agentDir = path.join(vault, agent)
    fs.mkdirSync(agentDir, {recursive: true})
    fs.chmodSync(vault, 0o777)
    fs.chmodSync(agentDir, 0o777)
    expect(modeOf(vault)).to.equal(0o777)
    expect(modeOf(agentDir)).to.equal(0o777)

    const port = await allocatePort()
    const post = sandbox.stub(axios, 'post').resolves({
      data: {
        access_token: STORED_ACCESS_TOKEN,
        refresh_token: STORED_REFRESH_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
      },
    })

    const manager = new OAuthManager({
      vaultRoot: vault,
      port,
      openBrowser: async (url) => {
        const auth = new URL(url)
        const state = auth.searchParams.get('state')
        if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state) || Buffer.from(state, 'base64url').length !== 32) {
          throw new Error(`OAuth state was not a 32-byte base64url value (length ${state ? state.length : 0})`)
        }
        expect(auth.searchParams.get('redirect_uri')).to.equal(`http://localhost:${port}/callback`)

        const listeners = procListeners(port)
        expect(listeners.length).to.be.greaterThan(0)
        for (const listener of listeners) {
          expect(listener.family).to.equal('ipv4')
          expect(listener.local).to.equal('0100007F')
        }
        expect(await connectOutcome('127.0.0.1', port, 4)).to.equal('open')
        expect(await connectOutcome('::1', port, 6)).to.equal('refused')
        const external = externalIPv4()
        if (external) {
          expect(await connectOutcome(external, port, 4)).to.equal('refused')
        }

        const wrongPath = await callbackResult(port, `/stolen?code=attacker-code&state=${encodeURIComponent(state)}`)
        expect(wrongPath.status).to.equal(404)
        expect(post.called).to.equal(false)

        const missingState = await callbackResult(port, '/callback?code=attacker-code')
        expect(missingState.status).to.equal(400)
        expect(missingState.body).to.equal('Invalid OAuth state')
        expect(missingState.body.includes(state)).to.equal(false)

        const shortState = await callbackResult(port, '/callback?code=attacker-code-short&state=short')
        expect(shortState.status).to.equal(400)
        expect(shortState.body).to.equal('Invalid OAuth state')

        const sameLength = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A')
        expect(Buffer.byteLength(sameLength)).to.equal(Buffer.byteLength(state))
        const wrongState = await callbackResult(port, `/callback?code=attacker-code-same&state=${encodeURIComponent(sameLength)}`)
        expect(wrongState.status).to.equal(400)
        expect(post.called).to.equal(false)

        const forgedError = await callbackResult(port, `/callback?error=access_denied&state=${encodeURIComponent(sameLength)}`)
        expect(forgedError.status).to.equal(400)
        expect(post.called).to.equal(false)

        const accepted = await callbackResult(port, `/callback?code=legit-code&state=${encodeURIComponent(state)}`)
        expect(accepted.status).to.equal(200)
        expect(accepted.body).to.include('Authentication Successful')
        expect(accepted.body.includes('legit-code')).to.equal(false)
        expect(post.called).to.equal(false)
        return true
      },
    })

    const credentials = await manager.startOAuthFlow(agent, 'gmail', 'google')

    expect(credentials.access_token).to.equal(STORED_ACCESS_TOKEN)
    expect(post.calledOnce).to.equal(true)
    const params = post.firstCall.args[1] as URLSearchParams
    expect(params).to.be.instanceOf(URLSearchParams)
    expect(params.get('code')).to.equal('legit-code')
    expect(params.get('grant_type')).to.equal('authorization_code')
    assertFixture(params.get('client_id'), CLIENT_ID, 'client id')
    assertFixture(params.get('client_secret'), CLIENT_SECRET, 'client secret')
    const posted = params.toString()
    expect(posted.includes('attacker-code')).to.equal(false)

    const credPath = path.join(agentDir, 'gmail-oauth.json')
    expect(modeOf(vault)).to.equal(0o700)
    expect(modeOf(agentDir)).to.equal(0o700)
    expect(modeOf(credPath)).to.equal(0o600)
    const stored = JSON.parse(fs.readFileSync(credPath, 'utf8')) as {access_token: string, refresh_token: string}
    expect(stored.access_token).to.equal(STORED_ACCESS_TOKEN)
    expect(stored.refresh_token).to.equal(STORED_REFRESH_TOKEN)
    expect(JSON.stringify(stored).includes('attacker-code')).to.equal(false)

    const update = db.updateAgentMcpCredentials as sinon.SinonStub
    expect(update.calledOnce).to.equal(true)
    expect(update.firstCall.args[0]).to.equal(agent)
    expect(update.firstCall.args[1]).to.equal('gmail')
  })

  it('issues a distinct 32-byte state for each login', async () => {
    const states: string[] = []
    sandbox.stub(axios, 'post').resolves({
      data: {access_token: STORED_ACCESS_TOKEN, refresh_token: STORED_REFRESH_TOKEN},
    })

    for (const login of [1, 2]) {
      const port = await allocatePort()
      const manager = new OAuthManager({
        vaultRoot: vault,
        port,
        openBrowser: async (url) => {
          const state = new URL(url).searchParams.get('state')
          if (!state || Buffer.from(state, 'base64url').length !== 32) {
            throw new Error(`OAuth state was not a 32-byte value (length ${state ? state.length : 0})`)
          }
          const previous = states[states.length - 1]
          states.push(state)
          if (previous) {
            const replay = await callbackResult(port, `/callback?code=attacker-code&state=${encodeURIComponent(previous)}`)
            expect(replay.status).to.equal(400)
          }
          const accepted = await callbackResult(port, `/callback?code=legit-code&state=${encodeURIComponent(state)}`)
          expect(accepted.status).to.equal(200)
          return true
        },
      })
      await manager.startOAuthFlow(`oauth-state-agent-${login}`, 'gmail', 'google')
    }

    expect(states).to.have.length(2)
    expect(states[0]).to.not.equal(states[1])
  })

  it('does not store tokens when the matching callback reports a provider error', async () => {
    const agent = 'oauth-error-agent'
    const port = await allocatePort()
    const post = sandbox.stub(axios, 'post').resolves({data: {access_token: STORED_ACCESS_TOKEN}})
    const payload = '<img src=x>'

    const manager = new OAuthManager({
      vaultRoot: vault,
      port,
      openBrowser: async (url) => {
        const state = new URL(url).searchParams.get('state')
        if (!state) throw new Error('missing OAuth state')
        const response = await callbackResult(
          port,
          `/callback?error=${encodeURIComponent(payload)}&state=${encodeURIComponent(state)}`,
        )
        expect(response.status).to.equal(200)
        expect(response.body).to.include('Authentication Failed')
        expect(response.body.includes('<img')).to.equal(false)
        expect(response.body).to.include('&lt;img')
        return true
      },
    })

    let thrown: Error | null = null
    try {
      await manager.startOAuthFlow(agent, 'gmail', 'google')
    } catch (err) {
      thrown = err as Error
    }

    expect(thrown).to.be.instanceOf(Error)
    expect(thrown?.message.startsWith('OAuth provider error:')).to.equal(true)
    expect(post.called).to.equal(false)
    expect(fs.existsSync(path.join(vault, agent, 'gmail-oauth.json'))).to.equal(false)
  })

  it('rewrites an existing credential file to mode 0600 when refreshing', async () => {
    const agent = 'oauth-refresh-agent'
    const agentDir = path.join(vault, agent)
    const credPath = path.join(agentDir, 'gmail-oauth.json')
    fs.mkdirSync(agentDir, {recursive: true})
    fs.chmodSync(vault, 0o777)
    fs.chmodSync(agentDir, 0o777)
    fs.writeFileSync(credPath, JSON.stringify({
      access_token: 'old-access-token',
      refresh_token: STORED_REFRESH_TOKEN,
      obtained_at: 1,
    }), {mode: 0o666})
    expect(modeOf(vault)).to.equal(0o777)
    expect(modeOf(agentDir)).to.equal(0o777)
    expect(modeOf(credPath)).to.equal(0o666)

    const post = sandbox.stub(axios, 'post').resolves({
      data: {
        access_token: REFRESHED_ACCESS_TOKEN,
        token_type: 'Bearer',
        expires_in: 3600,
      },
    })

    const manager = new OAuthManager({vaultRoot: vault})
    const updated = await manager.refreshToken(agent, 'gmail')

    expect(updated.access_token).to.equal(REFRESHED_ACCESS_TOKEN)
    expect(updated.refresh_token).to.equal(STORED_REFRESH_TOKEN)
    expect(modeOf(vault)).to.equal(0o700)
    expect(modeOf(agentDir)).to.equal(0o700)
    expect(modeOf(credPath)).to.equal(0o600)
    const stored = JSON.parse(fs.readFileSync(credPath, 'utf8')) as {access_token: string, refresh_token: string}
    expect(stored.access_token).to.equal(REFRESHED_ACCESS_TOKEN)
    expect(stored.refresh_token).to.equal(STORED_REFRESH_TOKEN)
    expect(post.calledOnce).to.equal(true)
    const params = post.firstCall.args[1] as URLSearchParams
    expect(params.get('grant_type')).to.equal('refresh_token')
    expect(params.get('refresh_token')).to.equal(STORED_REFRESH_TOKEN)
    assertFixture(params.get('client_id'), CLIENT_ID, 'client id')
    assertFixture(params.get('client_secret'), CLIENT_SECRET, 'client secret')
  })
})
