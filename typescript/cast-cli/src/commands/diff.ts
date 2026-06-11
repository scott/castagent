import {Args, Command, Flags} from '@oclif/core'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {execSync} from 'child_process'

interface VersionInfo {
  id: number
  timestamp: string
  source: string
  message: string
}

interface VersionsJson {
  current: number
  versions: VersionInfo[]
}

export default class Diff extends Command {
  static description = 'Compare two versions of an agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent 1 3',
    '<%= config.bin %> <%= command.id %> my-agent --summary',
  ]

  static flags = {
    summary: Flags.boolean({
      description: 'Show only summary of changes',
      default: false,
    }),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
    version1: Args.integer({description: 'First version to compare (or latest if not specified)', required: false}),
    version2: Args.integer({description: 'Second version to compare (or current if not specified)', required: false}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Diff)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    // Validate agent exists
    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}`)
    }

    const versionsJsonPath = path.join(agentPath, '.cast', 'versions', 'versions.json')

    if (!fs.existsSync(versionsJsonPath)) {
      this.error(`No versions found for agent '${agentName}'. Cannot diff.`)
    }

    try {
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsJsonPath, 'utf8'))

      if (data.versions.length < 2) {
        this.error(`Need at least 2 versions to compare. Found ${data.versions.length}.`)
      }

      // Determine which versions to compare
      let v1: number, v2: number

      if (args.version1 !== undefined && args.version2 !== undefined) {
        v1 = args.version1
        v2 = args.version2
      } else if (args.version1 !== undefined) {
        v1 = args.version1
        v2 = data.current
      } else {
        // Compare previous version with current
        v1 = data.versions.length >= 2 ? data.versions[data.versions.length - 2].id : 1
        v2 = data.current
      }

      // Validate versions exist
      const version1Data = data.versions.find(v => v.id === v1)
      const version2Data = data.versions.find(v => v.id === v2)

      if (!version1Data) {
        this.error(`Version ${v1} not found.`)
      }
      if (!version2Data) {
        this.error(`Version ${v2} not found.`)
      }

      this.log('')
      this.log(`Comparing v${v1} → v${v2} for agent '${agentName}'`)
      this.log('──────────────────────────────────────────────────────────────────────────────')
      this.log('')

      // Call Python to get diff
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'

      const script = `
import sys
import json
sys.path.insert(0, '${path.join(os.homedir(), '.cast', 'python')}')
from cast.versioning import diff_versions
result = diff_versions('${agentName}', ${v1}, ${v2})
print(json.dumps(result))
`

      const output = execSync(
        `${pythonCmd} -c "${script.replace(/\n/g, ';').replace(/^\s*;/, '').trim()}"`,
        {
          cwd: os.homedir(),
          encoding: 'utf8',
        },
      )

      const diffResult = JSON.parse(output)
      let hasChanges = false

      for (const [file, info] of Object.entries(diffResult)) {
        const fileInfo = info as any

        if (file === 'mcp') {
          // Handle MCP directory changes
          for (const [mcpFile, mcpInfo] of Object.entries(fileInfo)) {
            const mcpChange = mcpInfo as any
            hasChanges = true
            if (flags.summary) {
              this.log(`  mcp/${mcpFile}: ${mcpChange.v1_exists !== mcpChange.v2_exists ? (mcpChange.v1_exists ? 'DELETED' : 'ADDED') : 'CHANGED'}`)
            } else {
              this.log(`MCP: ${mcpFile}`)
              if (mcpChange.v1_exists !== mcpChange.v2_exists) {
                this.log(`  ${mcpChange.v1_exists ? 'Removed' : 'Added'} in v${v2}`)
              } else {
                this.log('  Changed')
              }
            }
          }
        } else {
          // Handle regular file changes
          hasChanges = true
          if (flags.summary) {
            this.log(`  ${file}: ${fileInfo.v1_exists !== fileInfo.v2_exists ? (fileInfo.v1_exists ? 'DELETED' : 'ADDED') : 'CHANGED'}`)
          } else {
            this.log(`File: ${file}`)
            if (fileInfo.v1_exists !== fileInfo.v2_exists) {
              this.log(`  ${fileInfo.v1_exists ? 'Removed' : 'Added'} in v${v2}`)
            } else {
              // Show a brief preview of the changes
              const v1Preview = fileInfo.v1_content?.substring(0, 100) || '(empty)'
              const v2Preview = fileInfo.v2_content?.substring(0, 100) || '(empty)'
              this.log(`  v${v1}: ${v1Preview}...`)
              this.log(`  v${v2}: ${v2Preview}...`)
            }
          }
        }
      }

      if (!hasChanges) {
        this.log('No differences found.')
      }

      this.log('──────────────────────────────────────────────────────────────────────────────')

      // Show version info
      this.log('')
      this.log(`v${v1}: ${version1Data.message} (${version1Data.timestamp})`)
      this.log(`v${v2}: ${version2Data.message} (${version2Data.timestamp})`)
    } catch (error: any) {
      this.error(`Failed to compare versions: ${error.message}`)
    }
  }
}