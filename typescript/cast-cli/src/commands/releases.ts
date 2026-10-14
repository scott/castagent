import {Args, Command, Flags} from '@oclif/core'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

interface ReleaseInfo {
  version: string
  change_number: number
  message: string
  changelog: string
  created_at: string
  tarball_path: string
}

export default class Releases extends Command {
  static description = 'List all releases of an agent'

  // `cast versions` is the deprecated predecessor of this command and
  // remains available for one release cycle as a backward-compatibility
  // alias. oclif will print a deprecation warning to stderr whenever the
  // alias is invoked (see #25).
  static aliases = ['versions']
  static deprecateAliases = true

  static examples = [
    '<%= config.bin %> <%= command.id %> my-agent',
    '<%= config.bin %> <%= command.id %> my-agent --json',
  ]

  static flags = {
    json: Flags.boolean({description: 'Output as JSON', default: false}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  private getReleasesFromFile(agentName: string): ReleaseInfo[] {
    const releasesJsonPath = path.join(os.homedir(), '.cast', 'agents', agentName, '.cast', 'releases', 'releases.json')
    if (!fs.existsSync(releasesJsonPath)) {
      return []
    }
    try {
      const data = JSON.parse(fs.readFileSync(releasesJsonPath, 'utf8'))
      return data.releases || []
    } catch {
      return []
    }
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Releases)
    const agentName = args.agent

    const releases = this.getReleasesFromFile(agentName)

    if (flags.json) {
      console.log(JSON.stringify(releases, null, 2))
      return
    }

    if (releases.length === 0) {
      this.log(`No releases found for agent '${agentName}'.`)
      this.log('Releases are created with: cast release <agent> <version>')
      return
    }

    // Get current release (most recent by created_at)
    const sortedReleases = [...releases].sort((a, b) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )
    const currentRelease = sortedReleases[0]

    this.log('')
    this.log(`Agent: ${agentName}`)
    this.log(`Current release: ${currentRelease?.version || 'none'}`)
    this.log('')
    this.log('Releases:')
    this.log('──────────────────────────────────────────────────────────────────────────────')

    for (const release of sortedReleases) {
      const date = new Date(release.created_at)
      const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
      this.log(`  ${release.version}  ${dateStr}  ${release.message}`)
    }

    this.log('──────────────────────────────────────────────────────────────────────────────')
    this.log('')
    this.log('Commands:')
    this.log(`  cast release ${agentName} <version>  - Create a new release`)
    this.log(`  cast deploy ${agentName} --version <ver>  - Deploy a specific release`)
    this.log(`  cast upgrade ${agentName} <ver>  - Upgrade to a release`)
  }
}
