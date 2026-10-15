import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as crypto from 'crypto'
import {createPrivateFile, ensurePrivateDir, tightenPrivateFile} from './private-path'

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

export function mapSessionRow(row: any): any {
  if (!row || typeof row !== 'object') return row
  const topicText = typeof row.topic === 'string' ? row.topic.trim() : ''
  const rawCount = Object.prototype.hasOwnProperty.call(row, 'topic_message_count')
    ? row.topic_message_count
    : null
  const topicMessageCount =
    rawCount == null || rawCount === '' || !Number.isFinite(Number(rawCount))
      ? null
      : Number(rawCount)
  return {
    ...row,
    topic: topicText ? row.topic : null,
    topic_message_count: topicMessageCount,
  }
}

function prepareDatabaseDir(dir: string): void {
  const home = path.resolve(CAST_DIR)
  const resolved = path.resolve(dir)
  const underCast = resolved === home || resolved.startsWith(home + path.sep)
  // A database opened in a shared directory such as /tmp must not chmod
  // that directory. ~/.cast and any directory this call creates are private.
  if (!underCast && fs.existsSync(dir)) return
  ensurePrivateDir(resolved)
  if (underCast && resolved !== home) ensurePrivateDir(home)
}

export class CastDatabase {
  private db: Database.Database

