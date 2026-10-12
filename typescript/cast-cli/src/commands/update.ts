import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as yaml from 'yaml'
import {db} from '../lib/sqlite'
import {createVersion} from '../lib/versioning'
import {inferenceModelStatus} from '../lib/deploy/deploy-utils'

const VALID_TOOLS = ['bash', 'read', 'glob']

export default class Update extends Command {
  static description = 'Update agent configuration'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent --model openrouter/anthropic/claude-3.7-sonnet',
    '<%= config.bin %> <%= command.id %> email-agent --description "Handles incoming emails"',
    '<%= config.bin %> <%= command.id %> email-agent --instructions-text "You are an email assistant."',
    '<%= config.bin %> <%= command.id %> email-agent --add-tool bash --add-tool read',
    '<%= config.bin %> <%= command.id %> email-agent --remove-tool glob',
    '<%= config.bin %> <%= command.id %> email-agent --add-principle "Be concise" --add-principle "Ask clarifying questions"',
    '<%= config.bin %> <%= command.id %> email-agent --permission bash=always-allow --permission read=ask',
    '<%= config.bin %> <%= command.id %> email-agent --python-version 3.12 --add-requirement requests',
  ]

  static flags = {
    model: Flags.string({
      description: 'Update LLM model (e.g., openrouter/anthropic/claude-3.7-sonnet)',
    }),
    description: Flags.string({
      description: 'Update agent description',
    }),
    version: Flags.string({
      description: 'Update agent version (e.g., 1.1.0)',
    }),
    instructions: Flags.string({
      description: 'Update system prompt from a file path',
    }),
    'instructions-text': Flags.string({
      description: 'Update system prompt directly from command line text',
    }),
    'add-tool': Flags.string({
      description: 'Add built-in tool (bash, read, glob)',
      multiple: true,
    }),
    'remove-tool': Flags.string({
      description: 'Remove built-in tool (bash, read, glob)',
      multiple: true,
    }),
    'add-principle': Flags.string({
      description: 'Add a principle to the agent harness',
      multiple: true,
    }),
    'remove-principle': Flags.string({
      description: 'Remove a principle from the agent harness by exact text match',
      multiple: true,
    }),
    permission: Flags.string({
      description: 'Set a permission (format: tool=level, e.g., bash=always-allow)',
      multiple: true,
    }),
    'remove-permission': Flags.string({
      description: 'Remove a permission by tool name',
      multiple: true,
    }),
    'python-version': Flags.string({
      description: 'Update runtime Python version (e.g., 3.11, 3.12)',
    }),
    'add-requirement': Flags.string({
      description: 'Add a Python package requirement',
      multiple: true,
    }),
    'remove-requirement': Flags.string({
      description: 'Remove a Python package requirement',
      multiple: true,
    }),
    'dry-run': Flags.boolean({
      description: 'Preview changes without writing to disk',
      default: false,
    }),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  private validateToolName(tool: string): boolean {
    return VALID_TOOLS.includes(tool)
  }

  private validateModel(model: string): {valid: boolean; warning?: string} {
    return inferenceModelStatus(model)
  }

  private parsePermission(perm: string): {tool: string; level: string} | null {
    const parts = perm.split('=')
    if (parts.length !== 2) {
      return null
    }

    return {tool: parts[0].trim(), level: parts[1].trim()}
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Update)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    const agentYamlPath = path.join(agentPath, 'agent.yaml')

    // Validate agent exists
    if (!fs.existsSync(agentPath)) {
      this.error(
        `Agent '${agentName}' not found at ${agentPath}.\n` +
        `Create the agent first with: cast dev ${agentName} --no-tui`
      )
    }

    if (!fs.existsSync(agentYamlPath)) {
      this.error(
        `Agent YAML not found at ${agentYamlPath}.\n` +
        `The agent directory may be corrupted. Try recreating the agent.`
      )
    }

    // Parse YAML with error handling
    let config: any
    try {
      const content = fs.readFileSync(agentYamlPath, 'utf8')
      config = yaml.parse(content) || {}
    } catch (error: any) {
      this.error(
        `Failed to parse agent.yaml: ${error.message}\n` +
        `Please fix the YAML syntax and try again.`
      )
    }

    // Validate tool names before making changes
    const toolsToAdd = flags['add-tool'] || []
    const toolsToRemove = flags['remove-tool'] || []
    const allTools = [...toolsToAdd, ...toolsToRemove]
    for (const tool of allTools) {
      if (!this.validateToolName(tool)) {
        this.error(
          `Invalid tool name '${tool}'.\n` +
          `Valid tools: ${VALID_TOOLS.join(', ')}`
        )
      }
    }

    // Validate permissions format
    const permissionsToSet = flags.permission || []
    for (const perm of permissionsToSet) {
      if (!this.parsePermission(perm)) {
        this.error(
          `Invalid permission format '${perm}'.\n` +
          `Use the format: tool=level (e.g., bash=always-allow, read=ask)`
        )
      }
    }

    let modified = false
    const changes: string[] = []

    // --model
    if (flags.model) {
      const validation = this.validateModel(flags.model)
      if (validation.warning) {
        this.warn(validation.warning)
      }

      if (!config.brain) config.brain = {}
      config.brain.model = flags.model
      changes.push(`Model: ${flags.model}`)
      modified = true
    }

    // --description
    if (flags.description !== undefined) {
      config.description = flags.description
      changes.push(`Description: ${flags.description}`)
      modified = true
    }

    // --version
    if (flags.version) {
      config.version = flags.version
      changes.push(`Version: ${flags.version}`)
      modified = true
    }

    // --instructions (from file)
    if (flags.instructions) {
      const instructionsPath = path.resolve(flags.instructions)
      if (!fs.existsSync(instructionsPath)) {
        this.error(`Instructions file not found: ${instructionsPath}`)
      }

      const instructions = fs.readFileSync(instructionsPath, 'utf8')
      const instructionsFileName = path.basename(instructionsPath)
      const targetInstructionsPath = path.join(agentPath, instructionsFileName)

      // If it's a different file, copy it to agent directory
      if (instructionsPath !== targetInstructionsPath) {
        fs.writeFileSync(targetInstructionsPath, instructions, 'utf8')
      }

      if (!config.brain) config.brain = {}
      config.brain.instructions_file = instructionsFileName
      changes.push(`Instructions file: ${instructionsFileName}`)
      modified = true
    }

    // --instructions-text (inline)
    if (flags['instructions-text'] !== undefined) {
      const instructionsPath = path.join(agentPath, 'instructions.md')
      fs.writeFileSync(instructionsPath, flags['instructions-text'], 'utf8')

      if (!config.brain) config.brain = {}
      config.brain.instructions_file = 'instructions.md'
      // Truncate for display
      const preview = flags['instructions-text'].length > 50
        ? flags['instructions-text'].slice(0, 50) + '...'
        : flags['instructions-text']
      changes.push(`Instructions: "${preview}"`)
      modified = true
    }

    // --add-tool
    if (toolsToAdd.length > 0) {
      if (!config.tools) config.tools = {}
      if (!config.tools.builtin) config.tools.builtin = []
      for (const tool of toolsToAdd) {
        if (!config.tools.builtin.includes(tool)) {
          config.tools.builtin.push(tool)
          changes.push(`Added tool: ${tool}`)
        } else {
          this.log(`Tool '${tool}' already exists`)
        }
      }

      modified = true
    }

    // --remove-tool
    if (toolsToRemove.length > 0) {
      if (config.tools?.builtin) {
        for (const tool of toolsToRemove) {
          const idx = config.tools.builtin.indexOf(tool)
          if (idx >= 0) {
            config.tools.builtin.splice(idx, 1)
            changes.push(`Removed tool: ${tool}`)
          } else {
            this.log(`Tool '${tool}' not found`)
          }
        }

        modified = true
      }
    }

    // --add-principle
    const principlesToAdd = flags['add-principle'] || []
    if (principlesToAdd.length > 0) {
      if (!config.harness) config.harness = {}
      if (!config.harness.principles) config.harness.principles = []
      for (const principle of principlesToAdd) {
        if (!config.harness.principles.includes(principle)) {
          config.harness.principles.push(principle)
          changes.push(`Added principle: ${principle}`)
        } else {
          this.log(`Principle '${principle}' already exists`)
        }
      }

      modified = true
    }

    // --remove-principle
    const principlesToRemove = flags['remove-principle'] || []
    if (principlesToRemove.length > 0) {
      if (config.harness?.principles) {
        for (const principle of principlesToRemove) {
          const idx = config.harness.principles.indexOf(principle)
          if (idx >= 0) {
            config.harness.principles.splice(idx, 1)
            changes.push(`Removed principle: ${principle}`)
          } else {
            this.log(`Principle '${principle}' not found`)
          }
        }

        modified = true
      }
    }

    // --permission
    if (permissionsToSet.length > 0) {
      if (!config.harness) config.harness = {}
      if (!config.harness.permissions) config.harness.permissions = {}
      for (const perm of permissionsToSet) {
        const parsed = this.parsePermission(perm)!
        const prev = config.harness.permissions[parsed.tool]
        config.harness.permissions[parsed.tool] = parsed.level
        if (prev) {
          changes.push(`Updated permission: ${parsed.tool}=${parsed.level} (was ${prev})`)
        } else {
          changes.push(`Set permission: ${parsed.tool}=${parsed.level}`)
        }
      }

      modified = true
    }

    // --remove-permission
    const permissionsToRemove = flags['remove-permission'] || []
    if (permissionsToRemove.length > 0) {
      if (config.harness?.permissions) {
        for (const tool of permissionsToRemove) {
          if (tool in config.harness.permissions) {
            delete config.harness.permissions[tool]
            changes.push(`Removed permission: ${tool}`)
          } else {
            this.log(`Permission '${tool}' not found`)
          }
        }

        modified = true
      }
    }

    // --python-version
    if (flags['python-version']) {
      if (!config.runtime) config.runtime = {}
      config.runtime.python_version = flags['python-version']
      changes.push(`Python version: ${flags['python-version']}`)
      modified = true
    }

    // --add-requirement
    const requirementsToAdd = flags['add-requirement'] || []
    if (requirementsToAdd.length > 0) {
      if (!config.runtime) config.runtime = {}
      if (!config.runtime.requirements) config.runtime.requirements = []
      for (const req of requirementsToAdd) {
        if (!config.runtime.requirements.includes(req)) {
          config.runtime.requirements.push(req)
          changes.push(`Added requirement: ${req}`)
        } else {
          this.log(`Requirement '${req}' already exists`)
        }
      }

      modified = true
    }

    // --remove-requirement
    const requirementsToRemove = flags['remove-requirement'] || []
    if (requirementsToRemove.length > 0) {
      if (config.runtime?.requirements) {
        for (const req of requirementsToRemove) {
          const idx = config.runtime.requirements.indexOf(req)
          if (idx >= 0) {
            config.runtime.requirements.splice(idx, 1)
            changes.push(`Removed requirement: ${req}`)
          } else {
            this.log(`Requirement '${req}' not found`)
          }
        }

        modified = true
      }
    }

    // Show changes preview
    if (changes.length > 0) {
      this.log('')
      this.log('Proposed changes:')
      this.log('───────────────────────────────────────────────────────────────')
      for (const change of changes) {
        this.log(`  + ${change}`)
      }
      this.log('───────────────────────────────────────────────────────────────')
      this.log('')
    }

    if (!modified) {
      this.log('No changes made. Use flags to update configuration.')
      this.log('')
      this.log('Examples:')
      this.log(`  cast update ${agentName} --model openrouter/anthropic/claude-3.7-sonnet`)
      this.log(`  cast update ${agentName} --description "My helpful agent"`)
      this.log(`  cast update ${agentName} --add-tool bash --remove-tool glob`)
      this.log(`  cast update ${agentName} --permission bash=always-allow`)
      return
    }

    // Dry run mode
    if (flags['dry-run']) {
      this.log('Dry run mode - no changes written.')
      return
    }

    // Apply changes
    try {
      fs.writeFileSync(agentYamlPath, yaml.stringify(config), 'utf8')
      db.updateAgent(agentName, {agent_yaml_path: agentYamlPath})
      this.log(`Agent '${agentName}' configuration updated successfully.`)

      // Create a version record for the changes
      const versionMessage = changes.length > 0
        ? `Updated: ${changes.join(', ')}`
        : 'Updated configuration'
      await createVersion(agentName, 'cli', versionMessage)
    } catch (error: any) {
      this.error(`Failed to save agent configuration: ${error.message}`)
    }
  }
}
