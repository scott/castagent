import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'yaml'
import {db} from './sqlite'

const AGENTS_DIR = path.join(os.homedir(), 'cast-agents')

export interface MCPServerConfig {
  name: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  [key: string]: any
}

export class MCPManager {
  private getAgentPath(agentName: string): string {
    return path.join(AGENTS_DIR, agentName)
  }

  private getMcpDir(agentName: string): string {
    return path.join(this.getAgentPath(agentName), 'mcp')
  }

  private getMcpConfigPath(agentName: string, serverName: string): string {
    return path.join(this.getMcpDir(agentName), `${serverName}.yaml`)
  }

  private getAgentYamlPath(agentName: string): string {
    return path.join(this.getAgentPath(agentName), 'agent.yaml')
  }

  private ensureAgentDir(agentName: string): void {
    const agentPath = this.getAgentPath(agentName)
    if (!fs.existsSync(agentPath)) {
      throw new Error(`Agent '${agentName}' not found at ${agentPath}`)
    }
  }

  private loadAgentYaml(agentName: string): any {
    const agentYamlPath = this.getAgentYamlPath(agentName)
    if (!fs.existsSync(agentYamlPath)) {
      return {}
    }

    const content = fs.readFileSync(agentYamlPath, 'utf8')
    return yaml.parse(content) || {}
  }

  private saveAgentYaml(agentName: string, config: any): void {
    const agentYamlPath = this.getAgentYamlPath(agentName)
    fs.writeFileSync(agentYamlPath, yaml.stringify(config), 'utf8')
  }

  private getDefaultServerConfig(serverName: string, agentName: string): MCPServerConfig {
    const configs: Record<string, MCPServerConfig> = {
      gmail: {
        name: 'gmail',
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-gmail'],
        env: {},
      },
      slack: {
        name: 'slack',
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-slack'],
        env: {},
      },
      filesystem: {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', this.getAgentPath(agentName)],
        env: {},
      },
    }

    if (!configs[serverName]) {
      throw new Error(`Unsupported MCP server: ${serverName}. Supported: gmail, slack, filesystem`)
    }

    return configs[serverName]
  }

  /**
   * Install an MCP server for an agent.
   * Creates the MCP config file, updates agent.yaml, and records in SQLite.
   */
  installServer(agentName: string, serverName: string): void {
    this.ensureAgentDir(agentName)

    const mcpDir = this.getMcpDir(agentName)
    if (!fs.existsSync(mcpDir)) {
      fs.mkdirSync(mcpDir, {recursive: true})
    }

    const configPath = this.getMcpConfigPath(agentName, serverName)
    if (fs.existsSync(configPath)) {
      throw new Error(`MCP server '${serverName}' is already installed for agent '${agentName}'`)
    }

    // Write default config
    const defaultConfig = this.getDefaultServerConfig(serverName, agentName)
    fs.writeFileSync(configPath, yaml.stringify(defaultConfig), 'utf8')

    // Update agent.yaml
    const agentConfig = this.loadAgentYaml(agentName)
    if (!agentConfig.tools) {
      agentConfig.tools = {}
    }

    if (!agentConfig.tools.mcp) {
      agentConfig.tools.mcp = []
    }

    if (!Array.isArray(agentConfig.tools.mcp)) {
      // Convert object map to array if needed
      const existing = agentConfig.tools.mcp
      agentConfig.tools.mcp = Object.entries(existing).map(([name, cfg]: [string, any]) => ({
        name,
        ...(typeof cfg === 'object' && cfg !== null ? cfg : {}),
      }))
    }

    const relativeConfigPath = path.relative(this.getAgentPath(agentName), configPath)
    const mcpEntry = {
      name: serverName,
      config: relativeConfigPath,
    }

    const existingIndex = agentConfig.tools.mcp.findIndex((s: any) => s.name === serverName)
    if (existingIndex >= 0) {
      agentConfig.tools.mcp[existingIndex] = mcpEntry
    } else {
      agentConfig.tools.mcp.push(mcpEntry)
    }

    this.saveAgentYaml(agentName, agentConfig)

    // Update SQLite
    try {
      db.setAgentMcp(agentName, serverName, relativeConfigPath, null)
    } catch (error) {
      console.error('Failed to update SQLite agent_mcp:', error)
    }
  }

  /**
   * Uninstall an MCP server from an agent.
   * Removes the config file, updates agent.yaml, and removes from SQLite.
   */
  uninstallServer(agentName: string, serverName: string): void {
    this.ensureAgentDir(agentName)

    const configPath = this.getMcpConfigPath(agentName, serverName)
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath)
    }

    // Update agent.yaml
    const agentConfig = this.loadAgentYaml(agentName)
    if (agentConfig.tools?.mcp && Array.isArray(agentConfig.tools.mcp)) {
      agentConfig.tools.mcp = agentConfig.tools.mcp.filter((s: any) => s.name !== serverName)
      this.saveAgentYaml(agentName, agentConfig)
    }

    // Update SQLite
    try {
      db.removeAgentMcp(agentName, serverName)
    } catch (error) {
      console.error('Failed to update SQLite agent_mcp:', error)
    }
  }

  /**
   * List installed MCP servers for an agent.
   */
  listServers(agentName: string): string[] {
    this.ensureAgentDir(agentName)

    const mcpDir = this.getMcpDir(agentName)
    if (!fs.existsSync(mcpDir)) {
      return []
    }

    const files = fs.readdirSync(mcpDir)
    return files
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .map(f => path.basename(f, path.extname(f)))
  }

  /**
   * Update the configuration for an installed MCP server.
   */
  configureServer(agentName: string, serverName: string, config: object): void {
    this.ensureAgentDir(agentName)

    const configPath = this.getMcpConfigPath(agentName, serverName)
    if (!fs.existsSync(configPath)) {
      throw new Error(`MCP server '${serverName}' is not installed for agent '${agentName}'`)
    }

    fs.writeFileSync(configPath, yaml.stringify(config), 'utf8')
  }

  /**
   * Read the configuration for an installed MCP server.
   */
  getServerConfig(agentName: string, serverName: string): object {
    this.ensureAgentDir(agentName)

    const configPath = this.getMcpConfigPath(agentName, serverName)
    if (!fs.existsSync(configPath)) {
      throw new Error(`MCP server '${serverName}' is not installed for agent '${agentName}'`)
    }

    const content = fs.readFileSync(configPath, 'utf8')
    return yaml.parse(content) || {}
  }
}

export const mcpManager = new MCPManager()
