import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as http from 'http'
import * as crypto from 'crypto'
import {spawn} from 'child_process'
import * as readline from 'readline'
import axios from 'axios'
import {db} from './sqlite'

const VAULT_DIR = path.join(os.homedir(), '.cast', 'vault')
const OAUTH_PORT = 34567
const OAUTH_REDIRECT_PATH = '/callback'
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000
/** IPv4 loopback only. A missing host would listen on every interface. */
const OAUTH_CALLBACK_HOST = '127.0.0.1'
const VAULT_DIR_MODE = 0o700
const CREDENTIAL_FILE_MODE = 0o600

export interface OAuthCredentials {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  obtained_at: number
  [key: string]: any
}

export interface OAuthManagerOptions {
  /** Credential root. Defaults to ~/.cast/vault. */
  vaultRoot?: string
  /** Callback port. Defaults to 34567. The bind address stays 127.0.0.1. */
  port?: number
  /** Replaces the browser launcher. The callback server is already listening. */
  openBrowser?: (url: string) => Promise<boolean>
}

interface ProviderOAuthConfig {
  authorizeUrl: string
  tokenUrl: string
  refreshUrl: string
  defaultScopes: string
  extraParams?: Record<string, string>
}

interface CallbackSession {
  listening: Promise<void>
  code: Promise<string>
  close: () => void
}

const PROVIDER_CONFIGS: Record<string, ProviderOAuthConfig> = {
  google: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    refreshUrl: 'https://oauth2.googleapis.com/token',
    defaultScopes: 'https://www.googleapis.com/auth/gmail.readonly',
    extraParams: {
      access_type: 'offline',
      prompt: 'consent',
    },
  },
  slack: {
    authorizeUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    refreshUrl: 'https://slack.com/api/oauth.v2.access',
    defaultScopes: 'chat:write,channels:read',
    extraParams: {},
  },
}

function generateState(): string {
  return crypto.randomBytes(32).toString('base64url')
}

/**
 * Constant-time compare of the issued state and the callback value.
 * A length mismatch still runs a compare so the fast path is the same shape.
 */
function statesMatch(expected: string, received: string | null): boolean {
  const expectedBuf = Buffer.from(expected)
  if (received == null) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  const receivedBuf = Buffer.from(received)
  if (receivedBuf.length !== expectedBuf.length) {
    crypto.timingSafeEqual(expectedBuf, expectedBuf)
    return false
  }
  return crypto.timingSafeEqual(expectedBuf, receivedBuf)
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function htmlPage(succeeded: boolean, detail: string): string {
  const title = succeeded ? 'Authentication Successful' : 'Authentication Failed'
  const message = succeeded ? 'You can close this window.' : `Error: ${escapeHtml(detail)}`
  return `<html><body style="font-family:sans-serif;text-align:center;padding-top:50px;">` +
    `<h1>${title}</h1>` +
    `<p>${message}</p>` +
    `</body></html>`
}

function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, {recursive: true, mode: VAULT_DIR_MODE})
  fs.chmodSync(dir, VAULT_DIR_MODE)
}

function writePrivateFile(filePath: string, contents: string): void {
  const fd = fs.openSync(filePath, 'w', CREDENTIAL_FILE_MODE)
  try {
    fs.writeFileSync(fd, contents)
  } finally {
    fs.closeSync(fd)
  }
  fs.chmodSync(filePath, CREDENTIAL_FILE_MODE)
}

/**
 * Open the user's default browser to the given URL.
 * Returns true if the command was spawned successfully.
 */
async function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const platform = process.platform
    let command: string
    let args: string[] = []

    if (platform === 'darwin') {
      command = 'open'
      args = [url]
    } else if (platform === 'win32') {
      command = 'cmd'
      args = ['/c', 'start', '', url]
    } else {
      command = 'xdg-open'
      args = [url]
    }

    const child = spawn(command, args, {detached: true, stdio: 'ignore'})
    let resolved = false

    const done = (success: boolean) => {
      if (!resolved) {
        resolved = true
        resolve(success)
      }
    }

    child.on('error', () => done(false))
    child.on('exit', (code) => done(code === 0))
    setTimeout(() => done(true), 1500)
  })
}

