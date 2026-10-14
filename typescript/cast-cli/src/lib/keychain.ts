import * as keytar from 'keytar'
import * as crypto from 'crypto'

const SERVICE_NAME = 'cast'

export type AgentTokenRemoval = {
  result: 'removed' | 'absent' | 'unavailable' | 'failed'
  message?: string
}

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

export class KeychainManager {
  async getToken(agentName: string, options?: {silent?: boolean}): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE_NAME, `token:${agentName}`)
    } catch (error) {
      if (!options?.silent) {
        console.error('Failed to get token from keychain:', error)
      }
      return null
    }
  }

  async setToken(agentName: string, token: string): Promise<void> {
    try {
      await keytar.setPassword(SERVICE_NAME, `token:${agentName}`, token)
    } catch (error) {
      console.error('Failed to set token in keychain:', error)
    }
  }

  async deleteToken(agentName: string): Promise<boolean> {
    try {
      return await keytar.deletePassword(SERVICE_NAME, `token:${agentName}`)
    } catch (error) {
      console.error('Failed to delete token from keychain:', error)
      return false
    }
  }

  /**
   * Delete an agent token and report what happened, without logging.
   * `cast delete` uses this so a missing keychain is one accurate line.
   */
  async removeAgentToken(agentName: string): Promise<AgentTokenRemoval> {
    try {
      const removed = await keytar.deletePassword(SERVICE_NAME, `token:${agentName}`)
      return {result: removed ? 'removed' : 'absent'}
    } catch (error) {
      const message = keychainErrorMessage(error)
      if (isKeychainUnavailable(error)) return {result: 'unavailable', message}
      return {result: 'failed', message}
    }
  }

  /** Token baked into one deployment. A later deploy of the same agent must not replace it. */
  async getDeploymentToken(deploymentSha: string): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE_NAME, `token:deployment:${deploymentSha}`)
    } catch (error) {
      console.error('Failed to get deployment token from keychain:', error)
      return null
    }
  }

  async setDeploymentToken(deploymentSha: string, token: string): Promise<void> {
    try {
      await keytar.setPassword(SERVICE_NAME, `token:deployment:${deploymentSha}`, token)
    } catch (error) {
      console.error('Failed to set deployment token in keychain:', error)
    }
  }

  async deleteDeploymentToken(deploymentSha: string): Promise<boolean> {
    try {
      return await keytar.deletePassword(SERVICE_NAME, `token:deployment:${deploymentSha}`)
    } catch (error) {
      console.error('Failed to delete deployment token from keychain:', error)
      return false
    }
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
