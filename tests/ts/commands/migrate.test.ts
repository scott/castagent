import {expect} from 'chai'
import * as path from 'path'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
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
})
