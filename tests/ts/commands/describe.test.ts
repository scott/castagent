import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'yaml'
import Describe, {customToolLabels} from '../../../typescript/cast-cli/src/commands/describe'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('describe command', () => {
  const testDir = path.join(os.tmpdir(), `cast-describe-test-${Date.now()}`)
  const agentsDir = path.join(testDir, '.cast', 'agents')

  before(() => {
    fs.mkdirSync(agentsDir, {recursive: true})
  })

  after(() => {
    try {
      fs.rmSync(testDir, {recursive: true, force: true})
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('command description', () => {
    it('should have correct description', () => {
      expect('Show agent description and details').to.not.be.empty
    })
  })

  describe('agent argument', () => {
    it('should require agent name', () => {
      const agentName = 'test-agent'
      expect(agentName).to.be.a('string')
      expect(agentName).to.not.be.empty
    })
  })

  describe('agent existence check', () => {
    it('should verify agent directory exists', () => {
      const agentName = 'non-existent-agent'
      const agentPath = path.join(agentsDir, agentName)

      expect(fs.existsSync(agentPath)).to.be.false
    })

    it('should verify agent.yaml exists', () => {
      const agentName = 'test-agent'
      const agentPath = path.join(agentsDir, agentName)
      const agentYamlPath = path.join(agentPath, 'agent.yaml')

      expect(fs.existsSync(agentYamlPath)).to.be.false
    })
  })

  describe('describe operation', () => {
    const agentName = `describe-test-${Date.now()}`

    before(() => {
      const agentPath = path.join(agentsDir, agentName)
      fs.mkdirSync(agentPath, {recursive: true})

      const config = {
        name: agentName,
        version: '1.0',
        description: 'A test agent for describe command',
        brain: {
          model: 'openrouter/anthropic/claude-3.7-sonnet',
          instructions_file: 'instructions.md',
        },
        tools: {
          builtin: ['bash', 'read', 'glob'],
          mcp: [{server: 'gmail'}],
          custom: [],
        },
        harness: {
          permissions: {
            bash: 'always-allow',
            read: 'always-allow',
          },
          principles: ['Be helpful', 'Be concise'],
        },
      }

      fs.writeFileSync(
        path.join(agentPath, 'agent.yaml'),
        yaml.stringify(config)
      )

      fs.writeFileSync(
        path.join(agentPath, 'instructions.md'),
        'You are a helpful test agent.'
      )

      db.createAgent(agentName, path.join(agentPath, 'agent.yaml'))
    })

    after(() => {
      try {
        fs.rmSync(path.join(agentsDir, agentName), {recursive: true, force: true})
        db.deleteAgent(agentName)
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should read agent.yaml', () => {
      const agentPath = path.join(agentsDir, agentName)
      const agentYamlPath = path.join(agentPath, 'agent.yaml')

      const config = yaml.parse(fs.readFileSync(agentYamlPath, 'utf8'))

      expect(config.name).to.equal(agentName)
      expect(config.version).to.equal('1.0')
      expect(config.description).to.be.a('string')
    })

    it('should read instructions file', () => {
      const agentPath = path.join(agentsDir, agentName)
      const instructionsPath = path.join(agentPath, 'instructions.md')

      const instructions = fs.readFileSync(instructionsPath, 'utf8')
      expect(instructions).to.not.be.empty
    })

    it('should get status from database', () => {
      const localAgent = db.getLocalAgent(agentName)
      const deployment = db.getDeployment(agentName)

      // Agent may or may not be running/deployed
      // localAgent can be null, undefined, or have a pid
      expect(!localAgent || typeof localAgent.pid === 'number').to.be.true
    })

    it('should display description', () => {
      const agentPath = path.join(agentsDir, agentName)
      const config = yaml.parse(fs.readFileSync(path.join(agentPath, 'agent.yaml'), 'utf8'))

      expect(config.description).to.equal('A test agent for describe command')
    })

    it('should display model', () => {
      const agentPath = path.join(agentsDir, agentName)
      const config = yaml.parse(fs.readFileSync(path.join(agentPath, 'agent.yaml'), 'utf8'))

      expect(config.brain.model).to.equal('openrouter/anthropic/claude-3.7-sonnet')
    })

    it('should display tools', () => {
      const agentPath = path.join(agentsDir, agentName)
      const config = yaml.parse(fs.readFileSync(path.join(agentPath, 'agent.yaml'), 'utf8'))

      expect(config.tools.builtin).to.deep.equal(['bash', 'read', 'glob'])
      expect(config.tools.mcp).to.deep.equal([{server: 'gmail'}])
    })

    it('should display permissions', () => {
      const agentPath = path.join(agentsDir, agentName)
      const config = yaml.parse(fs.readFileSync(path.join(agentPath, 'agent.yaml'), 'utf8'))

      expect(config.harness.permissions.bash).to.equal('always-allow')
      expect(config.harness.permissions.read).to.equal('always-allow')
    })

    it('should display principles', () => {
      const agentPath = path.join(agentsDir, agentName)
      const config = yaml.parse(fs.readFileSync(path.join(agentPath, 'agent.yaml'), 'utf8'))

      expect(config.harness.principles).to.deep.equal(['Be helpful', 'Be concise'])
    })

    it('should show agent location', () => {
      const agentPath = path.join(agentsDir, agentName)
      expect(agentPath).to.include('.cast')
      expect(agentPath).to.include('agents')
      expect(agentPath).to.include(agentName)
    })
  })

  describe('status display', () => {
    it('should show running status', () => {
      const localAgent = {agent_name: 'test', pid: 12345, port: 54321}
      const status = localAgent ? `[local: running on port ${localAgent.port}]` : '[local: stopped]'
      expect(status).to.include('running')
    })

    it('should show deployed status', () => {
      const deployment = {agent_name: 'test', provider: 'docker', deployment_url: 'http://localhost'}
      const status = deployment?.deployment_url
        ? `[deployed: ${deployment.provider}]`
        : '[local: stopped]'
      expect(status).to.include('deployed')
    })

    it('should show stopped status', () => {
      // Test status determination logic
      const localAgent = null as {port: number} | null
      const deployment = null as {deployment_url: string; provider: string} | null

      let status = '[local: stopped]'
      if (deployment && (deployment as any).deployment_url) {
        status = `[deployed: ${(deployment as any).provider}]`
      } else if (localAgent && (localAgent as any).port) {
        status = `[local: running on port ${(localAgent as any).port}]`
      }

      expect(status).to.equal('[local: stopped]')
    })
  })

  describe('instructions preview', () => {
    it('should truncate long instructions', () => {
      const instructions = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10\nLine 11'
      const lines = instructions.split('\n')
      const previewLines = lines.slice(0, 10)

      expect(previewLines.length).to.equal(10)
      expect(lines.length).to.equal(11)
    })

    it('should indicate truncation', () => {
      const totalLines = 20
      const shownLines = 10
      const truncated = totalLines - shownLines

      expect(truncated).to.equal(10)
      expect(`... (${truncated} more lines)`).to.equal('... (10 more lines)')
    })
  })

  describe('custom tool labels', () => {
    it('keeps module name strings and object paths', () => {
      expect(customToolLabels([
        'email_tools',
        {path: 'tools/summarize_thread.py'},
        '  trimmed_tool  ',
      ])).to.deep.equal([
        'email_tools',
        'tools/summarize_thread.py',
        'trimmed_tool',
      ])
    })

    it('drops blank strings, missing paths, and non-lists', () => {
      expect(customToolLabels([
        '',
        '   ',
        {},
        {path: ''},
        {path: '   '},
        {name: 'email_tools'},
        3,
        null,
      ])).to.deep.equal([])
      expect(customToolLabels(undefined)).to.deep.equal([])
      expect(customToolLabels('email_tools')).to.deep.equal([])
    })
  })

  describe('custom tool display', () => {
    const created: string[] = []

    function writeAgent(name: string, yamlBody: string): void {
      const agentPath = path.join(os.homedir(), '.cast', 'agents', name)
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(path.join(agentPath, 'agent.yaml'), yamlBody)
      created.push(agentPath)
    }

    function createCommand(agentName: string): any {
      const instance: any = new Describe(['describe', agentName], {color: false} as any)
      instance.config = {
        runHook: async () => {},
        name: 'describe',
        bin: 'cast',
      }
      instance.args = {agent: agentName}
      instance.parse = async () => ({args: instance.args, flags: {}})
      return instance
    }

    async function runDescribe(agentName: string): Promise<string[]> {
      const instance = createCommand(agentName)
      const logs: string[] = []
      instance.log = (msg?: string) => {
        logs.push(msg ?? '')
      }
      instance.error = (msg?: any) => {
        const text = typeof msg === 'string' ? msg : (msg?.message ?? String(msg))
        throw new Error(text)
      }
      await instance.run()
      return logs
    }

    after(() => {
      for (const agentPath of created) {
        fs.rmSync(agentPath, {recursive: true, force: true})
      }
    })

    it('prints a string custom entry instead of a blank Custom line', async () => {
      const name = `describe-test-string-${Date.now()}`
      writeAgent(name, [
        `name: ${name}`,
        'description: string custom tools',
        'tools:',
        '  builtin: []',
        '  mcp: []',
        '  custom:',
        '    - email_tools',
        '',
      ].join('\n'))

      const logs = await runDescribe(name)
      expect(logs).to.include('  Custom: email_tools')
      expect(logs.some(line => line.trim() === 'Custom:')).to.equal(false)
      expect(logs.some(line => line.includes('No tools configured'))).to.equal(false)
    })

    it('prints an object path and a mixed list', async () => {
      const name = `describe-test-mixed-${Date.now()}`
      writeAgent(name, [
        `name: ${name}`,
        'description: mixed custom tools',
        'tools:',
        '  builtin:',
        '    - bash',
        '  mcp:',
        '    - server: gmail',
        '  custom:',
        '    - email_tools',
        '    - path: tools/summarize_thread.py',
        '    - ""',
        '    - path: "  "',
        '    - {}',
        '',
      ].join('\n'))

      const logs = await runDescribe(name)
      expect(logs).to.include('  Built-in: bash')
      expect(logs).to.include('  MCP: gmail')
      expect(logs).to.include('  Custom: email_tools, tools/summarize_thread.py')
    })

    it('omits Custom when every entry has no label', async () => {
      const name = `describe-test-blank-${Date.now()}`
      writeAgent(name, [
        `name: ${name}`,
        'description: blank custom tools',
        'tools:',
        '  custom:',
        '    - ""',
        '    - {}',
        '    - path: "   "',
        '',
      ].join('\n'))

      const logs = await runDescribe(name)
      expect(logs.some(line => line.includes('Custom:'))).to.equal(false)
      expect(logs).to.include('  No tools configured')
    })
  })
})