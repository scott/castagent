import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as sinon from 'sinon'

async function loadTestCommand(commandName: string): Promise<any> {
  const commandPath = path.join(
    __dirname,
    '../../../typescript/cast-cli/src/commands',
    `${commandName}.ts`,
  )
  const CommandClass = require(commandPath).default
  return CommandClass
}

interface VersionInfo {
  id: number
  timestamp: string
  source: string
  message: string
}

interface VersionsJson {
  current: number
  versions: VersionInfo[]
}

/**
 * Build a fresh Diff command instance with all oclif plumbing stubbed
 * so we can drive its `run()` method directly.
 */
function makeInstance(Diff: any, argv: string[], parseResult: {args: any; flags: any}) {
  const instance = new Diff(argv, {} as any)
  instance.config = {runHook: async () => ({successes: [], failures: []})}
  instance.parse = async () => ({
    args: parseResult.args,
    flags: parseResult.flags,
    argv: [],
    raw: [],
    metadata: {},
    nonExistentFlags: [],
  })
  const logs: string[] = []
  let errorMessage = ''
  instance.log = (msg: string) => {
    logs.push(msg)
  }
  instance.error = (msg: string) => {
    errorMessage = msg
    throw new Error(msg)
  }
  return {instance, logs, getError: () => errorMessage}
}

/**
 * Write a `versions.json` for the test agent so the diff command has
 * something to read.
 */
function writeVersions(agentDir: string, data: VersionsJson): void {
  const versionsDir = path.join(agentDir, '.cast', 'versions')
  fs.mkdirSync(versionsDir, {recursive: true})
  fs.writeFileSync(
    path.join(versionsDir, 'versions.json'),
    JSON.stringify(data, null, 2),
  )
}

