import * as path from 'path'
import * as os from 'os'

const DB_PATH = path.join(os.homedir(), '.cast', 'cast.db')
const isBun = typeof (globalThis as any).Bun !== 'undefined'

export interface DbApi {
  listAgents(): any[]
  getAgent(name: string): any | null
  getLocalAgent(name: string): any | null
  getDeployment(name: string): any | null
  removeLocalAgent(name: string): void
}

let dbInstance: DbApi | null = null

async function createBunDb(): Promise<DbApi> {
  // @ts-ignore - bun:sqlite is a Bun built-in, not available in Node.js
  const {Database} = await import('bun:sqlite')
  const db = new Database(DB_PATH)

  return {
    listAgents() {
      return db.query('SELECT * FROM agents ORDER BY created_at DESC').all()
    },
    getAgent(name: string) {
      return db.query('SELECT * FROM agents WHERE name = ?').get(name) || null
    },
    getLocalAgent(name: string) {
      return db.query('SELECT * FROM local_agents WHERE agent_name = ?').get(name) || null
    },
    getDeployment(name: string) {
      return db.query('SELECT * FROM deployments WHERE agent_name = ?').get(name) || null
    },
    removeLocalAgent(name: string) {
      db.query('DELETE FROM local_agents WHERE agent_name = ?').run(name)
    },
  }
}

async function createNodeDb(): Promise<DbApi> {
  const mod = await import('../../../cast-cli/dist/lib/sqlite.js')
  return mod.db
}

export async function getDb(): Promise<DbApi | null> {
  if (dbInstance) return dbInstance

  try {
    if (isBun) {
      dbInstance = await createBunDb()
    } else {
      dbInstance = await createNodeDb()
    }
    return dbInstance
  } catch (err) {
    console.error('Failed to initialize database:', err)
    return null
  }
}
