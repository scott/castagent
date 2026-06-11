import {expect} from 'chai'
import * as path from 'path'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`,
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

describe('version command', () => {
  let Version: any

  before(async () => {
    Version = await loadTestCommand('version')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Version.description).to.be.a('string')
      expect(Version.description).to.include('version')
    })

    it('should have no arguments', () => {
      // The version command takes no args — args may be {} (oclif default)
      // or undefined, but it should not declare any argument keys.
      if (Version.args) {
        expect(Object.keys(Version.args)).to.have.length(0)
      }
    })

    it('should have no flags', () => {
      // The version command takes no flags
      expect(Version.flags).to.be.undefined
    })

    it('should have an example', () => {
      expect(Version.examples).to.be.an('array')
      expect(Version.examples.length).to.be.greaterThan(0)
    })
  })

  describe('command behavior', () => {
    it('should log the value of config.version', async () => {
      const instance = new Version(['version'], {} as any)
      instance.config = {
        version: '1.2.3',
        runHook: async () => ({successes: [], failures: []}),
      }
      instance.parse = async () => ({
        args: {},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()

      expect(logs).to.have.length(1)
      expect(logs[0]).to.equal('1.2.3')
    })

    it('should handle semver-like version strings', async () => {
      const instance = new Version(['version'], {} as any)
      instance.config = {
        version: '0.1.0-beta.2',
        runHook: async () => ({successes: [], failures: []}),
      }
      instance.parse = async () => ({
        args: {},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()

      expect(logs[0]).to.equal('0.1.0-beta.2')
    })

    it('should call parse exactly once', async () => {
      const instance = new Version(['version'], {} as any)
      instance.config = {
        version: '9.9.9',
        runHook: async () => ({successes: [], failures: []}),
      }
      let parseCount = 0
      instance.parse = async () => {
        parseCount += 1
        return {
          args: {},
          flags: {},
          argv: [],
          raw: [],
          metadata: {},
          nonExistentFlags: [],
        }
      }
      instance.log = () => {}
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()

      expect(parseCount).to.equal(1)
    })

    it('should propagate errors from log if config.version is missing', async () => {
      // Defensive test: if config.version is undefined, this.log should
      // still be called with undefined rather than throwing inside the
      // command. We assert behavior matches the trivial implementation.
      const instance = new Version(['version'], {} as any)
      instance.config = {
        version: undefined,
        runHook: async () => ({successes: [], failures: []}),
      }
      instance.parse = async () => ({
        args: {},
        flags: {},
        argv: [],
        raw: [],
        metadata: {},
        nonExistentFlags: [],
      })

      const logs: string[] = []
      instance.log = (msg: string) => {
        logs.push(msg)
      }
      instance.error = (msg: string) => {
        throw new Error(msg)
      }

      await instance.run()

      // Command logs this.config.version verbatim, even if undefined.
      expect(logs).to.have.length(1)
      expect(logs[0]).to.be.undefined
    })
  })
})
