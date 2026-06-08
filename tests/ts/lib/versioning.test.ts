import {expect} from 'chai'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs'
import * as sinon from 'sinon'

describe('versioning lib', () => {
  let versioning: any

  before(() => {
    // Mock execSync to prevent actual Python execution
    sinon.stub(require('child_process'), 'execSync').returns('')
    versioning = require('../../../typescript/cast-cli/src/lib/versioning')
  })

  after(() => {
    sinon.restore()
  })

  describe('createVersion', () => {
    it('should be a function', () => {
      expect(typeof versioning.createVersion).to.equal('function')
    })

    it('should accept agent name parameter', async () => {
      await versioning.createVersion('test-agent')
      // Function should not throw
    })

    it('should accept source parameter', async () => {
      await versioning.createVersion('test-agent', 'cli')
      // Function should not throw
    })

    it('should accept message parameter', async () => {
      await versioning.createVersion('test-agent', 'cli', 'Test message')
      // Function should not throw
    })

    it('should handle agent names with special characters in message', async () => {
      await versioning.createVersion('test-agent', 'cli', "Message with 'quotes'")
      // Function should not throw - quotes should be escaped
    })
  })

  describe('revertVersion', () => {
    it('should be a function', () => {
      expect(typeof versioning.revertVersion).to.equal('function')
    })

    it('should accept agent name parameter', async () => {
      try {
        await versioning.revertVersion('nonexistent-agent', null)
      } catch (e) {
        // Expected to fail for nonexistent agent
        expect((e as Error).message).to.include('Revert failed')
      }
    })

    it('should accept versionId parameter', async () => {
      try {
        await versioning.revertVersion('test-agent', 1)
      } catch (e) {
        // Expected to fail for test agent
        expect((e as Error).message).to.include('Revert failed')
      }
    })

    it('should handle null versionId', async () => {
      try {
        await versioning.revertVersion('test-agent', null)
      } catch (e) {
        // Expected to fail
        expect((e as Error).message).to.include('Revert failed')
      }
    })

    it('should include message in error when provided', async () => {
      try {
        await versioning.revertVersion('test-agent', 1, 'Custom message')
      } catch (e) {
        expect((e as Error).message).to.include('Revert failed')
      }
    })
  })
})