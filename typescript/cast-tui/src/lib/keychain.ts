const isBun = typeof (globalThis as any).Bun !== 'undefined'

export interface KeychainApi {
  getToken(agentName: string): Promise<string | null>
  deleteToken(agentName: string): Promise<boolean>
}

let keychainInstance: KeychainApi | null = null

async function createNodeKeychain(): Promise<KeychainApi | null> {
  try {
    const mod = await import('../../../cast-cli/dist/lib/keychain.js')
    return mod.keychain
  } catch {
    return null
  }
}

export async function getKeychain(): Promise<KeychainApi | null> {
  if (keychainInstance) return keychainInstance

  if (isBun) {
    // keytar (native module) doesn't work in Bun.
    // Return null so callers can proceed without a token.
    return null
  }

  keychainInstance = await createNodeKeychain()
  return keychainInstance
}
