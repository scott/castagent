import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as crypto from 'crypto'

const CAST_DIR = path.join(os.homedir(), '.cast')
const DB_PATH = path.join(CAST_DIR, 'cast.db')

// Generate deployment SHA
export function generateDeploymentSha(agentName: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(agentName + Date.now().toString() + crypto.randomBytes(16).toString('hex'))
  return hash.digest('hex').substring(0, 6).toLowerCase()
}

// Generate SHA for existing deployment (used in migration)
function generateShaFromExistingData(agentName: string, deployedAt: string, provider: string): string {
  const hash = crypto.createHash('sha256')
  hash.update(agentName + deployedAt + provider)
  return hash.digest('hex').substring(0, 6).toLowerCase()
}

export class CastDatabase {
  private db: Database.Database

  constructor() {
    // Ensure cast directory exists
    if (!fs.existsSync(CAST_DIR)) {
      fs.mkdirSync(CAST_DIR, {recursive: true})
    }

    this.db = new Database(DB_PATH)
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        name TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        agent_yaml_path TEXT,
        last_run_at DATETIME,
        run_count INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS agent_mcp (
        agent_name TEXT,
        server_name TEXT,
        config_path TEXT,
        credentials_path TEXT,
        PRIMARY KEY (agent_name, server_name)
      );

      CREATE TABLE IF NOT EXISTS provider_configs (
        provider TEXT PRIMARY KEY,
        config_json TEXT
      );

      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        provider TEXT,
        deployment_url TEXT,
        auth_token_hash TEXT,
        deployed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_connected_at DATETIME,
        volume_id TEXT,
        volume_config TEXT,
        deployed_version TEXT,
        deleted_at DATETIME,
        FOREIGN KEY (agent_name) REFERENCES agents(name)
      );

      CREATE INDEX IF NOT EXISTS idx_deployments_agent_name ON deployments(agent_name);

