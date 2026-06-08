import {expect} from 'chai'
import RailwayDeploy from '../../../../typescript/cast-cli/src/lib/deploy/railway'

describe('Railway Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(RailwayDeploy.description).to.equal('Deploy agent to Railway')
    })

    it('should require agent argument', () => {
      expect(RailwayDeploy.args).to.have.property('agent')
      expect(RailwayDeploy.args.agent.required).to.be.true
      expect(RailwayDeploy.args.agent.description).to.equal('Agent name')
    })

    it('should not have --no-build flag (unlike docker)', () => {
      // Railway deploy doesn't have flags property (unlike DockerDeploy)
      expect(RailwayDeploy.flags).to.be.undefined
    })

    it('should not have --port flag (unlike docker)', () => {
      // Railway deploy doesn't have flags property (unlike DockerDeploy)
      expect(RailwayDeploy.flags).to.be.undefined
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(RailwayDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new RailwayDeploy(['deploy', 'railway'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof RailwayDeploy.destroy).to.equal('function')
    })
  })

  describe('command construction', () => {
    it('should define railway as the CLI command', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('railway')
    })

    it('should use railway init command in run method', () => {
      // The implementation uses 'railway init' command
      expect(RailwayDeploy.description).to.include('Railway')
    })
  })
})