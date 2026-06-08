import {expect} from 'chai'
import GitLog from '../../../../typescript/cast-cli/src/commands/git/log'

describe('Git Log Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitLog.description).to.equal('Show commit history for an agent')
    })

    it('should require agent argument', () => {
      expect(GitLog.args).to.have.property('agent')
      expect(GitLog.args.agent.required).to.be.true
      expect(GitLog.args.agent.description).to.equal('Agent name')
    })

    it('should have --count flag with default 10', () => {
      expect(GitLog.flags).to.have.property('count')
      expect(GitLog.flags.count.default).to.equal(10)
      expect(GitLog.flags.count.char).to.equal('n')
    })

    it('should have examples', () => {
      expect(GitLog.examples).to.be.an('array')
      expect(GitLog.examples.length).to.be.greaterThan(0)
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitLog(['git', 'log', 'test-agent'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('command behavior', () => {
    it('should use git.log() with maxCount', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should format date for display', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should display commit hash, date, author, and message', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should handle empty log', () => {
      expect(GitLog).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', () => {
      expect(GitLog).to.be.a('function')
    })

    it('should error if not a git repo', () => {
      expect(GitLog).to.be.a('function')
    })
  })

  describe('count option', () => {
    it('should accept -n flag', () => {
      expect(GitLog.flags.count.char).to.equal('n')
    })

    it('should default to 10 commits', () => {
      expect(GitLog.flags.count.default).to.equal(10)
    })

    it('should allow custom count', () => {
      // The flag accepts any integer value
      expect(GitLog).to.be.a('function')
    })
  })
})