import {expect} from 'chai'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

describe('MCP Manager', () => {
  // Use a class-based approach for better testing
  const testAgentName = 'test-mcp-agent-' + Date.now()
  const testAgentPath = path.join(os.homedir(), '.cast', 'agents', testAgentName)

  afterEach(() => {
    // Clean up test agent directory if it exists
    if (fs.existsSync(testAgentPath)) {
      fs.rmSync(testAgentPath, {recursive: true, force: true})
    }
  })

  describe('MCPManager class structure', () => {
    it('should export mcpManager instance', () => {
      const mcpModule = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(mcpModule.mcpManager).to.exist
      expect(typeof mcpModule.mcpManager).to.equal('object')
    })

    it('should have installServer method', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(typeof mcpManager.installServer).to.equal('function')
    })

    it('should have uninstallServer method', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(typeof mcpManager.uninstallServer).to.equal('function')
    })

    it('should have listServers method', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(typeof mcpManager.listServers).to.equal('function')
    })

    it('should have configureServer method', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(typeof mcpManager.configureServer).to.equal('function')
    })

    it('should have getServerConfig method', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(typeof mcpManager.getServerConfig).to.equal('function')
    })
  })

  describe('installServer behavior', () => {
    it('should throw error for non-existent agent', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(() => {
        mcpManager.installServer('nonexistent-agent-12345', 'gmail')
      }).to.throw(/not found/)
    })

    it('should create mcp directory and config for valid agent', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent directory
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      // Mock the db module to avoid database issues
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      const originalSetAgentMcp = sqliteModule.db.setAgentMcp
      sqliteModule.db.setAgentMcp = () => {}

      try {
        mcpManager.installServer(testAgentName, 'gmail')

        const mcpConfigPath = path.join(testAgentPath, 'mcp', 'gmail.yaml')
        expect(fs.existsSync(mcpConfigPath)).to.be.true

        // Check config content
        const content = fs.readFileSync(mcpConfigPath, 'utf8')
        expect(content).to.include('gmail')
        expect(content).to.include('npx')
      } finally {
        sqliteModule.db.setAgentMcp = originalSetAgentMcp
      }
    })

    it('should throw error when server already installed', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent with mcp config
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')
      fs.writeFileSync(path.join(testAgentPath, 'mcp', 'gmail.yaml'), 'name: gmail\ncommand: npx')

      expect(() => {
        mcpManager.installServer(testAgentName, 'gmail')
      }).to.throw(/already installed/)
    })

    it('should throw error for unsupported server type', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent directory
      fs.mkdirSync(testAgentPath, {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      expect(() => {
        mcpManager.installServer(testAgentName, 'unsupported-server')
      }).to.throw(/Unsupported MCP server/)
    })

    it('should support slack server', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent directory
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      // Mock the db module
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sqliteModule.db.setAgentMcp = () => {}

      mcpManager.installServer(testAgentName, 'slack')

      const mcpConfigPath = path.join(testAgentPath, 'mcp', 'slack.yaml')
      expect(fs.existsSync(mcpConfigPath)).to.be.true
    })

    it('should support filesystem server', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent directory
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      // Mock the db module
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sqliteModule.db.setAgentMcp = () => {}

      mcpManager.installServer(testAgentName, 'filesystem')

      const mcpConfigPath = path.join(testAgentPath, 'mcp', 'filesystem.yaml')
      expect(fs.existsSync(mcpConfigPath)).to.be.true
    })
  })

  describe('uninstallServer behavior', () => {
    it('should throw error for non-existent agent', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(() => {
        mcpManager.uninstallServer('nonexistent-agent-12345', 'gmail')
      }).to.throw(/not found/)
    })

    it('should remove mcp config file', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent with mcp config
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')
      fs.writeFileSync(path.join(testAgentPath, 'mcp', 'gmail.yaml'), 'name: gmail\ncommand: npx')

      // Mock the db module
      const sqliteModule = require('../../../typescript/cast-cli/src/lib/sqlite')
      sqliteModule.db.removeAgentMcp = () => {}

      mcpManager.uninstallServer(testAgentName, 'gmail')

      const mcpConfigPath = path.join(testAgentPath, 'mcp', 'gmail.yaml')
      expect(fs.existsSync(mcpConfigPath)).to.be.false
    })
  })

  describe('listServers behavior', () => {
    it('should throw error for non-existent agent', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(() => {
        mcpManager.listServers('nonexistent-agent-12345')
      }).to.throw(/not found/)
    })

    it('should return empty array when no mcp directory', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent without mcp directory
      fs.mkdirSync(testAgentPath, {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      const servers = mcpManager.listServers(testAgentName)
      expect(servers).to.deep.equal([])
    })

    it('should return list of installed servers', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent with mcp configs
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')
      fs.writeFileSync(path.join(testAgentPath, 'mcp', 'gmail.yaml'), 'name: gmail')
      fs.writeFileSync(path.join(testAgentPath, 'mcp', 'slack.yaml'), 'name: slack')

      const servers = mcpManager.listServers(testAgentName)
      expect(servers).to.include('gmail')
      expect(servers).to.include('slack')
    })

    it('should handle .yml extension', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent with .yml config
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')
      fs.writeFileSync(path.join(testAgentPath, 'mcp', 'gmail.yml'), 'name: gmail')

      const servers = mcpManager.listServers(testAgentName)
      expect(servers).to.include('gmail')
    })
  })

  describe('configureServer behavior', () => {
    it('should throw error for non-existent agent', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(() => {
        mcpManager.configureServer('nonexistent-agent-12345', 'gmail', {})
      }).to.throw(/not found/)
    })

    it('should throw error when server not installed', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent without mcp config
      fs.mkdirSync(testAgentPath, {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      expect(() => {
        mcpManager.configureServer(testAgentName, 'gmail', {})
      }).to.throw(/not installed/)
    })

    it('should update server configuration', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent with mcp config
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')
      fs.writeFileSync(path.join(testAgentPath, 'mcp', 'gmail.yaml'), 'name: gmail\ncommand: npx')

      mcpManager.configureServer(testAgentName, 'gmail', {
        name: 'gmail',
        command: 'npx',
        args: ['-y', '@anthropic-ai/mcp-gmail', '--verbose']
      })

      const configContent = fs.readFileSync(path.join(testAgentPath, 'mcp', 'gmail.yaml'), 'utf8')
      expect(configContent).to.include('--verbose')
    })
  })

  describe('getServerConfig behavior', () => {
    it('should throw error for non-existent agent', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      expect(() => {
        mcpManager.getServerConfig('nonexistent-agent-12345', 'gmail')
      }).to.throw(/not found/)
    })

    it('should throw error when server not installed', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent without mcp config
      fs.mkdirSync(testAgentPath, {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')

      expect(() => {
        mcpManager.getServerConfig(testAgentName, 'gmail')
      }).to.throw(/not installed/)
    })

    it('should return server configuration', () => {
      const {mcpManager} = require('../../../typescript/cast-cli/src/lib/mcp')
      // Create test agent with mcp config
      fs.mkdirSync(path.join(testAgentPath, 'mcp'), {recursive: true})
      fs.writeFileSync(path.join(testAgentPath, 'agent.yaml'), 'name: test-agent\nversion: "1.0"')
      fs.writeFileSync(path.join(testAgentPath, 'mcp', 'gmail.yaml'), 'name: gmail\ncommand: npx')

      const config = mcpManager.getServerConfig(testAgentName, 'gmail')
      expect(config).to.be.an('object')
      expect((config as any).name).to.equal('gmail')
    })
  })
})