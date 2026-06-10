import {Args, Command} from '@oclif/core'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as yaml from 'yaml'
import {db} from '../lib/sqlite'

export default class Describe extends Command {
  static description = 'Show agent description and details'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
  ]

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args} = await this.parse(Describe)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    // Check if agent exists
    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
      return
    }

    // Read agent.yaml
    const agentYamlPath = path.join(agentPath, 'agent.yaml')
    if (!fs.existsSync(agentYamlPath)) {
      this.error(`Agent '${agentName}' is missing agent.yaml`)
      return
    }

    const agentConfig = yaml.parse(fs.readFileSync(agentYamlPath, 'utf8'))

    // Read instructions if they exist
    let instructions = ''
    const instructionsFile = agentConfig.brain?.instructions_file || 'instructions.md'
    const instructionsPath = path.join(agentPath, instructionsFile)
    if (fs.existsSync(instructionsPath)) {
      instructions = fs.readFileSync(instructionsPath, 'utf8')
    }

    // Get status from database
    const localAgent = db.getLocalAgent(agentName)
    const deployments = db.listDeployments(agentName)

    let status = '[local: stopped]'
    if (deployments.length > 0) {
      status = `[deployed: ${deployments.length} deployment(s)]`
    } else if (localAgent?.port) {
      status = `[local: running on port ${localAgent.port}]`
    }

    // Format output
    this.log('')
    this.log(`╔══════════════════════════════════════════════════════════════╗`)
    this.log(`║  ${agentName.padEnd(57)} ║`)
    this.log(`╚══════════════════════════════════════════════════════════════╝`)
    this.log('')

    // Basic info
    this.log('📋 Description')
    this.log('───────────────────────────────────────────────────────────────')
    this.log(agentConfig.description || 'No description provided')
    this.log('')

    // Status
    this.log('🟢 Status')
    this.log('───────────────────────────────────────────────────────────────')
    this.log(`  ${status}`)
    this.log('')

    // Deployment
    this.log('🚀 Deployment')
    this.log('───────────────────────────────────────────────────────────────')
    if (deployments.length > 0) {
      this.log(`  SHA       PROVIDER   VERSION   DEPLOYED               URL`)
      this.log(`  ──────────────────────────────────────────────────────────────────────────────`)
      for (const deployment of deployments) {
        const deployedDate = deployment.deployed_at
          ? new Date(deployment.deployed_at).toLocaleDateString('en-US', {year: 'numeric', month: 'short', day: 'numeric'})
          : 'unknown'
        const version = deployment.deployed_version || 'latest'
        const url = deployment.deployment_url || 'N/A'
        const provider = (deployment.provider || 'unknown').padEnd(8)
        this.log(`  ${deployment.id}  ${provider}   ${version.padEnd(8)} ${deployedDate.padEnd(20)} ${url}`)
      }
      this.log('')
      this.log(`  Use 'cast connect <sha>' to connect to a specific deployment`)
    } else {
      this.log('  Status: Not deployed')
      this.log(`  (Run 'cast deploy ${agentName}' to deploy)`)
    }
    this.log('')

    // Model
    this.log('🧠 Model')
    this.log('───────────────────────────────────────────────────────────────')
    this.log(`  ${agentConfig.brain?.model || 'Not configured'}`)
    this.log('')

    // Tools
    this.log('🛠️  Tools')
    this.log('───────────────────────────────────────────────────────────────')
    const builtinTools = agentConfig.tools?.builtin || []
    const mcpServers = (agentConfig.tools?.mcp || []).map((m: any) => m.server)
    const customTools = (agentConfig.tools?.custom || []).map((c: any) => c.path)

    if (builtinTools.length > 0) {
      this.log(`  Built-in: ${builtinTools.join(', ')}`)
    }
    if (mcpServers.length > 0) {
      this.log(`  MCP: ${mcpServers.join(', ')}`)
    }
    if (customTools.length > 0) {
      this.log(`  Custom: ${customTools.join(', ')}`)
    }
    if (builtinTools.length === 0 && mcpServers.length === 0 && customTools.length === 0) {
      this.log('  No tools configured')
    }
    this.log('')

    // Instructions
    if (instructions) {
      this.log('📝 Instructions Preview')
      this.log('───────────────────────────────────────────────────────────────')
      // Show first 10 lines, then truncate if longer
      const lines = instructions.split('\n')
      const previewLines = lines.slice(0, 10)
      previewLines.forEach(line => {
        // Wrap long lines
        if (line.length > 60) {
          this.log(`  ${line.substring(0, 57)}...`)
        } else {
          this.log(`  ${line}`)
        }
      })
      if (lines.length > 10) {
        this.log(`  ... (${lines.length - 10} more lines)`)
      }
      this.log('')

      // Full instructions content
      this.log('📝 Instructions (Full)')
      this.log('───────────────────────────────────────────────────────────────')
      this.log('```markdown')
      this.log(instructions)
      this.log('```')
      this.log('')
    }

    // Permissions
    this.log('🔒 Permissions')
    this.log('───────────────────────────────────────────────────────────────')
    const permissions = agentConfig.harness?.permissions || {}
    const permEntries = Object.entries(permissions)
    if (permEntries.length > 0) {
      permEntries.forEach(([key, value]) => {
        this.log(`  ${key.padEnd(30)} ${value}`)
      })
    } else {
      this.log('  No permissions configured')
    }
    this.log('')

    // Full agent.yaml content
    this.log('📄 Agent Configuration (Full)')
    this.log('───────────────────────────────────────────────────────────────')
    const formattedYaml = yaml.stringify(agentConfig, {indent: 2, lineWidth: 0})
    this.log('```yaml')
    this.log(formattedYaml)
    this.log('```')
    this.log('')

    // Location
    this.log('📁 Location')
    this.log('───────────────────────────────────────────────────────────────')
    this.log(`  ${agentPath}`)
    this.log('')

    // Quick actions
    this.log('⚡ Quick Actions')
    this.log('───────────────────────────────────────────────────────────────')
    if (localAgent?.port) {
      this.log(`  cast stop ${agentName}              Stop this agent`)
    } else {
      this.log(`  cast dev ${agentName}               Start this agent`)
    }
    this.log(`  cast deploy ${agentName}            Deploy to cloud`)
    this.log(`  cast update ${agentName}            Update configuration`)
    this.log('')
  }
}
