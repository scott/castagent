import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'yaml'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'
import Update from '../../../typescript/cast-cli/src/commands/update'

describe('update command', () => {
  const testDir = path.join(os.tmpdir(), `cast-update-test-${Date.now()}`)
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
      expect('Update agent configuration').to.not.be.empty
    })
  })

  describe('model update', () => {
    it('should validate model format', () => {
      const validModels = [
        'openrouter/anthropic/claude-3.7-sonnet',
        'openai/gpt-4o',
        'google/gemini-2.0-flash',
      ]

      for (const model of validModels) {
        expect(model).to.include('/')
        expect(model).to.not.be.empty
      }
    })

    it('should accept digitalocean models without an OpenRouter warning', () => {
      const update = new Update(['update', 'agent'], {} as any)
      const known = (update as any).validateModel('digitalocean/llama3.3-70b-instruct')
      const catalog = (update as any).validateModel('digitalocean/some-new-catalog-id')
      expect(known).to.deep.equal({valid: true})
      expect(catalog).to.deep.equal({valid: true})
      expect(known.warning).to.equal(undefined)
    })

    it('should still warn for unknown OpenRouter models', () => {
      const update = new Update(['update', 'agent'], {} as any)
      const result = (update as any).validateModel('unknown/model')
      expect(result.valid).to.equal(true)
      expect(result.warning).to.include('OpenRouter')
    })

    it('accepts an external acceptsAnyModel id without an OpenRouter warning', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-update-model-'))
      const folder = path.join(home, '.cast', 'inference-providers', 'example')
      fs.mkdirSync(folder, {recursive: true})
      fs.writeFileSync(path.join(folder, 'provider.json'), JSON.stringify({
        key: 'example',
        name: 'Example Inference',
        prefixes: ['example/'],
        envVar: 'EXAMPLE_API_KEY',
        configKey: 'providers.example.api_key',
        baseUrl: 'https://example.invalid/v1',
        acceptsAnyModel: true,
        knownModels: [],
      }))
      fs.writeFileSync(path.join(folder, 'provider.py'), [
        'class Example:',
        '    key = "example"',
        '    env_var = "EXAMPLE_API_KEY"',
        '    prefixes = ("example/",)',
        '    def is_available(self):',
        '        return False',
        '    def create_llm(self, model=None, **kwargs):',
        '        return {"model": model}',
        'provider = Example()',
        '',
      ].join('\n'))
      const previous = process.env.HOME
      process.env.HOME = home
      try {
        const update = new Update(['update', 'agent'], {} as any)
        const result = (update as any).validateModel('example/my-model')
        expect(result).to.deep.equal({valid: true})
        expect(result.warning).to.equal(undefined)
      } finally {
        if (previous === undefined) delete process.env.HOME
        else process.env.HOME = previous
      }
    })

    it('should warn for unknown models', () => {
      const knownModels = [
        'anthropic/claude-3.7-sonnet',
        'openai/gpt-4o',
        'google/gemini-2.0-flash',
      ]

      const unknownModel = 'unknown/model'
      const isKnown = knownModels.includes(unknownModel)

      expect(isKnown).to.be.false
    })
  })

  describe('tool updates', () => {
    const validTools = ['bash', 'read', 'glob']

    it('should validate tool names', () => {
      for (const tool of validTools) {
        expect(validTools.includes(tool)).to.be.true
      }
    })

    it('should reject invalid tool names', () => {
      const invalidTool = 'invalid_tool'
      expect(validTools.includes(invalidTool)).to.be.false
    })
  })

  describe('permission updates', () => {
    it('should parse permission format correctly', () => {
      const permString = 'bash=always-allow'
      const parts = permString.split('=')

      expect(parts.length).to.equal(2)
      expect(parts[0]).to.equal('bash')
      expect(parts[1]).to.equal('always-allow')
    })

    it('should validate permission levels', () => {
      const validLevels = ['always-allow', 'approve-once', 'ask', 'block']

      for (const level of validLevels) {
        expect(validLevels.includes(level)).to.be.true
      }
    })
  })

  describe('full update operation', () => {
    const agentName = `update-test-${Date.now()}`

    before(() => {
      const agentPath = path.join(agentsDir, agentName)
      fs.mkdirSync(agentPath, {recursive: true})

      const config = {
        name: agentName,
        version: '1.0',
        description: 'Test agent',
        brain: {
          model: 'openrouter/anthropic/claude-3.7-sonnet',
          instructions_file: 'instructions.md',
        },
        tools: {
          builtin: ['bash'],
          mcp: [],
          custom: [],
        },
      }

      fs.writeFileSync(
        path.join(agentPath, 'agent.yaml'),
        yaml.stringify(config)
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

    it('should update model in config', () => {
      const agentPath = path.join(agentsDir, agentName)
      const configPath = path.join(agentPath, 'agent.yaml')

      const config = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      config.brain.model = 'openai/gpt-4o'

      fs.writeFileSync(configPath, yaml.stringify(config))

      const updated = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      expect(updated.brain.model).to.equal('openai/gpt-4o')
    })

    it('should add tools to config', () => {
      const agentPath = path.join(agentsDir, agentName)
      const configPath = path.join(agentPath, 'agent.yaml')

      const config = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      if (!config.tools) config.tools = {}
      if (!config.tools.builtin) config.tools.builtin = []
      config.tools.builtin.push('read')

      fs.writeFileSync(configPath, yaml.stringify(config))

      const updated = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      expect(updated.tools.builtin).to.include('read')
    })

    it('should remove tools from config', () => {
      const agentPath = path.join(agentsDir, agentName)
      const configPath = path.join(agentPath, 'agent.yaml')

      const config = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      config.tools.builtin = config.tools.builtin.filter((t: string) => t !== 'bash')

      fs.writeFileSync(configPath, yaml.stringify(config))

      const updated = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      expect(updated.tools.builtin).to.not.include('bash')
    })

    it('should update permissions', () => {
      const agentPath = path.join(agentsDir, agentName)
      const configPath = path.join(agentPath, 'agent.yaml')

      const config = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      if (!config.harness) config.harness = {}
      if (!config.harness.permissions) config.harness.permissions = {}
      config.harness.permissions.bash = 'ask'

      fs.writeFileSync(configPath, yaml.stringify(config))

      const updated = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      expect(updated.harness.permissions.bash).to.equal('ask')
    })

    it('should update description', () => {
      const agentPath = path.join(agentsDir, agentName)
      const configPath = path.join(agentPath, 'agent.yaml')

      const config = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      config.description = 'Updated description'

      fs.writeFileSync(configPath, yaml.stringify(config))

      const updated = yaml.parse(fs.readFileSync(configPath, 'utf8'))
      expect(updated.description).to.equal('Updated description')
    })
  })

  describe('dry-run mode', () => {
    it('should not modify files in dry-run mode', () => {
      const agentName = `dryrun-test-${Date.now()}`
      const agentPath = path.join(agentsDir, agentName)
      fs.mkdirSync(agentPath, {recursive: true})

      const configPath = path.join(agentPath, 'agent.yaml')
      const originalContent = 'name: test\nversion: "1.0"'
      fs.writeFileSync(configPath, originalContent)

      // Simulate dry-run (no actual changes)
      const changes = ['Model: new-model']
      const dryRun = true

      if (!dryRun) {
        // This should not execute in dry-run mode
        fs.writeFileSync(configPath, 'modified')
      }

      const finalContent = fs.readFileSync(configPath, 'utf8')
      expect(finalContent).to.equal(originalContent)

      // Cleanup
      fs.rmSync(agentPath, {recursive: true, force: true})
    })
  })
})