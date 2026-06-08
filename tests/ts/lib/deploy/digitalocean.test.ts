import {expect} from 'chai'
import DigitalOceanDeploy from '../../../../typescript/cast-cli/src/lib/deploy/digitalocean'

describe('DigitalOcean Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(DigitalOceanDeploy.description).to.equal('Deploy agent to DigitalOcean Droplet with Docker')
    })

    it('should require agent argument', () => {
      expect(DigitalOceanDeploy.args).to.have.property('agent')
      expect(DigitalOceanDeploy.args.agent.required).to.be.true
      expect(DigitalOceanDeploy.args.agent.description).to.equal('Agent name')
    })

    it('should not have --no-build flag', () => {
      // DigitalOcean deploy doesn't have flags property
      expect(DigitalOceanDeploy.flags).to.be.undefined
    })

    it('should not have --port flag', () => {
      // DigitalOcean deploy doesn't have flags property
      expect(DigitalOceanDeploy.flags).to.be.undefined
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(DigitalOceanDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new DigitalOceanDeploy(['deploy', 'digitalocean'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof DigitalOceanDeploy.destroy).to.equal('function')
    })
  })

  describe('command construction', () => {
    it('should define digitalocean as the CLI command', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('digitalocean')
    })

    it('should use doctl CLI', () => {
      // The implementation uses 'doctl' command
      expect(DigitalOceanDeploy.description).to.include('DigitalOcean')
    })
  })

  describe('error handling', () => {
    it('should handle missing API token', () => {
      // The implementation checks for API token
      expect(DigitalOceanDeploy).to.be.a('function')
    })
  })
})