/**
 * Prompt the user for an authorization code via stdin.
 */
async function promptForCode(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  })

  return new Promise((resolve) => {
    rl.question('Enter authorization code: ', (code) => {
      rl.close()
      resolve(code.trim())
    })
  })
}

function listenForOAuthCode(state: string, port: number): CallbackSession {
  let server: http.Server | null = null
  let settled = false
  let listeningSettled = false
  let resolveListening: () => void = () => {}
  let rejectListening: (error: Error) => void = () => {}
  let resolveCode: (code: string) => void = () => {}
  let rejectCode: (error: Error) => void = () => {}

  const listening = new Promise<void>((resolve, reject) => {
    resolveListening = resolve
    rejectListening = reject
  })
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })

  let timer: NodeJS.Timeout
  const finish = (error?: Error, receivedCode?: string): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    if (server) {
      const current = server
      server = null
      current.close()
    }
    if (!listeningSettled) {
      listeningSettled = true
      if (error) rejectListening(error)
      else resolveListening()
    }
    if (error) rejectCode(error)
    else resolveCode(receivedCode ?? '')
  }

  timer = setTimeout(() => {
    finish(new Error('OAuth flow timed out after 5 minutes'))
  }, OAUTH_TIMEOUT_MS)
  timer.unref()

  const rejectRequest = (res: http.ServerResponse, status: number, body: string): void => {
    res.writeHead(status, {'Content-Type': 'text/plain'})
    res.end(body)
  }

  server = http.createServer((req, res) => {
    if (settled) {
      rejectRequest(res, 400, 'OAuth callback is closed')
      return
    }
    if (!req.url || req.url.length > 4096) {
      rejectRequest(res, 400, 'Bad Request')
      return
    }

    let url: URL
    try {
      url = new URL(req.url, `http://${OAUTH_CALLBACK_HOST}:${port}`)
    } catch {
      rejectRequest(res, 400, 'Bad Request')
      return
    }

    if (url.pathname !== OAUTH_REDIRECT_PATH) {
      rejectRequest(res, 404, 'Not Found')
      return
    }

    if (!statesMatch(state, url.searchParams.get('state'))) {
      rejectRequest(res, 400, 'Invalid OAuth state')
      return
    }

    const receivedCode = url.searchParams.get('code')
    const receivedError = url.searchParams.get('error')
    const safeError = (receivedError ?? '').replace(/[\r\n]/g, ' ').slice(0, 200)

    res.writeHead(200, {'Content-Type': 'text/html'})
    res.end(htmlPage(!receivedError, safeError))

    if (receivedError) {
      finish(new Error(`OAuth provider error: ${safeError}`))
    } else if (receivedCode) {
      finish(undefined, receivedCode)
    } else {
      finish(new Error('No authorization code received in callback'))
    }
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    finish(new Error(`Failed to start OAuth callback server: ${err.message}`))
  })

  server.listen(port, OAUTH_CALLBACK_HOST, () => {
    if (settled || listeningSettled) return
    listeningSettled = true
    console.log(`OAuth callback server listening on http://${OAUTH_CALLBACK_HOST}:${port}${OAUTH_REDIRECT_PATH}`)
    resolveListening()
  })

  return {
    listening,
    code: codePromise,
    close: () => finish(new Error('OAuth callback server closed')),
  }
}

export class OAuthManager {
  constructor(private readonly options: OAuthManagerOptions = {}) {}

  private vaultRoot(): string {
    return this.options.vaultRoot ?? VAULT_DIR
  }

  private callbackPort(): number {
    return this.options.port ?? OAUTH_PORT
  }

