import Database from 'better-sqlite3'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

const CAST_DIR = path.join(os.homedir(), '.cast')
const DB_PATH = path.join(CAST_DIR, 'cast.db')

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
      CREATE TABLE IF NOT EXISTS builder_sessions (
        id TEXT PRIMARY KEY,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        current_agent_name TEXT,
        conversation_history TEXT
      );

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
        agent_name TEXT PRIMARY KEY,
        provider TEXT,
        deployment_url TEXT,
        auth_token_hash TEXT,
        deployed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_connected_at DATETIME,
        volume_id TEXT,
        volume_config TEXT
      );

      CREATE TABLE IF NOT EXISTS local_agents (
        agent_name TEXT PRIMARY KEY,
        pid INTEGER,
        port INTEGER,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        stopped_at DATETIME
      );
    `)
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
    // Clean up related records first
    this.db.prepare('DELETE FROM agent_mcp WHERE agent_name = ?').run(name)
    this.db.prepare('DELETE FROM deployments WHERE agent_name = ?').run(name)
    this.db.prepare('DELETE FROM local_agents WHERE agent_name = ?').run(name)
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
    const stmt = this.db.prepare('SELECT * FROM deployments WHERE agent_name = ?')
    return stmt.get(name)
  }

  public removeDeployment(name: string): void {
    const stmt = this.db.prepare('DELETE FROM deployments WHERE agent_name = ?')
    stmt.run(name)
  }

  public setDeployment(name: string, provider: string, url: string, tokenHash: string, volumeId?: string | null, volumeConfig?: string | null): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO deployments
      (agent_name, provider, deployment_url, auth_token_hash, volume_id, volume_config)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
    stmt.run(name, provider, url, tokenHash, volumeId || null, volumeConfig || null)
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
}

export const db = new CastDatabase()
