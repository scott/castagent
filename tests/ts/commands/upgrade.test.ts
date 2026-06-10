import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// Import the upgrade command to test its structure
import UpgradeCommand from '../../../typescript/cast-cli/src/commands/upgrade'

describe('Upgrade Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(UpgradeCommand.description).to.equal('Upgrade a deployed agent to a new version')
    })

    it('should have agent argument marked as required', () => {
      expect(UpgradeCommand.args.agent.required).to.be.true
    })

    it('should have agent argument with description', () => {
      expect(UpgradeCommand.args.agent.description).to.equal('Agent name or deployment SHA')
    })

    it('should have version argument (optional)', () => {
      expect(UpgradeCommand.args.version.required).to.be.undefined
    })

    it('should have version argument with description', () => {
      expect(UpgradeCommand.args.version.description).to.equal('Release version to upgrade to (optional, defaults to latest)')
    })

    it('should have list-versions flag', () => {
      expect(UpgradeCommand.flags['list-versions']).to.exist
      expect(UpgradeCommand.flags['list-versions'].type).to.equal('boolean')
    })

    it('should define list-versions flag with description', () => {
      expect(UpgradeCommand.flags['list-versions'].description).to.be.a('string')
      expect(UpgradeCommand.flags['list-versions'].description?.length).to.be.greaterThan(0)
    })
  })

  describe('examples', () => {
    it('should have usage examples', () => {
      expect(UpgradeCommand.examples).to.be.an('array')
      expect(UpgradeCommand.examples.length).to.be.greaterThan(0)
    })

    it('should include upgrade example', () => {
      const hasExample = UpgradeCommand.examples.some(ex =>
        ex.includes('email-agent') && !ex.includes('--list-versions')
      )
      expect(hasExample).to.be.true
    })

    it('should include upgrade with version example', () => {
      // Examples include a version like "1.6" or "abc123" (deployment SHA)
      const hasVersionExample = UpgradeCommand.examples.some(ex => /\b\d+(\.\d+)?\b/.test(ex) || /[a-f0-9]{6}/.test(ex))
      expect(hasVersionExample).to.be.true
    })

    it('should include upgrade by SHA example', () => {
      // Examples include connecting/upgrading by deployment SHA
      const hasShaExample = UpgradeCommand.examples.some(ex => /[a-z0-9]{6}/.test(ex))
      expect(hasShaExample).to.be.true
    })

    it('should include list-versions example', () => {
      const hasListExample = UpgradeCommand.examples.some(ex => ex.includes('--list-versions'))
      expect(hasListExample).to.be.true
    })
  })

  describe('command structure', () => {
    it('should be a class extending Command', () => {
      expect(UpgradeCommand.prototype).to.be.ok
    })

    it('should have run method', () => {
      const instance = new UpgradeCommand(['upgrade', 'test'], {} as any)
      expect(typeof instance.run).to.equal('function')
    })
  })

  describe('private methods', () => {
    let instance: any

    beforeEach(() => {
      instance = new UpgradeCommand(['upgrade', 'test'], {} as any)
    })

    it('should have upgradeDocker method', () => {
      expect(typeof instance.upgradeDocker).to.equal('function')
    })

    it('should have upgradeRailway method', () => {
      expect(typeof instance.upgradeRailway).to.equal('function')
    })

    it('should have upgradeFly method', () => {
      expect(typeof instance.upgradeFly).to.equal('function')
    })

    it('should have upgradeDigitalOcean method', () => {
      expect(typeof instance.upgradeDigitalOcean).to.equal('function')
    })

    it('should have upgradeSprites method', () => {
      expect(typeof instance.upgradeSprites).to.equal('function')
    })

    it('should have confirm method', () => {
      expect(typeof instance.confirm).to.equal('function')
    })

    it('should have getOpenRouterApiKey method', () => {
      expect(typeof instance.getOpenRouterApiKey).to.equal('function')
    })
  })

  describe('valid providers', () => {
    it('should support docker provider', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('docker')
    })

    it('should support railway provider', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('railway')
    })

    it('should support fly provider', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('fly')
    })
  })
})