  private credentialsPath(agentName: string, serverName: string): string {
    return path.join(this.vaultRoot(), agentName, `${serverName}-oauth.json`)
  }

  private ensureVault(agentName: string): void {
    const root = this.vaultRoot()
    ensurePrivateDir(root)
    ensurePrivateDir(path.join(root, agentName))
  }

  private storeCredentials(agentName: string, serverName: string, credentials: OAuthCredentials): string {
    this.ensureVault(agentName)
    const credPath = this.credentialsPath(agentName, serverName)
    writePrivateFile(credPath, JSON.stringify(credentials, null, 2))
    return credPath
  }

  private getOAuthAppCredentials(provider: string): {clientId: string; clientSecret: string; redirectUri: string} {
    // 1. Check SQLite provider_configs
    const dbConfig = db.getProviderConfig(provider)
    if (dbConfig && dbConfig.client_id && dbConfig.client_secret) {
      return {
        clientId: dbConfig.client_id,
        clientSecret: dbConfig.client_secret,
        redirectUri: dbConfig.redirect_uri || `http://localhost:${this.callbackPort()}${OAUTH_REDIRECT_PATH}`,
      }
    }

    // 2. Check environment variables
    const envPrefix = `CAST_OAUTH_${provider.toUpperCase()}_`
    const envClientId = process.env[`${envPrefix}CLIENT_ID`]
    const envClientSecret = process.env[`${envPrefix}CLIENT_SECRET`]
    const envRedirectUri = process.env[`${envPrefix}REDIRECT_URI`]

    if (envClientId && envClientSecret) {
      return {
        clientId: envClientId,
        clientSecret: envClientSecret,
        redirectUri: envRedirectUri || `http://localhost:${this.callbackPort()}${OAUTH_REDIRECT_PATH}`,
      }
    }

    throw new Error(
      `OAuth app credentials for provider '${provider}' not found. ` +
      `Configure via: db.setProviderConfig('${provider}', {client_id: '...', client_secret: '...'}) ` +
      `or environment variables ${envPrefix}CLIENT_ID and ${envPrefix}CLIENT_SECRET`
    )
  }

