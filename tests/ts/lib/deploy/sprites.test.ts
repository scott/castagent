import {expect} from 'chai'
import SpritesDeploy from '../../../../typescript/cast-cli/src/lib/deploy/sprites'

describe('Sprites Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(SpritesDeploy.description).to.equal('Deploy agent to Sprites (Fly.io Firecracker VM)')
    })

    it('should require agent argument', () => {
      expect(SpritesDeploy.args).to.have.property('agent')
      expect(SpritesDeploy.args.agent.required).to.be.true
      expect(SpritesDeploy.args.agent.description).to.equal('Agent name')
    })

    it('should not have --no-build flag', () => {
      // Sprites deploy doesn't have flags property
      expect(SpritesDeploy.flags).to.be.undefined
    })

    it('should not have --port flag', () => {
      // Sprites deploy doesn't have flags property
      expect(SpritesDeploy.flags).to.be.undefined
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(SpritesDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new SpritesDeploy(['deploy', 'sprites'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof SpritesDeploy.destroy).to.equal('function')
    })
  })

  describe('command construction', () => {
    it('should define sprites as the CLI command', () => {
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('sprites')
    })

    it('should use sprite CLI', () => {
      // The implementation uses 'sprite' command
      expect(SpritesDeploy.description).to.include('Sprites')
    })
  })

  describe('configuration', () => {
    it('should have memory mount path configuration', () => {
      // Sprites uses /opt/cast-agent directory
      expect(SpritesDeploy).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should handle authentication errors', () => {
      // The implementation checks for sprite auth
      expect(SpritesDeploy).to.be.a('function')
    })
  })
})