describe('diff command', () => {
  let Diff: any
  let sandbox: sinon.SinonSandbox

  before(async () => {
    Diff = await loadTestCommand('diff')
  })

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  describe('command structure', () => {
    it('should have correct description', () => {
      expect(Diff.description).to.be.a('string')
      expect(Diff.description).to.include('Compare')
    })

    it('should require the agent argument', () => {
      expect(Diff.args.agent).to.exist
      expect(Diff.args.agent.required).to.be.true
    })

    it('should have optional integer version1 and version2 arguments', () => {
      expect(Diff.args.version1).to.exist
      expect(Diff.args.version1.required).to.be.false
      expect(Diff.args.version2).to.exist
      expect(Diff.args.version2.required).to.be.false
    })

    it('should have a summary flag with default false', () => {
      expect(Diff.flags.summary).to.exist
      expect(Diff.flags.summary.default).to.equal(false)
    })

    it('should have examples', () => {
      expect(Diff.examples).to.be.an('array')
      expect(Diff.examples.length).to.be.greaterThan(0)
    })
  })

  describe('error paths', () => {
    const agentName = `diff-test-noagent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

    // Make sure the agent does NOT exist for these tests.
    beforeEach(() => {
      if (fs.existsSync(agentDir)) {
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    afterEach(() => {
      if (fs.existsSync(agentDir)) {
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('should error when the agent does not exist', async () => {
      const {instance, getError} = makeInstance(Diff, ['diff', agentName], {
        args: {agent: agentName},
        flags: {summary: false},
      })

      let threw = false
      try {
        await instance.run()
      } catch {
        threw = true
      }

      expect(threw).to.be.true
      expect(getError()).to.include('not found')
      expect(getError()).to.include(agentName)
    })

    it('should error when versions.json is missing', async () => {
      // Create the agent dir but no versions.json
      fs.mkdirSync(agentDir, {recursive: true})
      // Intentionally don't write versions.json

      const {instance, getError} = makeInstance(Diff, ['diff', agentName], {
        args: {agent: agentName},
        flags: {summary: false},
      })

      let threw = false
      try {
        await instance.run()
      } catch {
        threw = true
      }

      expect(threw).to.be.true
      expect(getError()).to.include('No versions found')
    })

    it('should error when fewer than 2 versions exist', async () => {
      fs.mkdirSync(agentDir, {recursive: true})
      writeVersions(agentDir, {
        current: 1,
        versions: [
          {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'Only version'},
        ],
      })

      const {instance, getError} = makeInstance(Diff, ['diff', agentName], {
        args: {agent: agentName},
        flags: {summary: false},
      })

      let threw = false
      try {
        await instance.run()
      } catch {
        threw = true
      }

      expect(threw).to.be.true
      expect(getError()).to.include('at least 2 versions')
    })

    it('should error when an explicit version does not exist', async () => {
      fs.mkdirSync(agentDir, {recursive: true})
      writeVersions(agentDir, {
        current: 2,
        versions: [
          {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'First'},
          {id: 2, timestamp: '2024-01-02T00:00:00Z', source: 'edit', message: 'Second'},
        ],
      })

      // Version 99 doesn't exist
      const {instance, getError} = makeInstance(Diff, ['diff', agentName, '1', '99'], {
        args: {agent: agentName, version1: 1, version2: 99},
        flags: {summary: false},
      })

      let threw = false
      try {
        await instance.run()
      } catch {
        threw = true
      }

      expect(threw).to.be.true
      expect(getError()).to.include('Version 99 not found')
    })
  })

  describe('command behavior', () => {
    const agentName = `diff-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

    const baseVersions: VersionsJson = {
      current: 3,
      versions: [
        {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'Initial'},
        {id: 2, timestamp: '2024-01-02T00:00:00Z', source: 'edit', message: 'Tweak'},
        {id: 3, timestamp: '2024-01-03T00:00:00Z', source: 'edit', message: 'Polish'},
      ],
    }

    beforeEach(() => {
      fs.mkdirSync(agentDir, {recursive: true})
      writeVersions(agentDir, baseVersions)
    })

    afterEach(() => {
      if (fs.existsSync(agentDir)) {
        fs.rmSync(agentDir, {recursive: true, force: true})
      }
    })

    it('should default to comparing the previous version with current', async () => {
      // Stub execSync to return a tiny diff with one changed file.
      const diffResult = {
        'agent.yaml': {v1_exists: true, v2_exists: true, v1_content: 'old', v2_content: 'new'},
      }
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify(diffResult) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName], {
        args: {agent: agentName},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      // Default: previous (v2) → current (v3)
      expect(out).to.include('Comparing v2 → v3')
      expect(out).to.include('File: agent.yaml')
      // Detail mode shows the content preview, not the word "Changed"
      expect(out).to.include('v2: old...')
      expect(out).to.include('v3: new...')
    })

    it('should compare version1 to current when only version1 is given', async () => {
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify({}) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '1'], {
        args: {agent: agentName, version1: 1},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      expect(out).to.include('Comparing v1 → v3')
    })

    it('should compare version1 to version2 when both are given', async () => {
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify({}) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '1', '2'], {
        args: {agent: agentName, version1: 1, version2: 2},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      expect(out).to.include('Comparing v1 → v2')
    })

    it('should show "No differences found" when Python returns no files', async () => {
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify({}) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName], {
        args: {agent: agentName},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      expect(out).to.include('No differences found')
    })

    it('should render summary output for --summary flag', async () => {
      const diffResult = {
        'agent.yaml': {v1_exists: true, v2_exists: true},
        'instructions.md': {v1_exists: false, v2_exists: true},
      }
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify(diffResult) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '--summary'], {
        args: {agent: agentName},
        flags: {summary: true},
      })

      await instance.run()

      const out = logs.join('\n')
      // Summary uses inline status labels
      expect(out).to.include('agent.yaml:')
      expect(out).to.include('CHANGED')
      expect(out).to.include('instructions.md:')
      expect(out).to.include('ADDED')
    })

    it('should render added/removed file states in detail mode', async () => {
      const diffResult = {
        'new-file.md': {v1_exists: false, v2_exists: true, v2_content: 'fresh content'},
        'old-file.md': {v1_exists: true, v2_exists: false, v1_content: 'gone'},
      }
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify(diffResult) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '1', '2'], {
        args: {agent: agentName, version1: 1, version2: 2},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      expect(out).to.include('File: new-file.md')
      expect(out).to.include('Added in v2')
      expect(out).to.include('File: old-file.md')
      expect(out).to.include('Removed in v2')
    })

    it('should render MCP directory changes specially', async () => {
      const diffResult = {
        mcp: {
          'servers.json': {v1_exists: true, v2_exists: true},
          'auth.json': {v1_exists: false, v2_exists: true},
        },
      }
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify(diffResult) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '--summary'], {
        args: {agent: agentName},
        flags: {summary: true},
      })

      await instance.run()

      const out = logs.join('\n')
      expect(out).to.include('mcp/servers.json:')
      expect(out).to.include('mcp/auth.json:')
    })

    it('should display version info for both compared versions', async () => {
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify({}) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '1', '2'], {
        args: {agent: agentName, version1: 1, version2: 2},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      // v1 message and timestamp
      expect(out).to.include('v1: Initial')
      expect(out).to.include('2024-01-01')
      // v2 message and timestamp
      expect(out).to.include('v2: Tweak')
      expect(out).to.include('2024-01-02')
    })

    it('should preview changed file content (first 100 chars)', async () => {
      const longContent = 'a'.repeat(150)
      const diffResult = {
        'big.md': {
          v1_exists: true,
          v2_exists: true,
          v1_content: longContent,
          v2_content: 'b'.repeat(150),
        },
      }
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify(diffResult) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '1', '2'], {
        args: {agent: agentName, version1: 1, version2: 2},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      // 100 'a's followed by '...' (truncation)
      expect(out).to.include('a'.repeat(100) + '...')
      // And for v2
      expect(out).to.include('b'.repeat(100) + '...')
    })

    it('should show "(empty)" when changed file content is missing', async () => {
      const diffResult = {
        'empty.md': {
          v1_exists: true,
          v2_exists: true,
          v1_content: '',
          v2_content: '',
        },
      }
      sandbox
        .stub(require('child_process'), 'execSync')
        .returns(JSON.stringify(diffResult) as any)

      const {instance, logs} = makeInstance(Diff, ['diff', agentName, '1', '2'], {
        args: {agent: agentName, version1: 1, version2: 2},
        flags: {summary: false},
      })

      await instance.run()

      const out = logs.join('\n')
      expect(out).to.include('(empty)')
    })

    it('should error when the Python diff command throws', async () => {
      sandbox
        .stub(require('child_process'), 'execSync')
        .throws(new Error('python3 not found'))

      const {instance, getError} = makeInstance(Diff, ['diff', agentName], {
        args: {agent: agentName},
        flags: {summary: false},
      })

      let threw = false
      try {
        await instance.run()
      } catch {
        threw = true
      }

      expect(threw).to.be.true
      expect(getError()).to.include('Failed to compare versions')
      expect(getError()).to.include('python3 not found')
    })
  })
})
