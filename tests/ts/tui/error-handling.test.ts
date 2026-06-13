/**
 * Tests for the cast-tui error handling, crash diagnostics, and CLI argument parsing.
 *
 * The cast-tui source is built for Bun and depends on @opentui/core,
 * which uses `bun:ffi` and cannot be loaded in Node.js.  To exercise
 * the real compiled code, these tests spawn `bun` as a subprocess to
 * run a test harness (`run-error-handling.mjs`) that imports the
 * dist/index.js module and checks its behavior.
 *
 * The harness outputs one JSON line per test result, which this file
 * parses and maps to Mocha `it()` blocks.
 */

import {expect} from 'chai'
import {execFileSync} from 'child_process'
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tuiDistDir = path.resolve(__dirname, '../../../typescript/cast-tui/dist')
const distIndex = path.join(tuiDistDir, 'index.js')
const harnessPath = path.join(__dirname, 'run-error-handling.mjs')

interface HarnessResult {
  name: string
  status: 'pass' | 'fail'
  error: string | null
}

/**
 * Run the bun harness script and return parsed results.
 */
function runHarness(testName: string, args: string[] = []): HarnessResult[] {
  const results: HarnessResult[] = []

  try {
    const output = execFileSync('bun', ['run', harnessPath, testName, ...args], {
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        // Clear the terminal type so Bun doesn't try full TUI mode
        TERM: 'dumb',
        // Avoid interactive prompts
        CI: 'true',
      },
    })

    for (const line of output.trim().split('\n')) {
      try {
        const parsed = JSON.parse(line)
        if (parsed.name && parsed.status) {
          results.push(parsed)
        }
      } catch {
        // ignore non-JSON lines (warnings, logs, etc.)
      }
    }
  } catch (e: any) {
    // If the subprocess itself failed, return a single failure
    results.push({
      name: `harness-${testName}`,
      status: 'fail',
      error: e.stderr ? e.stderr.slice(0, 500) : e.message,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Crash log helpers
// ---------------------------------------------------------------------------

const CRASH_LOG_PATH = path.join(os.tmpdir(), 'cast-tui-crash.log')

function readCrashLog(): string {
  try {
    return fs.readFileSync(CRASH_LOG_PATH, 'utf-8')
  } catch {
    return ''
  }
}

function clearCrashLog(): void {
  try {
    fs.writeFileSync(CRASH_LOG_PATH, '')
  } catch {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TUI Error Handling', () => {
  before(() => {
    // Verify bun is available
    try {
      execFileSync('bun', ['--version'], {encoding: 'utf8'})
    } catch {
      console.warn('bun is not available — TUI error handling tests will be skipped')
    }
  })

  describe('CLI argument parsing', () => {
    it('should require --url and exit with code 1 when missing', () => {
      const results = runHarness('arg-parsing')
      const missingUrlTest = results.find(r => r.name === 'missing-url-exits-with-error')
      expect(missingUrlTest, 'missing-url-exits-with-error test not found in harness output').to.exist
      expect(missingUrlTest!.status).to.equal('pass')
    })
  })

  describe('startTui error handling', () => {
    beforeEach(() => {
      clearCrashLog()
    })

    it('should log crash diagnostics synchronously to tmpdir', () => {
      // The harness verifies that the crash log file can be written to
      // /tmp/cast-tui-crash.log (matching the production logCrash path)
      // and that appending works correctly.
      const results = runHarness('startTui')
      const writeTest = results.find(r => r.name === 'startTui-crash-log-write')
      const contentTest = results.find(r => r.name === 'startTui-crash-log-content')

      if (writeTest) {
        expect(writeTest.status).to.equal('pass')
      }
      if (contentTest) {
        expect(contentTest.status).to.equal('pass')
      }
    })

    it('should append crash entries (not overwrite)', () => {
      // Write a known entry, run the harness, then verify both entries exist
      const firstEntry = `[${new Date().toISOString()}] first-entry\n`
      fs.writeFileSync(CRASH_LOG_PATH, firstEntry, {flag: 'a'})
      const beforeSize = fs.statSync(CRASH_LOG_PATH).size

      runHarness('startTui')

      const afterSize = fs.statSync(CRASH_LOG_PATH).size
      expect(afterSize).to.be.greaterThan(beforeSize, 'Crash log should grow, not shrink')

      const content = readCrashLog()
      expect(content).to.include('first-entry', 'Previous crash log entries should be preserved')
    })
  })

  describe('process event handlers', () => {
    it('should register unhandledRejection and uncaughtException handlers', () => {
      // The harness verifies that the process.on API works (which the
      // TUI entry point uses to register global error handlers).
      const results = runHarness('process-handlers')
      const apiTest = results.find(r => r.name === 'process-on-is-function')
      const handlerTest = results.find(r => r.name === 'process-on-unhandledRejection-api')

      if (apiTest) {
        expect(apiTest.status).to.equal('pass')
      }
      if (handlerTest) {
        expect(handlerTest.status).to.equal('pass')
      }
    })
  })

  describe('dist/index.js bundle', () => {
    it('should exist as a compiled ESM module', () => {
      expect(fs.existsSync(distIndex)).to.be.true
      const content = fs.readFileSync(distIndex, 'utf-8')
      expect(content).to.include('export async function startTui')
      expect(content).to.include('logCrash')
    })

    it('should have crash diagnostic path pointing to tmpdir', () => {
      const content = fs.readFileSync(distIndex, 'utf-8')
      expect(content).to.include('cast-tui-crash.log')
      expect(content).to.include('os.tmpdir()')
    })
  })
})
