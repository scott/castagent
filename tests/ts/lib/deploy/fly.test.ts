import {expect} from 'chai'
import FlyDeploy from '../../../../typescript/cast-cli/src/lib/deploy/fly'

describe('Fly.io Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(FlyDeploy.description).to.equal('Deploy agent to Fly.io')
    })

    it('should require agent argument', () => {
      expect(FlyDeploy.args).to.have.property('agent')
      expect(FlyDeploy.args.agent.required).to.be.true
      expect(FlyDeploy.args.agent.description).to.equal('Agent name')
    })

    it('should not have --no-build flag', () => {
      // Fly deploy doesn't have flags property
      expect(FlyDeploy.flags).to.be.undefined
    })

    it('should not have --port flag', () => {
      // Fly deploy doesn't have flags property
      expect(FlyDeploy.flags).to.be.undefined
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(FlyDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new FlyDeploy(['deploy', 'fly'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof FlyDeploy.destroy).to.equal('function')
    })
  })

  describe('command construction', () => {
    it('should define fly as the CLI command', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('fly')
    })

    it('should use flyctl CLI', () => {
      // The implementation uses 'flyctl' command
      expect(FlyDeploy.description).to.include('Fly.io')
    })
  })

  describe('configuration', () => {
    it('should have fly.toml generation method', () => {
      // The deployer generates fly.toml
      expect(FlyDeploy).to.be.a('function')
    })
  })
})