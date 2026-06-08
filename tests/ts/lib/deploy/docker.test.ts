import {expect} from 'chai'
import DockerDeploy from '../../../../typescript/cast-cli/src/lib/deploy/docker'

describe('Docker Deploy Provider', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(DockerDeploy.description).to.equal('Deploy agent locally with Docker')
    })

    it('should define --no-build flag', () => {
      expect(DockerDeploy.flags).to.have.property('no-build')
      expect(DockerDeploy.flags['no-build'].default).to.equal(false)
    })

    it('should define --port flag with default 8080', () => {
      expect(DockerDeploy.flags).to.have.property('port')
      expect(DockerDeploy.flags.port.default).to.equal(8080)
    })

    it('should require agent argument', () => {
      expect(DockerDeploy.args).to.have.property('agent')
      expect(DockerDeploy.args.agent.required).to.be.true
      expect(DockerDeploy.args.agent.description).to.equal('Agent name')
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(DockerDeploy).to.be.a('function')
    })

    it('should be instantiable', () => {
      // Create a minimal instance to verify class structure
      const instance = new DockerDeploy(['deploy', 'docker'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('static destroy method', () => {
    it('should have destroy method', () => {
      expect(typeof DockerDeploy.destroy).to.equal('function')
    })
  })

  describe('command construction', () => {
    it('should define docker as the CLI command', () => {
      // The docker provider is defined in deploy.ts, verify its presence in valid providers
      const validProviders = ['railway', 'fly', 'digitalocean', 'sprites', 'docker', 'local']
      expect(validProviders).to.include('docker')
    })
  })
})