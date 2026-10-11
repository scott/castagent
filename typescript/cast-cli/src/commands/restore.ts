import {Args, Command, Flags} from '@oclif/core'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as tar from 'tar'
import {listReleases} from '../lib/releases'

export default class Restore extends Command {
  static description = 'Restore an agent to a previous release'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent --release 1.0',
  ]

  static flags = {
    release: Flags.string({description: 'Restore to a specific release version', required: true}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Restore)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}.`)
    }

    const releases = await listReleases(agentName)
    const release = releases.find(r => r.version === flags.release)

    if (!release) {
      this.error(`Release ${flags.release} not found for agent '${agentName}'.`)
    }

    this.log(`Restoring ${agentName} to release ${flags.release}...`)

    // Extract the release tarball
    await tar.extract({file: release.tarball_path, cwd: agentPath})

    this.log(`Restored to release ${flags.release}.`)
    this.log('Note: This restored local files only. Use /deploy to update deployment.')
  }
}