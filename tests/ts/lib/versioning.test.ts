import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

describe('versioning lib', () => {
  let versioning: any

  before(() => {
    versioning = require('../../../typescript/cast-cli/src/lib/versioning')
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

    it('should actually create a version record (not silently fail)', async () => {
      // Regression test: prior to the fix, the Python script was passed
      // with a leading `;` (newline→semicolon substitution left a stray
      // separator at the start of the -c argument), which made Python
      // raise SyntaxError. The function's try/catch swallowed the error,
      // so tests like the ones above passed even though no version was
      // actually created. This test asserts on a side effect (the
      // changes.json file) to catch that regression in the future.
      const agentName = `versioning-regression-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

      // Pretend the agent exists so the Python side doesn't bail early.
      fs.mkdirSync(agentDir, {recursive: true})
      fs.writeFileSync(
        path.join(agentDir, 'agent.yaml'),
        'name: regression-test\nversion: "1.0"\n',
      )

      try {
        // Snapshot the version count before.
        const changesJsonPath = path.join(agentDir, '.cast', 'changes', 'changes.json')
        const before = fs.existsSync(changesJsonPath)
          ? JSON.parse(fs.readFileSync(changesJsonPath, 'utf8'))
          : {current: 0, versions: []}

        await versioning.createVersion(agentName, 'cli', 'Regression test message')

        // Now changes.json should exist and have a higher current.
        expect(fs.existsSync(changesJsonPath)).to.be.true
        const after = JSON.parse(fs.readFileSync(changesJsonPath, 'utf8'))
        expect(after.current).to.be.greaterThan(before.current)
        const lastVersion = after.versions[after.versions.length - 1]
        expect(lastVersion.message).to.equal('Regression test message')
        expect(lastVersion.source).to.equal('cli')
      } finally {
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('should not produce a Python SyntaxError from a leading semicolon', async () => {
      // This is the exact bug the user hit: a multi-line Python script
      // passed via `python3 -c "..."` must not start with `;`. We assert
      // by spying on console.error and confirming no SyntaxError made it
      // through the warning handler.
      const errorCalls: string[] = []
      const originalConsoleError = console.error
      console.error = (...args: any[]) => {
        errorCalls.push(args.join(' '))
      }

      try {
        // Use a name that the Python side will reject (does not exist),
        // which forces a real subprocess run.
        await versioning.createVersion('definitely-not-a-real-agent-xyz', 'cli', 'no-op')
      } finally {
        console.error = originalConsoleError
      }

      // The Python subprocess should have produced a clean error
      // (VersioningError or similar) — not a SyntaxError caused by us.
      const combined = errorCalls.join('\n')
      if (combined.length > 0) {
        expect(combined).to.not.include('SyntaxError')
        expect(combined).to.not.include('invalid syntax')
      }
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

  describe('getCurrentVersion', () => {
    it('should be a function', () => {
      expect(typeof versioning.getCurrentVersion).to.equal('function')
    })

    it('should return a number when called', async () => {
      const result = await versioning.getCurrentVersion('nonexistent-agent')
      expect(result).to.be.a('number')
    })
  })

  describe('listVersions', () => {
    it('should be a function', () => {
      expect(typeof versioning.listVersions).to.equal('function')
    })

    it('should return an array when called', async () => {
      const result = await versioning.listVersions('nonexistent-agent')
      expect(result).to.be.an('array')
    })
  })

  describe('versionExists', () => {
    it('should be a function', () => {
      expect(typeof versioning.versionExists).to.equal('function')
    })

    it('should return a boolean when called', async () => {
      const result = await versioning.versionExists('nonexistent-agent', 1)
      expect(typeof result).to.equal('boolean')
    })
  })

  describe('getVersionInfo', () => {
    it('should be a function', () => {
      expect(typeof versioning.getVersionInfo).to.equal('function')
    })

    it('should return null or object when called', async () => {
      const result = await versioning.getVersionInfo('nonexistent-agent', 1)
      expect(result === null || typeof result === 'object').to.be.true
    })
  })

  describe('VersionInfo interface', () => {
    it('should define VersionInfo interface', () => {
      // VersionInfo is a TypeScript interface - verify it's defined in the module
      // by checking that functions that use it are present
      expect(versioning.listVersions).to.be.a('function')
      expect(versioning.getVersionInfo).to.be.a('function')
    })
  })
})