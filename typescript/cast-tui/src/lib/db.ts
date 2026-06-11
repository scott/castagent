import * as path from 'path'
import * as os from 'os'

const DB_PATH = path.join(os.homedir(), '.cast', 'cast.db')
const isBun = typeof (globalThis as any).Bun !== 'undefined'

export interface DbApi {
  listAgents(): any[]
  getAgent(name: string): any | null
  getLocalAgent(name: string): any | null
  getDeployment(name: string): any | null
  getDeploymentBySha(sha: string): any | null
  getActiveDeployment(name: string): any | null
  listDeployments(name: string): any[]
  listAllDeploymentsForAgent(name: string): any[]
  removeLocalAgent(name: string): void
  listAllReleases(): any[]
  listAllReleasesForAgent(name: string): any[]
  listReleases(name: string): any[]
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
      // Get most recent non-deleted deployment for agent name
      return db.query('SELECT * FROM deployments WHERE agent_name = ? AND deleted_at IS NULL ORDER BY deployed_at DESC LIMIT 1').get(name) || null
    },
    getDeploymentBySha(sha: string) {
      return db.query('SELECT * FROM deployments WHERE id = ? AND deleted_at IS NULL').get(sha) || null
    },
    getActiveDeployment(name: string) {
      return db.query('SELECT * FROM deployments WHERE agent_name = ? AND deleted_at IS NULL ORDER BY deployed_at DESC LIMIT 1').get(name) || null
    },
    listDeployments(name: string) {
      return db.query('SELECT * FROM deployments WHERE agent_name = ? AND deleted_at IS NULL ORDER BY deployed_at DESC').all(name)
    },
    listAllDeploymentsForAgent(name: string) {
      return db.query(`
        SELECT id as deployment_sha, provider, deployed_version, deployed_at, deployment_url
        FROM deployments
        WHERE agent_name = ? AND deleted_at IS NULL
        ORDER BY deployed_at DESC
      `).all(name)
    },
    removeLocalAgent(name: string) {
      db.query('DELETE FROM local_agents WHERE agent_name = ?').run(name)
    },
    listAllReleases() {
      // Get all releases with their most recent deployment info
      return db.query(`
        SELECT r.*, d.id as deployment_sha, d.provider, d.deployment_url, d.deployed_at as deployment_date
        FROM releases r
        LEFT JOIN (
          SELECT agent_name, deployed_version, id, provider, deployment_url, deployed_at,
                 ROW_NUMBER() OVER (PARTITION BY agent_name, deployed_version ORDER BY deployed_at DESC) as rn
          FROM deployments
          WHERE deleted_at IS NULL
        ) d ON r.agent_name = d.agent_name AND r.version = d.deployed_version AND d.rn = 1
        ORDER BY r.created_at DESC
      `).all()
    },
    listAllReleasesForAgent(name: string) {
      return db.query(`
        SELECT r.*, d.id as deployment_sha, d.provider, d.deployment_url, d.deployed_at as deployment_date
        FROM releases r
        LEFT JOIN (
          SELECT agent_name, deployed_version, id, provider, deployment_url, deployed_at,
                 ROW_NUMBER() OVER (PARTITION BY agent_name, deployed_version ORDER BY deployed_at DESC) as rn
          FROM deployments
          WHERE deleted_at IS NULL
        ) d ON r.agent_name = d.agent_name AND r.version = d.deployed_version AND d.rn = 1
        WHERE r.agent_name = ?
        ORDER BY r.created_at DESC
      `).all(name)
    },
    listReleases(name: string) {
      return db.query('SELECT * FROM releases WHERE agent_name = ? ORDER BY created_at DESC').all(name)
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
