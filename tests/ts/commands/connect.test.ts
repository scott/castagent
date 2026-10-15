import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

// Helper function to load command
async function loadTestCommand(commandName: string): Promise<any> {
  const path = require('path')
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

describe('connect command', () => {
  let Connect: any

  before(async () => {
    Connect = await loadTestCommand('connect')
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Connect.description).to.equal('Connect to deployed agent')
    })

    it('should have agent name argument', () => {
      expect(Connect.args).to.exist
      expect(Connect.args.agent).to.exist
      expect(Connect.args.agent.description).to.equal('Agent name or deployment SHA')
      expect(Connect.args.agent.required).to.be.true
    })

    it('should have proxy flag', () => {
      const proxyFlag = Connect.flags.proxy
      expect(proxyFlag).to.exist
      expect(proxyFlag.description).to.equal('Use sprite proxy for sprites deployments')
      expect(proxyFlag.default).to.equal(false)
    })

    it('should have examples', () => {
      expect(Connect.examples).to.not.be.empty
    })
  })

  describe('helper methods', () => {
    it('should have resolveBun method', () => {
      const instance = new Connect(['test-agent'], {color: false})
      expect(typeof instance.resolveBun).to.equal('function')
    })

    it('should have resolveSprite method', () => {
      const instance = new Connect(['test-agent'], {color: false})
      expect(typeof instance.resolveSprite).to.equal('function')
    })

    it('should have checkNeedsProxy method', () => {
      const instance = new Connect(['test-agent'], {color: false})
      expect(typeof instance.checkNeedsProxy).to.equal('function')
    })

    it('should have startSpriteProxy method', () => {
      const instance = new Connect(['test-agent'], {color: false})
      expect(typeof instance.startSpriteProxy).to.equal('function')
    })

    it('should have findAvailablePort method', () => {
      const instance = new Connect(['test-agent'], {color: false})
      expect(typeof instance.findAvailablePort).to.equal('function')
    })

    it('should have launchTui method', () => {
      const instance = new Connect(['test-agent'], {color: false})
      expect(typeof instance.launchTui).to.equal('function')
    })

    it('resolveBun should return a string path', () => {
      const instance = new Connect(['test-agent'], {color: false})
      const bunPath = instance.resolveBun()
      expect(bunPath).to.be.a('string')
      expect(bunPath.length).to.be.greaterThan(0)
    })

    it('resolveSprite should return a string path', () => {
      const instance = new Connect(['test-agent'], {color: false})
      const spritePath = instance.resolveSprite()
      expect(spritePath).to.be.a('string')
      expect(spritePath.length).to.be.greaterThan(0)
    })

    it('passes the bearer token in the environment and not on argv', () => {
      const source = fs.readFileSync(
        path.join(__dirname, '../../../typescript/cast-cli/src/commands/connect.ts'),
        'utf8',
      )
      expect(source).to.include('env: tuiAuthEnv(process.env, {token, edgeToken})')
      expect(source).to.not.include('--token')
      expect(source).to.not.include('--edge-token')
      const launch = source.slice(source.indexOf('const opentuiArgs'))
      expect(launch).to.not.include('push(')
    })

    it('findAvailablePort should return a number', async () => {
      const instance = new Connect(['test-agent'], {color: false})
      const port = await instance.findAvailablePort(9000, 9100)
      expect(port).to.be.a('number')
      expect(port).to.be.greaterThanOrEqual(9000)
      expect(port).to.be.lessThanOrEqual(9100)
    })
  })
})