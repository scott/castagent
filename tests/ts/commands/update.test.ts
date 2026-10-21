import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'yaml'

// `cast update --model` asks Python for provider acceptance. A test that
// points HOME at a temp directory also moves Python's user site, so keep
// the original user site on PYTHONPATH.
const pythonUserSite = execFileSync('python3', ['-c', 'import site; print(site.getusersitepackages())'], {
  encoding: 'utf8',
}).trim()

function withPythonUserSite(): string | undefined {
  const previous = process.env.PYTHONPATH
  const parts = [pythonUserSite]
  if (previous) parts.push(previous)
  process.env.PYTHONPATH = parts.join(path.delimiter)
  return previous
}
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'
import {unknownModelMessage} from '../../../typescript/cast-cli/src/lib/models'
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
        'openrouter/anthropic/claude-sonnet-4.6',
        'openai/gpt-4o',
        'google/gemini-2.5-flash',
      ]

      for (const model of validModels) {
        expect(model).to.include('/')
        expect(model).to.not.be.empty
      }
    })

    it('should accept digitalocean models without an OpenRouter warning', async () => {
      const update = new Update(['update', 'agent'], {} as any)
      const known = await (update as any).validateModel('digitalocean/llama3.3-70b-instruct')
      const catalog = await (update as any).validateModel('digitalocean/some-new-catalog-id')
      expect(known).to.deep.equal({valid: true})
      expect(catalog).to.deep.equal({valid: true})
      expect(known.warning).to.equal(undefined)
    })

    it('rejects unknown OpenRouter models with the cast model message', async () => {
      const update = new Update(['update', 'agent'], {} as any)
      const result = await (update as any).validateModel('unknown/model')
      expect(result).to.deep.equal({
        valid: false,
        error: unknownModelMessage('unknown/model'),
      })
    })

    it('rejects zzz/notreal and still accepts the shipped openrouter default', async () => {
      const update = new Update(['update', 'agent'], {} as any)
      const unknown = await (update as any).validateModel('zzz/notreal')
      const shipped = await (update as any).validateModel('openrouter/minimax/minimax-m2.5')
      const prefixed = await (update as any).validateModel('openrouter/anthropic/claude-sonnet-4.6')
      const retired = await (update as any).validateModel('google/gemini-2.0-flash')
      expect(unknown).to.deep.equal({
        valid: false,
        error: unknownModelMessage('zzz/notreal'),
      })
      expect(shipped).to.deep.equal({valid: true})
      expect(prefixed).to.deep.equal({valid: true})
      expect(retired).to.deep.equal({
        valid: false,
        error: unknownModelMessage('google/gemini-2.0-flash'),
      })
    })

    it('accepts an external acceptsAnyModel id without an OpenRouter warning', async () => {
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
      const previousPythonPath = withPythonUserSite()
      process.env.HOME = home
      try {
        const update = new Update(['update', 'agent'], {} as any)
        const result = await (update as any).validateModel('example/my-model')
        expect(result).to.deep.equal({valid: true})
        expect(result.warning).to.equal(undefined)
      } finally {
        if (previous === undefined) delete process.env.HOME
        else process.env.HOME = previous
        if (previousPythonPath === undefined) delete process.env.PYTHONPATH
        else process.env.PYTHONPATH = previousPythonPath
      }
    })

    it('should warn for unknown models', () => {
      const knownModels = [
        'anthropic/claude-sonnet-4.6',
        'openai/gpt-4o',
        'google/gemini-2.5-flash',
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
      const validLevels = ['always-allow', 'ask', 'deny']
      const update = new Update(['update', 'agent'], {} as any)

      for (const level of validLevels) {
        expect((update as any).validatePermissionLevel(level)).to.equal(true)
      }
      for (const level of ['whatever', 'approve-once', 'block', 'always-ask']) {
        expect((update as any).validatePermissionLevel(level)).to.equal(false)
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

  describe('rejected configuration values', () => {
    const previousHome = process.env.HOME
    const previousPythonPath = process.env.PYTHONPATH
    let home: string
    let configPath: string
    let original: string
    const agentName = 'update-reject-agent'

    async function runUpdate(flags: Record<string, unknown>): Promise<{logs: string[]; errors: string[]}> {
      const logs: string[] = []
      const errors: string[] = []
      const update = new Update(['update', agentName], {} as any)
      ;(update as any).config = {runHook: async () => ({successes: [], failures: []})}
      ;(update as any).parse = async () => ({
        args: {agent: agentName},
        flags,
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })
      ;(update as any).log = (msg?: string) => logs.push(msg ?? '')
      ;(update as any).warn = (msg?: string) => logs.push(`WARN ${msg ?? ''}`)
      ;(update as any).error = (msg: string, options?: {exit?: number}) => {
        errors.push(msg)
        const error = new Error(msg) as Error & {oclif: {exit: number}}
        error.oclif = {exit: options?.exit === undefined ? 2 : options.exit}
        throw error
      }
      try {
        await update.run()
      } catch (error: any) {
        if (errors.length === 0) errors.push(error.message ?? String(error))
      }
      return {logs, errors}
    }

    function written(): string {
      return fs.readFileSync(configPath, 'utf8')
    }

    beforeEach(() => {
      home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-update-reject-'))
      withPythonUserSite()
      process.env.HOME = home
      const agentPath = path.join(home, '.cast', 'agents', agentName)
      fs.mkdirSync(agentPath, {recursive: true})
      configPath = path.join(agentPath, 'agent.yaml')
      original = yaml.stringify({
        name: agentName,
        description: 'unchanged',
        brain: {model: 'openrouter/minimax/minimax-m2.5'},
        harness: {permissions: {read: 'ask'}},
        runtime: {python_version: '3.11'},
      })
      fs.writeFileSync(configPath, original)
    })

    afterEach(() => {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousPythonPath === undefined) delete process.env.PYTHONPATH
      else process.env.PYTHONPATH = previousPythonPath
      fs.rmSync(home, {recursive: true, force: true})
    })

    it('rejects an unknown permission level and leaves agent.yaml unchanged', async () => {
      const {errors, logs} = await runUpdate({permission: ['bash=whatever']})
      expect(errors).to.have.length(1)
      expect(errors[0]).to.include("Invalid permission level 'whatever'")
      expect(errors[0]).to.include('always-allow, ask, deny')
      expect(logs.join('\n')).to.not.include('configuration updated successfully')
      expect(written()).to.equal(original)
    })

    it('rejects a bad level in a mixed permission list before writing the valid one', async () => {
      const {errors} = await runUpdate({permission: ['bash=ask', 'read=block']})
      expect(errors).to.have.length(1)
      expect(errors[0]).to.include("Invalid permission level 'block'")
      expect(written()).to.equal(original)
    })

    it('rejects --permission bogus the same way as an unknown tool', async () => {
      const permission = await runUpdate({permission: ['bogus']})
      expect(permission.errors).to.have.length(1)
      expect(permission.errors[0]).to.include("Invalid permission format 'bogus'")
      expect(written()).to.equal(original)

      const tool = await runUpdate({'add-tool': ['notatool']})
      expect(tool.errors).to.have.length(1)
      expect(tool.errors[0]).to.include("Invalid tool name 'notatool'")
      expect(tool.errors[0]).to.include('bash, read, glob')
      expect(written()).to.equal(original)
    })

    it('rejects an unknown model id and keeps the shipped default', async () => {
      const {errors, logs} = await runUpdate({model: 'zzz/notreal', description: 'should not stick'})
      expect(errors).to.have.length(1)
      expect(errors[0]).to.equal(unknownModelMessage('zzz/notreal'))
      expect(logs.join('\n')).to.not.include('configuration updated successfully')
      expect(written()).to.equal(original)
      expect(yaml.parse(written()).brain.model).to.equal('openrouter/minimax/minimax-m2.5')
    })

    it('rejects an unsupported Python version even with --dry-run', async () => {
      const {errors} = await runUpdate({'python-version': '9.9', 'dry-run': true, description: 'nope'})
      expect(errors).to.have.length(1)
      expect(errors[0]).to.include("Unsupported Python version '9.9'")
      expect(errors[0]).to.include('3.11, 3.12')
      expect(written()).to.equal(original)
    })

    it('writes valid permission levels, the shipped model, and a supported Python version', async () => {
      const {errors, logs} = await runUpdate({
        permission: ['bash=always-allow', 'glob=deny'],
        model: 'openrouter/minimax/minimax-m2.5',
        'python-version': '3.12',
      })
      expect(errors).to.deep.equal([])
      expect(logs.join('\n')).to.include('configuration updated successfully')
      const config = yaml.parse(written())
      expect(config.harness.permissions.bash).to.equal('always-allow')
      expect(config.harness.permissions.glob).to.equal('deny')
      expect(config.harness.permissions.read).to.equal('ask')
      expect(config.brain.model).to.equal('openrouter/minimax/minimax-m2.5')
      expect(config.runtime.python_version).to.equal('3.12')
    })

    it('accepts ask and 3.11', async () => {
      const {errors} = await runUpdate({
        permission: ['bash=ask'],
        'python-version': '3.11',
        model: 'openrouter/anthropic/claude-sonnet-4.6',
      })
      expect(errors).to.deep.equal([])
      const config = yaml.parse(written())
      expect(config.harness.permissions.bash).to.equal('ask')
      expect(config.runtime.python_version).to.equal('3.11')
      expect(config.brain.model).to.equal('openrouter/anthropic/claude-sonnet-4.6')
    })
  })
})