  constructor(dbPath: string = DB_PATH) {
    prepareDatabaseDir(path.dirname(dbPath))
    createPrivateFile(dbPath)
    // SQLite opens the existing inode. umask 077 covers sidecar files
    // (wal, shm) created on this open so they are not born world-readable.
    const previous = process.umask(0o077)
    try {
      this.db = new Database(dbPath)
    } finally {
      process.umask(previous)
    }
    tightenPrivateFile(dbPath)
    for (const suffix of ['-wal', '-shm']) {
      tightenPrivateFile(dbPath + suffix)
    }
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
        topic TEXT,
        topic_message_count INTEGER,
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

    // Migration: version, change number, message, changelog, tarball path.
    // Existing rows are not rewritten.
    if (this.tableExists('releases')) {
      const releaseColumns: Array<[string, string]> = [
        ['change_number', 'INTEGER'],
        ['message', 'TEXT'],
        ['changelog', 'TEXT'],
        ['created_at', 'DATETIME'],
        ['tarball_path', 'TEXT'],
      ]
      for (const [column, type] of releaseColumns) {
        if (!this.columnExists('releases', column)) {
          this.db.exec(`ALTER TABLE releases ADD COLUMN ${column} ${type}`)
        }
      }
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
          topic TEXT,
          topic_message_count INTEGER,
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

    // Migration: topic columns on sessions (idempotent for existing databases)
    this.ensureSessionTopicColumns()
  }

  private ensureSessionTopicColumns(): void {
    if (!this.tableExists('sessions')) return
    if (!this.columnExists('sessions', 'topic')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN topic TEXT')
    }
    if (!this.columnExists('sessions', 'topic_message_count')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN topic_message_count INTEGER')
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

  // deployments.agent_name references agents(name), and better-sqlite3
  // builds SQLite with foreign keys enabled. Agent creation writes the
  // scaffold on disk; this records the parent row before a deployment
  // insert. INSERT OR IGNORE keeps created_at and run_count when the
  // row is already there.
  public ensureAgent(name: string, agentYamlPath?: string): void {
    const yamlPath = agentYamlPath && agentYamlPath.length > 0
      ? agentYamlPath
      : path.join(os.homedir(), '.cast', 'agents', name, 'agent.yaml')
    const stmt = this.db.prepare('INSERT OR IGNORE INTO agents (name, agent_yaml_path) VALUES (?, ?)')
    stmt.run(name, yamlPath)
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
    // The deployments foreign key is checked at the end of each statement.
    // Updating agents.name in place fails while deployments still point at
    // the old name, and pointing deployments at the new name fails until
    // that parent row exists. Copy the parent, repoint children, then
    // delete the old parent.
    const transaction = this.db.transaction(() => {
      const hasDeployment = this.db.prepare(
        'SELECT 1 AS ok FROM deployments WHERE agent_name = ? LIMIT 1',
      ).get(currentName)
      if (hasDeployment) {
        this.ensureAgent(currentName)
      }

      const existing = this.db.prepare('SELECT * FROM agents WHERE name = ?').get(currentName) as {
        created_at?: string | null
        agent_yaml_path?: string | null
        last_run_at?: string | null
        run_count?: number | null
      } | undefined

      if (existing) {
        this.db.prepare(`
          INSERT INTO agents (name, created_at, updated_at, agent_yaml_path, last_run_at, run_count)
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?)
        `).run(
          newName,
          existing.created_at ?? null,
          existing.agent_yaml_path ?? null,
          existing.last_run_at ?? null,
          existing.run_count ?? 0,
        )
      }

      this.db.prepare('UPDATE deployments SET agent_name = ? WHERE agent_name = ?').run(newName, currentName)
      this.db.prepare('UPDATE local_agents SET agent_name = ? WHERE agent_name = ?').run(newName, currentName)
      this.db.prepare('UPDATE agent_mcp SET agent_name = ? WHERE agent_name = ?').run(newName, currentName)

      if (existing) {
        this.db.prepare('DELETE FROM agents WHERE name = ?').run(currentName)
      }
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

  public listActiveDeployments(): any[] {
    const stmt = this.db.prepare('SELECT * FROM deployments WHERE deleted_at IS NULL ORDER BY agent_name, deployed_at DESC')
    return stmt.all()
  }

  public createDeployment(id: string, agentName: string, provider: string, url: string, tokenHash: string, volumeId?: string | null, volumeConfig?: string | null, deployedVersion?: string | null): void {
    this.ensureAgent(agentName)
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

  public updateDeploymentEndpoint(id: string, url: string, volumeId: string, volumeConfig: string): void {
    const stmt = this.db.prepare(
      'UPDATE deployments SET deployment_url = ?, volume_id = ?, volume_config = ? WHERE id = ? AND deleted_at IS NULL',
    )
    stmt.run(url, volumeId, volumeConfig, id)
  }

  public updateDeployedVersionById(id: string, version: string | number): void {
    const versionStr = typeof version === 'number' ? `v${version}` : version
    const stmt = this.db.prepare('UPDATE deployments SET deployed_version = ? WHERE id = ? AND deleted_at IS NULL')
    stmt.run(versionStr, id)
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
    topic?: string | null
    topic_message_count?: number | null
    json_path: string
  }): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (
        id, name, agent_name, mode, ui_mode, created_at, updated_at,
        ended_at, message_count, parent_session_id,
        first_user_message, last_user_message, topic, topic_message_count, json_path
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      meta.topic ?? null,
      meta.topic_message_count ?? null,
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
    const row = stmt.get(id)
    return row ? mapSessionRow(row) : undefined
  }

  public getSessionByName(name: string): any {
    const stmt = this.db.prepare(
      'SELECT * FROM sessions WHERE name = ? ORDER BY updated_at DESC LIMIT 1',
    )
    const row = stmt.get(name)
    return row ? mapSessionRow(row) : undefined
  }

  public listSessions(agentName?: string, limit: number = 50, includeEnded: boolean = true): any[] {
    const map = (rows: unknown[]) => rows.map(mapSessionRow)
    if (agentName) {
      if (includeEnded) {
        const stmt = this.db.prepare(
          'SELECT * FROM sessions WHERE agent_name = ? ORDER BY updated_at DESC LIMIT ?',
        )
        return map(stmt.all(agentName, limit))
      }
      const stmt = this.db.prepare(
        'SELECT * FROM sessions WHERE agent_name = ? AND ended_at IS NULL ORDER BY updated_at DESC LIMIT ?',
      )
      return map(stmt.all(agentName, limit))
    }
    if (includeEnded) {
      const stmt = this.db.prepare(
        'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?',
      )
      return map(stmt.all(limit))
    }
    const stmt = this.db.prepare(
      'SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY updated_at DESC LIMIT ?',
    )
    return map(stmt.all(limit))
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

  public close(): void {
    this.db.close()
  }
}

export const db = new CastDatabase()
