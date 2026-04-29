import * as keytar from 'keytar'
import * as crypto from 'crypto'

const SERVICE_NAME = 'cast'

export class KeychainManager {
  async getToken(agentName: string): Promise<string | null> {
    try {
      return await keytar.getPassword(SERVICE_NAME, `token:${agentName}`)
    } catch (error) {
      console.error('Failed to get token from keychain:', error)
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
}

export const keychain = new KeychainManager()
