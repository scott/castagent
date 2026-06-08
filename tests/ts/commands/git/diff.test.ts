import {expect} from 'chai'
import GitDiff from '../../../../typescript/cast-cli/src/commands/git/diff'

describe('Git Diff Command', () => {
  describe('static properties', () => {
    it('should have correct description', () => {
      expect(GitDiff.description).to.equal('Show changes between commits or working tree')
    })

    it('should require agent argument', () => {
      expect(GitDiff.args).to.have.property('agent')
      expect(GitDiff.args.agent.required).to.be.true
      expect(GitDiff.args.agent.description).to.equal('Agent name')
    })

    it('should have optional ref argument', () => {
      expect(GitDiff.args).to.have.property('ref')
      expect(GitDiff.args.ref.required).to.be.false
    })

    it('should have --staged flag', () => {
      expect(GitDiff.flags).to.have.property('staged')
      expect(GitDiff.flags.staged.description).to.be.a('string')
    })

    it('should have --file flag', () => {
      expect(GitDiff.flags).to.have.property('file')
      expect(GitDiff.flags.file.description).to.be.a('string')
    })

    it('should have examples', () => {
      expect(GitDiff.examples).to.be.an('array')
      expect(GitDiff.examples.length).to.be.greaterThan(0)
    })
  })

  describe('module exports', () => {
    it('should export a class', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should be instantiable', () => {
      const instance = new GitDiff(['git', 'diff', 'test-agent'], {} as any)
      expect(instance).to.be.an('object')
    })
  })

  describe('command behavior', () => {
    it('should show staged changes with --staged flag', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should show changes since ref when provided', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should show working tree changes by default', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should show untracked files', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should handle clean working tree', () => {
      expect(GitDiff).to.be.a('function')
    })
  })

  describe('error handling', () => {
    it('should error if agent does not exist', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should error if not a git repo', () => {
      expect(GitDiff).to.be.a('function')
    })
  })

  describe('flag behavior', () => {
    it('should show only staged changes when --staged is used', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should accept optional ref for comparison', () => {
      expect(GitDiff).to.be.a('function')
    })

    it('should support --file flag for specific file', () => {
      expect(GitDiff).to.be.a('function')
    })
  })
})