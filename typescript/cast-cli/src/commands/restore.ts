import {Args, Command, Flags} from '@oclif/core'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as tar from 'tar'
import {listReleases} from '../lib/releases'
import {listVersions, getCurrentVersion} from '../lib/versioning'

export default class Restore extends Command {
  static description = 'Restore agent to a previous change or release'

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent --change 5',
    '<%= config.bin %> <%= command.id %> my-agent --release 1.0',
  ]

  static flags = {
    change: Flags.integer({description: 'Restore to specific change number'}),
    release: Flags.string({description: 'Restore to specific release version'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Restore)
    const agentName = args.agent
    const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)

    // Validate agent exists
    if (!fs.existsSync(agentPath)) {
      this.error(`Agent '${agentName}' not found at ${agentPath}.`)
    }

    // Determine source
    const sourceChange = flags.change
    const sourceRelease = flags.release

    if (!sourceChange && !sourceRelease) {
      this.error('Specify either --change or --release')
    }

    if (sourceChange && sourceRelease) {
      this.error('Specify only one of --change or --release, not both')
    }

    if (sourceChange) {
      await this.restoreFromChange(agentName, agentPath, sourceChange)
    } else if (sourceRelease) {
      await this.restoreFromRelease(agentName, agentPath, sourceRelease)
    }
  }

  private async restoreFromChange(agentName: string, agentPath: string, changeNumber: number): Promise<void> {
    const changesDir = path.join(agentPath, '.cast', 'changes')
    const tarballPath = path.join(changesDir, `${changeNumber.toString().padStart(3, '0')}.tar.gz`)

    if (!fs.existsSync(tarballPath)) {
      this.error(`Change ${changeNumber} not found at ${tarballPath}`)
    }

    const currentVersion = await getCurrentVersion(agentName)
    this.log(`Restoring ${agentName} from change v${currentVersion} to change v${changeNumber}...`)

    // Extract the tarball
    await tar.extract({file: tarballPath, cwd: agentPath})

    this.log(`Restored to change v${changeNumber}.`)
    this.log('Note: This restored local files only. Use /deploy to update deployment.')
  }

  private async restoreFromRelease(agentName: string, agentPath: string, version: string): Promise<void> {
    const releases = await listReleases(agentName)
    const release = releases.find(r => r.version === version)

    if (!release) {
      this.error(`Release ${version} not found for agent '${agentName}'.`)
    }

    this.log(`Restoring ${agentName} to release ${version}...`)

    // Extract the release tarball
    await tar.extract({file: release.tarball_path, cwd: agentPath})

    this.log(`Restored to release ${version}.`)
    this.log('Note: This restored local files only. Use /deploy to update deployment.')
  }
}