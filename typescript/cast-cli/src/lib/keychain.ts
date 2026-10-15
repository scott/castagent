import * as keytar from 'keytar'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {ensurePrivateDir, writePrivateFile} from './private-path'

const SERVICE_NAME = 'cast'
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const DEPLOYMENT_SHA = /^[a-z0-9]{6}$/

export type AgentTokenRemoval = {
  result: 'removed' | 'absent' | 'unavailable' | 'failed'
  message?: string
}

export type TokenStore = 'keychain' | 'file'

/** `stores` lists each place that actually held a token. Empty when nothing was deleted. */
export interface TokenDeleteResult {
  removed: boolean
  stores: TokenStore[]
}

const FILE_TOKEN_REMOVED = 'Removed bearer token from ~/.cast/tokens.'

function keychainErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as {message?: unknown}).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** True when the OS has no secret service for keytar to talk to. */
export function isKeychainUnavailable(error: unknown): boolean {
  const message = keychainErrorMessage(error)
  return message.includes('org.freedesktop.secrets')
    || message.includes('Cannot autolaunch D-Bus')
    || message.includes('dbus-launch')
}

function defaultTokenRoot(): string {
  return path.join(os.homedir(), '.cast', 'tokens')
}

function castHomeDir(): string {
  return path.resolve(path.join(os.homedir(), '.cast'))
}

/** Token directories live under ~/.cast. Tighten that home when they do. */
function ensureTokenStoreDirs(root: string, fileDir: string): void {
  const resolvedRoot = path.resolve(root)
  const home = castHomeDir()
  if (resolvedRoot === home || resolvedRoot.startsWith(home + path.sep)) {
    ensurePrivateDir(home)
  }
  ensurePrivateDir(resolvedRoot)
  const resolvedDir = path.resolve(fileDir)
  if (resolvedDir !== resolvedRoot) ensurePrivateDir(resolvedDir)
}