      CREATE TABLE IF NOT EXISTS local_agents (
        agent_name TEXT PRIMARY KEY,
        pid INTEGER,
        port INTEGER,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        stopped_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS releases (
        agent_name TEXT,
        version TEXT,
        change_number INTEGER,
        message TEXT,
        changelog TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        tarball_path TEXT,
        PRIMARY KEY (agent_name, version)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT,
        agent_name TEXT NOT NULL,
        mode TEXT,
        ui_mode TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        message_count INTEGER DEFAULT 0,
        parent_session_id TEXT,
        first_user_message TEXT,
        last_user_message TEXT,
        json_path TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_agent_name ON sessions(agent_name);
      CREATE INDEX IF NOT EXISTS idx_sessions_updated_at ON sessions(updated_at DESC);
    `)
    this.runMigrations()
  }

  private runMigrations(): void {
    // Migration: Check if deployments table uses old schema (agent_name PRIMARY KEY)
    const stmt = this.db.prepare('PRAGMA table_info(deployments)')
    const columns = stmt.all() as any[]
    const hasIdColumn = columns.some((col: any) => col.name === 'id')
    const hasAgentNamePrimaryKey = columns.some((col: any) => col.name === 'agent_name' && col.pk === 1)

    if (!hasIdColumn && hasAgentNamePrimaryKey) {
      // Old schema detected - migrate to new schema with SHA-based id
      this.db.exec(`
        CREATE TABLE deployments_new (
          id TEXT PRIMARY KEY,
          agent_name TEXT NOT NULL,
          provider TEXT,
          deployment_url TEXT,
          auth_token_hash TEXT,
          deployed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          last_connected_at DATETIME,
          volume_id TEXT,
          volume_config TEXT,
          deployed_version TEXT,
          deleted_at DATETIME
        );
        CREATE INDEX idx_deployments_agent_name ON deployments_new(agent_name);
      `)

      // Migrate existing data with auto-generated SHA
      const oldDeployments = this.db.prepare('SELECT * FROM deployments').all() as any[]
      for (const dep of oldDeployments) {
        const sha = generateShaFromExistingData(dep.agent_name, dep.deployed_at || '', dep.provider || '')
        this.db.prepare(`
          INSERT INTO deployments_new (id, agent_name, provider, deployment_url, auth_token_hash, deployed_at, last_connected_at, volume_id, volume_config, deployed_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(sha, dep.agent_name, dep.provider, dep.deployment_url, dep.auth_token_hash, dep.deployed_at, dep.last_connected_at, dep.volume_id, dep.volume_config, dep.deployed_version)
      }

      // Drop old table and rename new one
      this.db.exec('DROP TABLE deployments')
      this.db.exec('ALTER TABLE deployments_new RENAME TO deployments')
    }

    // Migration: Add deployed_version column to deployments table (idempotent)
    if (!this.columnExists('deployments', 'deployed_version')) {
      this.db.exec('ALTER TABLE deployments ADD COLUMN deployed_version TEXT')
    }

    // Migration: Add deleted_at column (idempotent)
    if (!this.columnExists('deployments', 'deleted_at')) {
      this.db.exec('ALTER TABLE deployments ADD COLUMN deleted_at DATETIME')
    }

    // Migration: Add releases table (idempotent)
    if (!this.tableExists('releases')) {
      this.db.exec(`
        CREATE TABLE releases (
          agent_name TEXT,
          version TEXT,
          change_number INTEGER,
          message TEXT,
          changelog TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          tarball_path TEXT,
          PRIMARY KEY (agent_name, version)
        )
      `)
    }

    // Migration: Add sessions table (idempotent)
    if (!this.tableExists('sessions')) {
      this.db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          name TEXT,
          agent_name TEXT NOT NULL,
          mode TEXT,
          ui_mode TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          ended_at DATETIME,
          message_count INTEGER DEFAULT 0,
          parent_session_id TEXT,
          first_user_message TEXT,
          last_user_message TEXT,
          json_path TEXT NOT NULL
        );
        CREATE INDEX idx_sessions_agent_name ON sessions(agent_name);
        CREATE INDEX idx_sessions_updated_at ON sessions(updated_at DESC);
      `)
    }

    // Migration: Drop legacy builder_sessions table (unused) if present
    if (this.tableExists('builder_sessions')) {
      this.db.exec('DROP TABLE IF EXISTS builder_sessions')
    }
  }

  private tableExists(table: string): boolean {
    const stmt = this.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    const result = stmt.get(table)
    return !!result
  }

  private columnExists(table: string, column: string): boolean {
    const stmt = this.db.prepare(`PRAGMA table_info(${table})`)
    const columns = stmt.all() as any[]
    return columns.some((col: any) => col.name === column)
  }

  public getAgent(name: string): any {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE name = ?')
    return stmt.get(name)
  }

  public listAgents(): any[] {
    const stmt = this.db.prepare('SELECT * FROM agents ORDER BY created_at DESC')
    return stmt.all()
  }

  public createAgent(name: string, agentYamlPath: string): void {
    const stmt = this.db.prepare('INSERT OR REPLACE INTO agents (name, agent_yaml_path) VALUES (?, ?)')
    stmt.run(name, agentYamlPath)
  }

  public updateAgent(name: string, updates: Partial<{agent_yaml_path: string; last_run_at: string; run_count: number}>): void {
    const fields = Object.keys(updates)
    if (fields.length === 0) return
    const setClause = fields.map(f => `${f} = ?`).join(', ')
    const stmt = this.db.prepare(`UPDATE agents SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE name = ?`)
    stmt.run(...fields.map(f => (updates as any)[f]), name)
  }

  public deleteAgent(name: string): void {
    // Clean up related records first. All of these are cascade-on-agent
    // relationships, so leaving any of them dangling would leave the
    // registry full of stale entries.
    this.db.prepare('DELETE FROM agent_mcp WHERE agent_name = ?').run(name)
    this.db.prepare('DELETE FROM deployments WHERE agent_name = ?').run(name)
    this.db.prepare('DELETE FROM local_agents WHERE agent_name = ?').run(name)
    // Releases are stored in their own table that wasn't part of the
    // original schema, so they need to be explicitly deleted here.
    this.db.prepare('DELETE FROM releases WHERE agent_name = ?').run(name)
    // Sessions are stored in their own table and have JSON content
    // that should be cleaned up by the caller; here we just drop the
    // index rows.
    this.db.prepare('DELETE FROM sessions WHERE agent_name = ?').run(name)
    this.db.prepare('DELETE FROM agents WHERE name = ?').run(name)
  }

  public renameAgent(currentName: string, newName: string): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('UPDATE agents SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?').run(newName, currentName)
      this.db.prepare('UPDATE deployments SET agent_name = ? WHERE agent_name = ?').run(newName, currentName)
      this.db.prepare('UPDATE local_agents SET agent_name = ? WHERE agent_name = ?').run(newName, currentName)
      this.db.prepare('UPDATE agent_mcp SET agent_name = ? WHERE agent_name = ?').run(newName, currentName)
    })
    transaction()
  }

  public updateAgentRun(name: string): void {
    const stmt = this.db.prepare(`
      UPDATE agents 
      SET last_run_at = CURRENT_TIMESTAMP, run_count = run_count + 1 
      WHERE name = ?
    `)
    stmt.run(name)
  }

  public getLocalAgent(name: string): any {
    const stmt = this.db.prepare('SELECT * FROM local_agents WHERE agent_name = ?')
    return stmt.get(name)
  }

  public setLocalAgent(name: string, pid: number, port: number): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO local_agents (agent_name, pid, port) 
      VALUES (?, ?, ?)
    `)
    stmt.run(name, pid, port)
  }

  public removeLocalAgent(name: string): void {
    const stmt = this.db.prepare('DELETE FROM local_agents WHERE agent_name = ?')
    stmt.run(name)
  }

  public listLocalAgents(): any[] {
    const stmt = this.db.prepare('SELECT * FROM local_agents')
    return stmt.all()
  }

  public getDeployment(name: string): any {
    // Backward compat: get most recent non-deleted deployment for agent name
    return this.getActiveDeployment(name)
  }

  public getDeploymentBySha(sha: string): any {
    const stmt = this.db.prepare('SELECT * FROM deployments WHERE id = ? AND deleted_at IS NULL')
    return stmt.get(sha)
  }

  public getDeploymentByAgentName(name: string): any {
    return this.getActiveDeployment(name)
  }

  public getActiveDeployment(agentName: string): any {
    const stmt = this.db.prepare('SELECT * FROM deployments WHERE agent_name = ? AND deleted_at IS NULL ORDER BY deployed_at DESC LIMIT 1')
    return stmt.get(agentName)
  }

  public listDeployments(agentName: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM deployments WHERE agent_name = ? AND deleted_at IS NULL ORDER BY deployed_at DESC')
    return stmt.all(agentName)
  }

  public createDeployment(id: string, agentName: string, provider: string, url: string, tokenHash: string, volumeId?: string | null, volumeConfig?: string | null, deployedVersion?: string | null): void {
    const stmt = this.db.prepare(`
      INSERT INTO deployments
      (id, agent_name, provider, deployment_url, auth_token_hash, volume_id, volume_config, deployed_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(id, agentName, provider, url, tokenHash, volumeId || null, volumeConfig || null, deployedVersion || null)
  }

  public removeDeployment(name: string): void {
    // For backward compat, treat name as agent name and soft delete most recent
    const deployment = this.getActiveDeployment(name)
    if (deployment) {
      this.removeDeploymentBySha(deployment.id)
    }
  }

  public removeDeploymentBySha(sha: string): void {
    const stmt = this.db.prepare('UPDATE deployments SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?')
    stmt.run(sha)
  }

  public removeAllDeployments(agentName: string): void {
    const stmt = this.db.prepare(
      'UPDATE deployments SET deleted_at = CURRENT_TIMESTAMP WHERE agent_name = ? AND deleted_at IS NULL'
    )
    stmt.run(agentName)
  }

  public setDeployment(name: string, provider: string, url: string, tokenHash: string, volumeId?: string | null, volumeConfig?: string | null): void {
    // For backward compat - create new deployment with auto-generated SHA
    const sha = generateDeploymentSha(name)
    this.createDeployment(sha, name, provider, url, tokenHash, volumeId, volumeConfig)
  }

  public getDeployedVersion(agentName: string): string | null {
    const deployment = this.getActiveDeployment(agentName)
    return deployment?.deployed_version ?? null
  }

  public updateDeployedVersion(agentName: string, version: string | number): void {
    const deployment = this.getActiveDeployment(agentName)
    if (!deployment) return
    // Handle both string (semantic) and number (legacy) versions
    const versionStr = typeof version === 'number' ? `v${version}` : version
    const stmt = this.db.prepare('UPDATE deployments SET deployed_version = ? WHERE id = ?')
    stmt.run(versionStr, deployment.id)
  }

  public updateDeploymentLastConnected(sha: string): void {
    const stmt = this.db.prepare('UPDATE deployments SET last_connected_at = CURRENT_TIMESTAMP WHERE id = ?')
    stmt.run(sha)
  }

  // Agent MCP methods
  public setAgentMcp(agentName: string, serverName: string, configPath: string, credentialsPath?: string | null): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO agent_mcp (agent_name, server_name, config_path, credentials_path)
      VALUES (?, ?, ?, ?)
    `)
    stmt.run(agentName, serverName, configPath, credentialsPath || null)
  }

  public removeAgentMcp(agentName: string, serverName: string): void {
    const stmt = this.db.prepare('DELETE FROM agent_mcp WHERE agent_name = ? AND server_name = ?')
    stmt.run(agentName, serverName)
  }

  public listAgentMcp(agentName: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM agent_mcp WHERE agent_name = ?')
    return stmt.all(agentName) as any[]
  }

  public updateAgentMcpCredentials(agentName: string, serverName: string, credentialsPath: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_mcp SET credentials_path = ? WHERE agent_name = ? AND server_name = ?
    `)
    stmt.run(credentialsPath, agentName, serverName)
  }

  // Provider config methods
  public getProviderConfig(provider: string): any {
    const stmt = this.db.prepare('SELECT config_json FROM provider_configs WHERE provider = ?')
    const row = stmt.get(provider) as any
    if (row?.config_json) {
      try {
        return JSON.parse(row.config_json)
      } catch {
        return row.config_json
      }
    }

    return null
  }

  public setProviderConfig(provider: string, config: any): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO provider_configs (provider, config_json)
      VALUES (?, ?)
    `)
    stmt.run(provider, typeof config === 'string' ? config : JSON.stringify(config))
  }

  // Release methods
  public createRelease(agentName: string, version: string, changeNumber: number, message: string, changelog: string, tarballPath: string): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO releases
      (agent_name, version, change_number, message, changelog, tarball_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(agentName, version, changeNumber, message, changelog, tarballPath)
  }

  public listReleases(agentName: string): any[] {
    const stmt = this.db.prepare('SELECT * FROM releases WHERE agent_name = ? ORDER BY created_at DESC')
    return stmt.all(agentName)
  }

  public getRelease(agentName: string, version: string): any {
    const stmt = this.db.prepare('SELECT * FROM releases WHERE agent_name = ? AND version = ?')
    return stmt.get(agentName, version)
  }

  public getCurrentRelease(agentName: string): any {
    const stmt = this.db.prepare('SELECT * FROM releases WHERE agent_name = ? ORDER BY created_at DESC LIMIT 1')
    return stmt.get(agentName)
  }

  public listAllReleases(): any[] {
    // Get all releases with their most recent deployment info
    const stmt = this.db.prepare(`
      SELECT r.*, d.id as deployment_sha, d.provider, d.deployment_url, d.deployed_at as deployment_date
      FROM releases r
      LEFT JOIN (
        SELECT agent_name, deployed_version, id, provider, deployment_url, deployed_at,
               ROW_NUMBER() OVER (PARTITION BY agent_name, deployed_version ORDER BY deployed_at DESC) as rn
        FROM deployments
        WHERE deleted_at IS NULL
      ) d ON r.agent_name = d.agent_name AND r.version = d.deployed_version AND d.rn = 1
      ORDER BY r.created_at DESC
    `)
    return stmt.all()
  }

  public listAllReleasesForAgent(agentName: string): any[] {
    const stmt = this.db.prepare(`
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
    `)
    return stmt.all(agentName)
  }

  public listAllDeploymentsForAgent(agentName: string): any[] {
    // For detailed deployments table (cast registry <agent>)
    const stmt = this.db.prepare(`
      SELECT id as deployment_sha, provider, deployed_version, deployed_at, deployment_url
      FROM deployments
      WHERE agent_name = ? AND deleted_at IS NULL
      ORDER BY deployed_at DESC
    `)
    return stmt.all(agentName)
  }

  public deleteRelease(agentName: string, version: string): void {
    const stmt = this.db.prepare('DELETE FROM releases WHERE agent_name = ? AND version = ?')
    stmt.run(agentName, version)
  }

  // Session methods
  public upsertSession(meta: {
    id: string
    name: string | null
    agent_name: string
    mode: string | null
    ui_mode: string | null
    created_at: string
    updated_at: string
    ended_at: string | null
    message_count: number
    parent_session_id: string | null
    first_user_message: string | null
    last_user_message: string | null
    json_path: string
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, name, agent_name, mode, ui_mode, created_at, updated_at,
        ended_at, message_count, parent_session_id,
        first_user_message, last_user_message, json_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      meta.id,
      meta.name,
      meta.agent_name,
      meta.mode,
      meta.ui_mode,
      meta.created_at,
      meta.updated_at,
      meta.ended_at,
      meta.message_count,
      meta.parent_session_id,
      meta.first_user_message,
      meta.last_user_message,
      meta.json_path,
    )
  }

  public updateSessionFields(sessionId: string, fields: Record<string, any>): void {
    const keys = Object.keys(fields)
    if (keys.length === 0) return
    const setClause = keys.map(k => `${k} = ?`).join(', ')
    const values = keys.map(k => fields[k])
    values.push(sessionId)
    const stmt = this.db.prepare(`UPDATE sessions SET ${setClause} WHERE id = ?`)
    stmt.run(...values)
  }

  public getSession(id: string): any {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?')
    return stmt.get(id)
  }

  public getSessionByName(name: string): any {
    const stmt = this.db.prepare(
      'SELECT * FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1',
    )
    return stmt.get(name)
  }

  public listSessions(agentName?: string, limit: number = 50, includeEnded: boolean = true): any[] {
    if (agentName) {
      if (includeEnded) {
        const stmt = this.db.prepare(
          'SELECT * FROM sessions WHERE agent_name = ? ORDER BY updated_at DESC LIMIT ?',
        )
        return stmt.all(agentName, limit)
      }
      const stmt = this.db.prepare(
        'SELECT * FROM sessions WHERE agent_name = ? AND ended_at IS NULL ORDER BY updated_at DESC LIMIT ?',
      )
      return stmt.all(agentName, limit)
    }
    if (includeEnded) {
      const stmt = this.db.prepare(
        'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?',
      )
      return stmt.all(limit)
    }
    const stmt = this.db.prepare(
      'SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY updated_at DESC LIMIT ?',
    )
    return stmt.all(limit)
  }

  public deleteSession(id: string): void {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?')
    stmt.run(id)
  }

  public deleteSessionsForAgent(agentName: string): number {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE agent_name = ?')
    const result = stmt.run(agentName)
    return Number(result.changes) || 0
  }
}

export const db = new CastDatabase()
