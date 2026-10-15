import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import MigrateCommand, {MIGRATION_PYTHON_FILES} from '../../../typescript/cast-cli/src/commands/migrate'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

function command(live: boolean): MigrateCommand {
  const argv = live ? ['migrate', '--live'] : ['migrate']
  const instance = new MigrateCommand(argv, {color: false} as any) as any
  instance.parse = async () => ({flags: {live}, args: {}, argv, raw: []})
  instance.error = (message?: string) => {
    throw new Error(message ?? 'migrate failed')
  }
  return instance
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-migrate-'))
  const previous = process.env.HOME
  process.env.HOME = home
  try {
    await run(home)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
  }
}

describe('migrate command', () => {
  let Migrate: any

  before(async () => {
    Migrate = await loadTestCommand('migrate')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Migrate.description).to.include('Migrate')
    })

    it('should have --live flag', () => {
      expect(Migrate.flags.live).to.exist
      expect(Migrate.flags.live.default).to.equal(false)
    })

    it('should have -l short flag for live', () => {
      expect(Migrate.flags.live.char).to.equal('l')
    })

    it('should have examples', () => {
      expect(Migrate.examples).to.be.an('array')
      expect(Migrate.examples.length).to.be.greaterThan(0)
    })

    it('should include --live example', () => {
      const hasLiveExample = Migrate.examples.some((ex: string) => ex.includes('--live'))
      expect(hasLiveExample).to.be.true
    })
  })

  describe('python modules', () => {
    it('copies tar_safety and castignore with the migration package', () => {
      expect(MIGRATION_PYTHON_FILES).to.include('tar_safety.py')
      expect(MIGRATION_PYTHON_FILES).to.include('castignore.py')
    })

    it('dry-run imports the copied package', async () => {
      await withHome(async (home) => {
        await command(false).run()
        const copied = path.join(home, '.cast', 'python', 'cast')
        for (const file of MIGRATION_PYTHON_FILES) {
          expect(fs.existsSync(path.join(copied, file)), file).to.equal(true)
        }
      })
    })

    it('live migration writes memory config for an agent', async () => {
      await withHome(async (home) => {
        const agent = path.join(home, '.cast', 'agents', 'migrate-fixture')
        fs.mkdirSync(agent, {recursive: true})
        fs.writeFileSync(path.join(agent, 'agent.yaml'), 'name: migrate-fixture\nversion: "1.0"\n')

        await command(true).run()

        expect(fs.existsSync(path.join(agent, 'memory', 'config.yaml'))).to.equal(true)
        expect(fs.existsSync(path.join(agent, '.cast', 'changes', 'changes.json'))).to.equal(true)
      })
    })
  })
})