function readTokenFile(filePath: string | null): string | null {
  if (!filePath) return null
  try {
    if (!fs.existsSync(filePath)) return null
    const value = fs.readFileSync(filePath, 'utf8').replace(/\n$/, '')
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function writeTokenFile(root: string, filePath: string | null, token: string): boolean {
  if (!filePath || !token) return false
  ensureTokenStoreDirs(root, path.dirname(filePath))
  writePrivateFile(filePath, token)
  return true
}

function removeTokenFile(filePath: string | null): boolean {
  if (!filePath || !fs.existsSync(filePath)) return false
  fs.rmSync(filePath, {force: true})
  return true
}

export class KeychainManager {
  constructor(private tokensDir?: string) {}

  private tokenRoot(): string {
    return this.tokensDir ?? defaultTokenRoot()
  }

  private agentTokenPath(agentName: string): string | null {
    if (!AGENT_NAME.test(agentName)) return null
    return path.join(path.resolve(this.tokenRoot()), `${agentName}.token`)
  }

  private deploymentTokenPath(deploymentSha: string): string | null {
    if (!DEPLOYMENT_SHA.test(deploymentSha)) return null
    return path.join(path.resolve(this.tokenRoot()), 'deployments', `${deploymentSha}.token`)
  }

  async getToken(agentName: string, options?: {silent?: boolean}): Promise<string | null> {
    try {
      const stored = await keytar.getPassword(SERVICE_NAME, `token:${agentName}`)
      if (stored) return stored
    } catch (error) {
      if (!isKeychainUnavailable(error)) {
        if (!options?.silent) console.error('Failed to get token from keychain:', error)
        return null
      }
      const fromFile = readTokenFile(this.agentTokenPath(agentName))
      if (fromFile) return fromFile
      if (!options?.silent) console.error('Failed to get token from keychain:', error)
      return null
    }
    return readTokenFile(this.agentTokenPath(agentName))
  }

  async setToken(agentName: string, token: string): Promise<void> {
    const filePath = this.agentTokenPath(agentName)
    try {
      await keytar.setPassword(SERVICE_NAME, `token:${agentName}`, token)
      removeTokenFile(filePath)
    } catch (error) {
      if (isKeychainUnavailable(error) && writeTokenFile(this.tokenRoot(), filePath, token)) return
      console.error('Failed to set token in keychain:', error)
    }
  }

  private async deleteStoredToken(
    account: string,
    filePath: string | null,
    failureLabel: string,
  ): Promise<TokenDeleteResult> {
    const stores: TokenStore[] = []
    if (removeTokenFile(filePath)) stores.push('file')
    try {
      if (await keytar.deletePassword(SERVICE_NAME, account)) stores.push('keychain')
    } catch (error) {
      if (!isKeychainUnavailable(error)) {
        console.error(failureLabel, error)
      }
    }
    return {removed: stores.length > 0, stores}
  }

  async deleteToken(agentName: string): Promise<TokenDeleteResult> {
    return this.deleteStoredToken(
      `token:${agentName}`,
      this.agentTokenPath(agentName),
      'Failed to delete token from keychain:',
    )
  }

  /**
   * Delete an agent token and report what happened, without logging.
   * `cast delete` uses this so a missing keychain is one accurate line.
   */
  async removeAgentToken(agentName: string): Promise<AgentTokenRemoval> {
    const fileRemoved = removeTokenFile(this.agentTokenPath(agentName))
    try {
      const removed = await keytar.deletePassword(SERVICE_NAME, `token:${agentName}`)
      if (removed) return {result: 'removed'}
      if (fileRemoved) return {result: 'removed', message: FILE_TOKEN_REMOVED}
      return {result: 'absent'}
    } catch (error) {
      const message = keychainErrorMessage(error)
      if (isKeychainUnavailable(error)) {
        if (fileRemoved) return {result: 'removed', message: FILE_TOKEN_REMOVED}
        return {result: 'unavailable', message}
      }
      return {result: 'failed', message}
    }
  }

  /** Token baked into one deployment. A later deploy of the same agent must not replace it. */
  async getDeploymentToken(deploymentSha: string): Promise<string | null> {
    try {
      const stored = await keytar.getPassword(SERVICE_NAME, `token:deployment:${deploymentSha}`)
      if (stored) return stored
    } catch (error) {
      if (!isKeychainUnavailable(error)) {
        console.error('Failed to get deployment token from keychain:', error)
        return null
      }
      const fromFile = readTokenFile(this.deploymentTokenPath(deploymentSha))
      if (fromFile) return fromFile
      console.error('Failed to get deployment token from keychain:', error)
      return null
    }
    return readTokenFile(this.deploymentTokenPath(deploymentSha))
  }

  async setDeploymentToken(deploymentSha: string, token: string): Promise<void> {
    const filePath = this.deploymentTokenPath(deploymentSha)
    try {
      await keytar.setPassword(SERVICE_NAME, `token:deployment:${deploymentSha}`, token)
      removeTokenFile(filePath)
    } catch (error) {
      if (isKeychainUnavailable(error) && writeTokenFile(this.tokenRoot(), filePath, token)) return
      console.error('Failed to set deployment token in keychain:', error)
    }
  }

  async deleteDeploymentToken(deploymentSha: string): Promise<TokenDeleteResult> {
    return this.deleteStoredToken(
      `token:deployment:${deploymentSha}`,
      this.deploymentTokenPath(deploymentSha),
      'Failed to delete deployment token from keychain:',
    )
  }

  generateToken(): string {
    return crypto.randomBytes(32).toString('base64')
  }

  hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex')
  }

  async getCredential(agentName: string, server: string): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE_NAME, `credential:${agentName}:${server}`)
    } catch (error) {
      console.error('Failed to get credential from keychain:', error)
      return null
    }
  }

  async setCredential(agentName: string, server: string, credential: string): Promise<void> {
    try {
      await keytar.setPassword(SERVICE_NAME, `credential:${agentName}:${server}`, credential)
    } catch (error) {
      console.error('Failed to set credential in keychain:', error)
    }
  }

  async deleteCredential(agentName: string, server: string): Promise<boolean> {
    try {
      return await keytar.deletePassword(SERVICE_NAME, `credential:${agentName}:${server}`)
    } catch (error) {
      console.error('Failed to delete credential from keychain:', error)
      return false
    }
  }

  async renameAgentEntries(currentName: string, newName: string): Promise<void> {
    const from = this.agentTokenPath(currentName)
    const to = this.agentTokenPath(newName)
    if (from && to && fs.existsSync(from)) {
      ensureTokenStoreDirs(this.tokenRoot(), path.dirname(to))
      fs.renameSync(from, to)
      const mode = fs.statSync(to).mode & 0o777
      if (mode !== 0o600) fs.chmodSync(to, 0o600)
    }
    try {
      const allCredentials = await keytar.findCredentials(SERVICE_NAME)
      for (const cred of allCredentials) {
        const account = cred.account
        if (account.startsWith(`token:${currentName}`)) {
          const token = await keytar.getPassword(SERVICE_NAME, account)
          if (token) {
            const newAccount = account.replace(`token:${currentName}`, `token:${newName}`)
            await keytar.setPassword(SERVICE_NAME, newAccount, token)
            await keytar.deletePassword(SERVICE_NAME, account)
          }
        } else if (account.startsWith(`credential:${currentName}:`)) {
          const credValue = await keytar.getPassword(SERVICE_NAME, account)
          if (credValue) {
            const newAccount = account.replace(`credential:${currentName}:`, `credential:${newName}:`)
            await keytar.setPassword(SERVICE_NAME, newAccount, credValue)
            await keytar.deletePassword(SERVICE_NAME, account)
          }
        }
      }
    } catch (error) {
      console.error('Failed to rename keychain entries:', error)
    }
  }
}

export const keychain = new KeychainManager()
