import {createRequire} from 'module'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {ensurePrivateDir, writePrivateFile} from './private-path'

const nodeRequire = createRequire(__filename)

interface KeytarApi {
  getPassword(service: string, account: string): Promise<string | null>
  setPassword(service: string, account: string, password: string): Promise<void>
  deletePassword(service: string, account: string): Promise<boolean>
  findCredentials(service: string): Promise<Array<{account: string; password: string}>>
}

let loadedKeytar: KeytarApi | null | undefined

function keytarLoadError(): Error {
  const error = new Error('keytar unavailable: MODULE_NOT_FOUND') as NodeJS.ErrnoException
  error.code = 'MODULE_NOT_FOUND'
  return error
}

/** Load keytar on first use. A missing module or libsecret is "no keychain". */
export function loadKeytar(): KeytarApi | null {
  if (loadedKeytar !== undefined) return loadedKeytar
  try {
    const loaded = nodeRequire('keytar') as KeytarApi & {default?: KeytarApi}
    const api = typeof loaded?.getPassword === 'function' ? loaded : loaded?.default
    if (!api || typeof api.getPassword !== 'function') {
      loadedKeytar = null
      return null
    }
    loadedKeytar = api
  } catch (error) {
    if (isKeytarLoadFailure(error)) {
      loadedKeytar = null
      return null
    }
    throw error
  }
  return loadedKeytar
}

function isKeytarLoadFailure(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as {code?: unknown}).code)
    : ''
  if (code === 'ERR_DLOPEN_FAILED' || code === 'MODULE_NOT_FOUND') return true
  const message = keychainErrorMessage(error)
  return message.includes('ERR_DLOPEN_FAILED')
    || message.includes('MODULE_NOT_FOUND')
    || message.includes('libsecret')
}

async function useKeytar<T>(fn: (api: KeytarApi) => Promise<T>): Promise<T> {
  const api = loadKeytar()
  if (!api) throw keytarLoadError()
  return fn(api)
}

const SERVICE_NAME = 'cast'
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/
const DEPLOYMENT_SHA = /^[a-z0-9]{6}$/
const INFERENCE_KEY = /^[a-z0-9-]+$/

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

/** True when the OS has no secret service, or keytar itself cannot be loaded. */
export function isKeychainUnavailable(error: unknown): boolean {
  if (isKeytarLoadFailure(error)) return true
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

  /** Model access key for an inference provider. Not a deploy token. */
  private inferenceTokenPath(providerKey: string): string | null {
    if (!INFERENCE_KEY.test(providerKey)) return null
    return path.join(path.resolve(this.tokenRoot()), 'inference', `${providerKey}.token`)
  }

  async getInferenceToken(providerKey: string): Promise<string | null> {
    const account = `inference:${providerKey}`
    const filePath = this.inferenceTokenPath(providerKey)
    try {
      const stored = await useKeytar(api => api.getPassword(SERVICE_NAME, account))
      if (stored) return stored
    } catch (error) {
      if (!isKeychainUnavailable(error)) {
        console.error('Failed to get inference token from keychain:', error)
      }
      return readTokenFile(filePath)
    }
    return readTokenFile(filePath)
  }

  async setInferenceToken(providerKey: string, token: string): Promise<'keychain' | 'file'> {
    const filePath = this.inferenceTokenPath(providerKey)
    if (!filePath) {
      throw new Error(`Unknown inference provider '${providerKey}'.`)
    }
    try {
      await useKeytar(api => api.setPassword(SERVICE_NAME, `inference:${providerKey}`, token))
      removeTokenFile(filePath)
      return 'keychain'
    } catch (error) {
      if (isKeychainUnavailable(error) && writeTokenFile(this.tokenRoot(), filePath, token)) return 'file'
      const message = keychainErrorMessage(error)
      throw new Error(`Failed to store the inference token: ${message}`)
    }
  }

  async getToken(agentName: string, options?: {silent?: boolean}): Promise<string | null> {
    try {
      const stored = await useKeytar(api => api.getPassword(SERVICE_NAME, `token:${agentName}`))
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
      await useKeytar(api => api.setPassword(SERVICE_NAME, `token:${agentName}`, token))
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
      if (await useKeytar(api => api.deletePassword(SERVICE_NAME, account))) stores.push('keychain')
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
      const removed = await useKeytar(api => api.deletePassword(SERVICE_NAME, `token:${agentName}`))
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
      const stored = await useKeytar(api => api.getPassword(SERVICE_NAME, `token:deployment:${deploymentSha}`))
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
      await useKeytar(api => api.setPassword(SERVICE_NAME, `token:deployment:${deploymentSha}`, token))
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
      return await useKeytar(api => api.getPassword(SERVICE_NAME, `credential:${agentName}:${server}`))
    } catch (error) {
      console.error('Failed to get credential from keychain:', error)
      return null
    }
  }

  async setCredential(agentName: string, server: string, credential: string): Promise<void> {
    try {
      await useKeytar(api => api.setPassword(SERVICE_NAME, `credential:${agentName}:${server}`, credential))
    } catch (error) {
      console.error('Failed to set credential in keychain:', error)
    }
  }

  async deleteCredential(agentName: string, server: string): Promise<boolean> {
    try {
      return await useKeytar(api => api.deletePassword(SERVICE_NAME, `credential:${agentName}:${server}`))
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
      const allCredentials = await useKeytar(api => api.findCredentials(SERVICE_NAME))
      for (const cred of allCredentials) {
        const account = cred.account
        if (account.startsWith(`token:${currentName}`)) {
          const token = await useKeytar(api => api.getPassword(SERVICE_NAME, account))
          if (token) {
            const newAccount = account.replace(`token:${currentName}`, `token:${newName}`)
            await useKeytar(api => api.setPassword(SERVICE_NAME, newAccount, token))
            await useKeytar(api => api.deletePassword(SERVICE_NAME, account))
          }
        } else if (account.startsWith(`credential:${currentName}:`)) {
          const credValue = await useKeytar(api => api.getPassword(SERVICE_NAME, account))
          if (credValue) {
            const newAccount = account.replace(`credential:${currentName}:`, `credential:${newName}:`)
            await useKeytar(api => api.setPassword(SERVICE_NAME, newAccount, credValue))
            await useKeytar(api => api.deletePassword(SERVICE_NAME, account))
          }
        }
      }
    } catch (error) {
      console.error('Failed to rename keychain entries:', error)
    }
  }
}

export const keychain = new KeychainManager()
