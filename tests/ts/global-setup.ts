/**
 * Global test setup for Cast CLI tests.
 *
 * This file is loaded via mocha's --require flag.
 * It runs cleanup at startup to ensure a clean slate before tests.
 *
 * Usage: Add to .mocharc.json: "require": ["ts-node/register", "tests/ts/global-setup.ts"]
 */

import {db} from '../../typescript/cast-cli/src/lib/sqlite'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Prefixes that identify test-created agents
const TEST_AGENT_PREFIXES = [
  'test-',
  'concurrent-',
  'lifecycle-',
  'local-agent-',
  'rename-test-',
  'renamed-test-',
  'integrity-test-',
  'init-test-',
  'race-test-',
  'cleanup-test-',
  'running-agent-',
  'update-test-',
  'describe-test-',
  'deploy-test-',
  'mcp-test-',
  'config-test-',
  'dryrun-test-',
  'test-commit-',
  'test-push-',
  'test-git-',
  // Added for the versioning / releases test suite. These match the
  // unique-per-test-run names created by tests/ts/commands/release.test.ts
  // and the Releases block of tests/ts/lib/sqlite.test.ts.
  'release-test-',
  'release-cmd-test-',
  'release-lib-test-',
  'rel-a-',
  'rel-b-',
  'rel-x-',
  'rel-y-',
  // Other test patterns used across the suite.
  'restore-test-',
  'changes-test-',
  'registry-agent-test-',
  'shutdown-agent-',
  'dup-test-',
  'version-test-',
  // The SQLite test suite uses per-test-run unique names of the form
  // "sha-test-<timestamp>-<random>" for SHA-based deployments. The
  // "sha-" prefix alone is too broad (real SHAs are sha1...), so we
  // require the "sha-test-" prefix specifically.
  'sha-test-',
]

// Common test agent names (without prefix)
const TEST_AGENT_NAMES = [
  'agent-a',
  'agent-b',
  'config-agent',
  'described-agent',
  'existing-agent',
  'instructions-agent',
  'mcp-path-agent',
  'mcp-update-agent',
  'path-test-agent',
  'taken-agent',
  'update-config-agent',
  'yaml-test-agent',
  'test-agent',
  'temp-agent',
  // Names used by the Releases block in tests/ts/lib/sqlite.test.ts.
  // These are static names reused across test runs (not per-run unique).
  'agent-x',
  'agent-y',
  'auto-sha-agent',
  'back-compat-agent',
  'conn-agent',
  'current-agent',
  'del-rel-agent',
  'deploys-agent',
  'mixed-deploys',
  'multi-deploy-agent',
  'no-version-agent',
  'release-agent',
  'semver-agent',
  'sha-agent',
  'soft-delete-agent',
  'specific-agent',
  'upsert-agent',
  'versioned-agent',
]

export function isTestAgent(agentName: string): boolean {
  if (TEST_AGENT_PREFIXES.some(prefix => agentName.startsWith(prefix))) {
    return true
  }
  if (TEST_AGENT_NAMES.includes(agentName)) {
    return true
  }
  return false
}

export function cleanupStaleLocalAgents(): void {
  try {
    const localAgents = db.listLocalAgents()
    for (const agent of localAgents) {
      const agentName = (agent as any).agent_name
      if (isTestAgent(agentName)) {
        const pid = (agent as any).pid
        if (pid && pid > 0) {
          try {
            process.kill(pid, 0)
            try { process.kill(pid, 'SIGTERM') } catch {}
            setTimeout(() => { try { process.kill(pid, 'SIGKILL') } catch {} }, 500)
          } catch {}
        }
        db.removeLocalAgent(agentName)
      }
    }
  } catch {}
}

export function cleanupTestAgentDirectories(): void {
  const agentsDir = path.join(os.homedir(), '.cast', 'agents')
  if (!fs.existsSync(agentsDir)) return
  try {
    const entries = fs.readdirSync(agentsDir)
    for (const entry of entries) {
      if (isTestAgent(entry)) {
        try {
          fs.rmSync(path.join(agentsDir, entry), {recursive: true, force: true})
        } catch {}
      }
    }
  } catch {}
}

export function cleanupTestAgentsFromDatabase(): void {
  try {
    const agents = db.listAgents()
    for (const agent of agents) {
      const agentName = (agent as any).name
      if (isTestAgent(agentName)) {
        db.deleteAgent(agentName)
      }
    }
  } catch {}
  // Release rows can exist without an agents-table row. Drop those too.
  try {
    const releases = db.listAllReleases()
    for (const release of releases) {
      const agentName = (release as any).agent_name
      if (isTestAgent(agentName)) {
        db.deleteRelease(agentName, (release as any).version)
      }
    }
  } catch {}
}

export function fullCleanup(): void {
  cleanupStaleLocalAgents()
  cleanupTestAgentDirectories()
  cleanupTestAgentsFromDatabase()
}

// Run cleanup at startup to handle any stale entries from previous runs
fullCleanup()