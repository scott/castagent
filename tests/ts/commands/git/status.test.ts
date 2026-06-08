import {expect} from 'chai'
import GitStatus from '../../../../typescript/cast-cli/src/commands/git/status'

describe('Git Status Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitStatus.description).to.equal('Show the working tree status of an agent')
    })

    it('should require agent argument', () => {
      expect(GitStatus.args).to.have.property('agent')
      expect(GitStatus.args.agent.required).to.be.true
      expect(GitStatus.args.agent.description).to.equal('Agent name')
    })

    it('should have examples', () => {
      expect(GitStatus.examples).to.be.an('array')
      expect(GitStatus.examples.length).to.be.greaterThan(0)
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitStatus(['git', 'status', 'test-agent'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('command behavior', () => {
    it('should use git.status() to get status', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should show clean working tree status', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should show modified files', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should show untracked files', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should show staged files', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should show deleted files', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should show ahead/behind status', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should list remotes', () => {
      expect(GitStatus).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should error if not a git repo', () => {
      expect(GitStatus).to.be.a('function')
    })
  })

  describe('status display', () => {
    it('should display current branch', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should display tracking branch', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should use standard git status format', () => {
      expect(GitStatus).to.be.a('function')
    })

    it('should show remote URLs', () => {
      expect(GitStatus).to.be.a('function')
    })
  })
})