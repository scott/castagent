import {Args, Command, Flags} from '@oclif/core'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import {createRelease, validateSemver, suggestVersion, listReleases} from '../lib/releases'
import {db} from '../lib/sqlite'

export default class Release extends Command {
  static description = 'Create a semantic release for an agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent 1.6',
    '<%= config.bin %> <%= command.id %> my-agent 1.6 --message "Added feature"',
  ]

  static flags = {
    message: Flags.string({description: 'Release message'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
    version: Args.string({description: 'Semantic version (e.g., 1.6, 2.0.0)', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Release)
    const agentName = args.agent
    const version = args.version
    const message = flags.message || ''

    // Validate agent exists
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}.`)
    }

    // Validate semantic version format
    const isValid = await validateSemver(version)
    if (!isValid) {
      this.error(`Invalid semantic version: '${version}'. Expected format: 1.0, 1.6, 2.0.0`)
    }

    // Check if version already exists
    const existingRelease = await listReleases(agentName)
    if (existingRelease.some(r => r.version === version)) {
      this.error(`Release ${version} already exists for agent '${agentName}'.`)
    }

    this.log(`Creating release ${version} for agent '${agentName}'...`)

    try {
      // Create the release
      const release = await createRelease(agentName, version, message)

      // Store in database
      db.createRelease(agentName, release.version, release.change_number, release.message, release.changelog, release.tarball_path)

      this.log('')
      this.log('╔══════════════════════════════════════════════════════════════╗')
      this.log('║                  Release Created!                              ║')
      this.log('╚══════════════════════════════════════════════════════════════╝')
      this.log('')
      this.log(`Agent: ${agentName}`)
      this.log(`Version: ${release.version}`)
      this.log(`Change: v${release.change_number}`)
      this.log(`Message: ${release.message}`)
      if (release.changelog) {
        this.log('')
        this.log('Changelog:')
        this.log('───────────────────────────────────────────────────────────────')
        this.log(release.changelog)
        this.log('───────────────────────────────────────────────────────────────')
      }
      this.log('')
      this.log(`Tarball: ${release.tarball_path}`)
      this.log('')
    } catch (error: any) {
      this.error(`Failed to create release: ${error.message || error}`)
    }
  }
}