  /**
   * Start the OAuth flow for a given agent/server/provider.
   * 1. Starts a temporary HTTP server on 127.0.0.1 port 34567
   * 2. Opens the browser to the provider's OAuth URL, including a random state
   * 3. Accepts the callback only when its state matches, at 127.0.0.1:34567/callback
   * 4. Exchanges the code for tokens
   * 5. Stores credentials in ~/.cast/vault/<agentName>/<serverName>-oauth.json mode 0600
   * 6. Falls back to manual code entry if the browser cannot be opened
   */
  async startOAuthFlow(agentName: string, serverName: string, provider: string): Promise<OAuthCredentials> {
    const providerConfig = PROVIDER_CONFIGS[provider]
    if (!providerConfig) {
      throw new Error(
        `Unsupported OAuth provider: ${provider}. Supported: ${Object.keys(PROVIDER_CONFIGS).join(', ')}`
      )
    }

    const {clientId, clientSecret, redirectUri} = this.getOAuthAppCredentials(provider)
    const state = generateState()
    const port = this.callbackPort()

    // Build authorization URL
    const authUrl = new URL(providerConfig.authorizeUrl)
    authUrl.searchParams.set('client_id', clientId)
    authUrl.searchParams.set('redirect_uri', redirectUri)
    authUrl.searchParams.set('response_type', 'code')
    authUrl.searchParams.set('scope', providerConfig.defaultScopes)
    authUrl.searchParams.set('state', state)

    for (const [key, value] of Object.entries(providerConfig.extraParams || {})) {
      authUrl.searchParams.set(key, value)
    }

    const session = listenForOAuthCode(state, port)
    // Abandoning the callback (manual entry, or a listen failure) rejects this promise.
    session.code.catch(() => {})

    const launchBrowser = this.options.openBrowser ?? openBrowser
    let code = ''

    try {
      await session.listening

      const browserOpened = await launchBrowser(authUrl.toString())
      if (!browserOpened) {
        console.log('Unable to open browser automatically.')
        console.log('Please visit the following URL and authorize the application:')
        console.log(authUrl.toString())

        const manualPromise = promptForCode().then(entered => ({source: 'manual' as const, code: entered}))
        const callbackRace = session.code.then(received => ({source: 'callback' as const, code: received}))

        try {
          const result = await Promise.race([callbackRace, manualPromise])
          code = result.code
          if (result.source === 'manual') {
            callbackRace.catch(() => {})
            session.close()
          }
        } catch {
          callbackRace.catch(() => {})
          code = await promptForCode()
          session.close()
        }
      } else {
        code = await session.code
      }
    } finally {
      session.close()
    }

    if (!code) {
      throw new Error('No authorization code received')
    }

    // Exchange code for tokens
    console.log('Exchanging authorization code for tokens...')
    const tokenResponse = await axios.post(
      providerConfig.tokenUrl,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    )

    const credentials: OAuthCredentials = {
      ...tokenResponse.data,
      obtained_at: Date.now(),
    }

    // Store credentials
    const credPath = this.storeCredentials(agentName, serverName, credentials)

    // Update SQLite credentials_path
    try {
      const relativeCredPath = path.relative(path.join(os.homedir(), '.cast'), credPath)
      db.updateAgentMcpCredentials(agentName, serverName, relativeCredPath)
    } catch (err) {
      console.error('Failed to update SQLite credentials_path:', err)
    }

    console.log(`OAuth credentials stored for ${serverName}`)
    return credentials
  }

  /**
   * Read stored OAuth credentials for a given agent/server.
   */
  getCredentials(agentName: string, serverName: string): OAuthCredentials | null {
    const credPath = this.credentialsPath(agentName, serverName)
    if (!fs.existsSync(credPath)) {
      return null
    }

    const content = fs.readFileSync(credPath, 'utf8')
    try {
      return JSON.parse(content) as OAuthCredentials
    } catch (e) {
      console.error('Failed to parse stored credentials:', e)
      return null
    }
  }

  /**
   * Refresh an expired access token using the stored refresh token.
   */
  async refreshToken(agentName: string, serverName: string): Promise<OAuthCredentials> {
    const credentials = this.getCredentials(agentName, serverName)
    if (!credentials) {
      throw new Error(`No credentials found for ${serverName} on agent ${agentName}`)
    }

    if (!credentials.refresh_token) {
      throw new Error(`No refresh token available for ${serverName}. Please re-run the OAuth flow.`)
    }

    // Infer provider from serverName or stored provider info
    let provider = 'google'
    if (serverName.toLowerCase().includes('slack')) {
      provider = 'slack'
    }

    const providerConfig = PROVIDER_CONFIGS[provider]
    if (!providerConfig) {
      throw new Error(`Cannot refresh token: unknown provider for ${serverName}`)
    }

    const {clientId, clientSecret} = this.getOAuthAppCredentials(provider)

    console.log(`Refreshing access token for ${serverName}...`)
    const refreshResponse = await axios.post(
      providerConfig.refreshUrl,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: credentials.refresh_token,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    )

    const newCredentials: OAuthCredentials = {
      ...credentials,
      ...refreshResponse.data,
      obtained_at: Date.now(),
    }

    // Preserve refresh_token if not returned by provider
    if (!newCredentials.refresh_token && credentials.refresh_token) {
      newCredentials.refresh_token = credentials.refresh_token
    }

    this.storeCredentials(agentName, serverName, newCredentials)

    console.log(`Access token refreshed for ${serverName}`)
    return newCredentials
  }
}

export const oauthManager = new OAuthManager()
