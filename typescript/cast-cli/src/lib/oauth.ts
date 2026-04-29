import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as http from 'http'
import {spawn} from 'child_process'
import * as readline from 'readline'
import axios from 'axios'
import {db} from './sqlite'

const VAULT_DIR = path.join(os.homedir(), '.cast', 'vault')
const OAUTH_PORT = 34567
const OAUTH_REDIRECT_PATH = '/callback'
const OAUTH_TIMEOUT_MS = 5 * 60 * 1000

export interface OAuthCredentials {
  access_token: string
  refresh_token?: string
  expires_in?: number
  token_type?: string
  scope?: string
  obtained_at: number
  [key: string]: any
}

interface ProviderOAuthConfig {
  authorizeUrl: string
  tokenUrl: string
  refreshUrl: string
  defaultScopes: string
  extraParams?: Record<string, string>
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

function getVaultDir(agentName: string): string {
  return path.join(VAULT_DIR, agentName)
}

function getCredentialsPath(agentName: string, serverName: string): string {
  return path.join(getVaultDir(agentName), `${serverName}-oauth.json`)
}

function ensureVaultDir(agentName: string): void {
  const dir = getVaultDir(agentName)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, {recursive: true})
  }
}

function generateState(): string {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15)
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

export class OAuthManager {
  private getOAuthAppCredentials(provider: string): {clientId: string; clientSecret: string; redirectUri: string} {
    // 1. Check SQLite provider_configs
    const dbConfig = db.getProviderConfig(provider)
    if (dbConfig && dbConfig.client_id && dbConfig.client_secret) {
      return {
        clientId: dbConfig.client_id,
        clientSecret: dbConfig.client_secret,
        redirectUri: dbConfig.redirect_uri || `http://localhost:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`,
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
        redirectUri: envRedirectUri || `http://localhost:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`,
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
   * 1. Starts a temporary HTTP server on port 34567
   * 2. Opens the browser to the provider's OAuth URL
   * 3. Captures the callback at localhost:34567/callback
   * 4. Exchanges the code for tokens
   * 5. Stores credentials in ~/.cast/vault/<agentName>/<serverName>-oauth.json
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

    // Start temporary HTTP server to capture callback
    let server: http.Server | null = null
    let serverResolved = false

    const cleanup = () => {
      if (server) {
        server.close()
        server = null
      }
    }

    const callbackPromise = new Promise<string>((resolve, reject) => {
      server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400, {'Content-Type': 'text/plain'})
          res.end('Bad Request')
          return
        }

        const url = new URL(req.url, `http://localhost:${OAUTH_PORT}`)
        if (url.pathname === OAUTH_REDIRECT_PATH) {
          const receivedCode = url.searchParams.get('code')
          const receivedError = url.searchParams.get('error')

          res.writeHead(200, {'Content-Type': 'text/html'})
          res.end(
            `<html><body style="font-family:sans-serif;text-align:center;padding-top:50px;">` +
            `<h1>${receivedError ? 'Authentication Failed' : 'Authentication Successful'}</h1>` +
            `<p>${receivedError ? `Error: ${receivedError}` : 'You can close this window.'}</p>` +
            `</body></html>`
          )

          cleanup()
          serverResolved = true

          if (receivedError) {
            reject(new Error(`OAuth provider error: ${receivedError}`))
          } else if (receivedCode) {
            resolve(receivedCode)
          } else {
            reject(new Error('No authorization code received in callback'))
          }
        } else {
          res.writeHead(404, {'Content-Type': 'text/plain'})
          res.end('Not Found')
        }
      })

      server.listen(OAUTH_PORT, () => {
        console.log(`OAuth callback server listening on http://localhost:${OAUTH_PORT}${OAUTH_REDIRECT_PATH}`)
      })

      server.on('error', (err) => {
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`))
        cleanup()
        serverResolved = true
      })

      // Timeout after 5 minutes
      setTimeout(() => {
        if (!serverResolved) {
          reject(new Error('OAuth flow timed out after 5 minutes'))
          cleanup()
          serverResolved = true
        }
      }, OAUTH_TIMEOUT_MS)
    })

    // Open browser
    const browserOpened = await openBrowser(authUrl.toString())

    let code: string
    if (!browserOpened) {
      console.log('Unable to open browser automatically.')
      console.log('Please visit the following URL and authorize the application:')
      console.log(authUrl.toString())

      // Race between callback and manual entry
      const manualPromise = promptForCode().then(c => ({source: 'manual' as const, code: c}))
      const callbackRace = callbackPromise.then(c => ({source: 'callback' as const, code: c}))

      try {
        const result = await Promise.race([callbackRace, manualPromise])
        code = result.code
        if (result.source === 'manual') {
          cleanup()
          // Suppress unhandled rejection if callback eventually times out
          callbackPromise.catch(() => {})
        }
      } catch (e) {
        // If callback errored/timed out, fallback to manual
        code = await promptForCode()
        cleanup()
        callbackPromise.catch(() => {})
      }
    } else {
      code = await callbackPromise
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
    ensureVaultDir(agentName)
    const credPath = getCredentialsPath(agentName, serverName)
    fs.writeFileSync(credPath, JSON.stringify(credentials, null, 2))

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
    const credPath = getCredentialsPath(agentName, serverName)
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

    const credPath = getCredentialsPath(agentName, serverName)
    fs.writeFileSync(credPath, JSON.stringify(newCredentials, null, 2))

    console.log(`Access token refreshed for ${serverName}`)
    return newCredentials
  }
}

export const oauthManager = new OAuthManager()
