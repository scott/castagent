import {Command, Flags} from '@oclif/core'
import {execSync} from 'child_process'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'

export default class Migrate extends Command {
  static description = 'Migrate to the new versioning system'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --live',
  ]

  static flags = {
    live: Flags.boolean({
      char: 'l',
      description: 'Apply migration (default is dry-run)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const {flags} = await this.parse(Migrate)
    const mode = flags.live ? 'LIVE' : 'DRY RUN'

    this.log('')
    this.log('╔══════════════════════════════════════════════════════════════╗')
    this.log('║         Cast Versioning System Migration                     ║')
    this.log('╚══════════════════════════════════════════════════════════════╝')
    this.log('')
    this.log(`Mode: ${mode}`)
    this.log('')

    // Find the cast Python module path
    const castPythonPath = path.join(os.homedir(), '.cast', 'python')
    const sourceCastDir = path.join(__dirname, '..', '..', '..', '..', 'python', 'cast')
    const destCastDir = path.join(castPythonPath, 'cast')

    // Ensure the cast directory exists
    if (!fs.existsSync(destCastDir)) {
      fs.mkdirSync(destCastDir, {recursive: true})
    }

    // Files that need to be copied for migration to work
    const filesToCopy = [
      'migrate.py',
      'releases.py',
      'versioning.py',
      '__init__.py',
    ]

    let filesInstalled = false
    for (const file of filesToCopy) {
      const sourcePath = path.join(sourceCastDir, file)
      const destPath = path.join(destCastDir, file)
      if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath)
        filesInstalled = true
      }
    }

    if (filesInstalled) {
      this.log('Installed Python modules to ~/.cast/python/cast/')
      this.log('')
    } else {
      this.log('Warning: Could not find Python source files to install.')
      this.log('')
    }

    // Run Python migration script
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
    const script = [
      `import sys`,
      `sys.path.insert(0, '${castPythonPath}')`,
      `from cast.migrate import run_migration`,
      `run_migration(dry_run=${flags.live ? 'False' : 'True'}, verbose=True)`,
    ].join('; ')

    try {
      execSync(`${pythonCmd} -c "${script}"`, {
        cwd: os.homedir(),
        stdio: 'inherit',
      })
    } catch (error: any) {
      this.error(`Migration failed: ${error.message}`)
    }

    if (!flags.live) {
      this.log('')
      this.log('Run with --live to apply the migration.')
    }
  }
}