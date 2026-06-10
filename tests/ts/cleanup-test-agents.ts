/**
 * Standalone script to clean up test agents.
 *
 * Usage:
 *   npx ts-node tests/ts/cleanup-test-agents.ts
 *   npm run clean:test
 */

import {db} from '../../typescript/cast-cli/src/lib/sqlite'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

// Prefixes that identify test-created agents (by naming convention)
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

function isTestAgent(agentName: string): boolean {
  if (TEST_AGENT_PREFIXES.some(prefix => agentName.startsWith(prefix))) {
    return true
  }
  if (TEST_AGENT_NAMES.includes(agentName)) {
    return true
  }
  return false
}

function cleanupStaleLocalAgents(): string[] {
  const cleaned: string[] = []
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
            setTimeout(() => {
              try { process.kill(pid, 'SIGKILL') } catch {}
            }, 500)
          } catch {}
        }
        db.removeLocalAgent(agentName)
        cleaned.push(agentName)
      }
    }
  } catch {}
  return cleaned
}

function cleanupTestAgentDirectories(): string[] {
  const cleaned: string[] = []
  const agentsDir = path.join(os.homedir(), '.cast', 'agents')
  if (!fs.existsSync(agentsDir)) return cleaned

  try {
    const entries = fs.readdirSync(agentsDir)
    for (const entry of entries) {
      if (isTestAgent(entry)) {
        try {
          fs.rmSync(path.join(agentsDir, entry), {recursive: true, force: true})
          cleaned.push(entry)
        } catch {}
      }
    }
  } catch {}
  return cleaned
}

function cleanupTestAgentsFromDatabase(): string[] {
  const cleaned: string[] = []
  try {
    const agents = db.listAgents()
    for (const agent of agents) {
      const agentName = (agent as any).name
      if (isTestAgent(agentName)) {
        // deleteAgent also cascades to deployments, releases, etc.
        db.deleteAgent(agentName)
        cleaned.push(agentName)
      }
    }
  } catch {}
  return cleaned
}

/**
 * Remove orphan release records: releases whose `agent_name` is a known
 * test pattern, OR whose agent directory no longer exists on disk.
 *
 * SAFETY: an agent that has a directory on disk is NEVER considered an
 * orphan, even if its row in the `agents` table is missing. Real agents
 * (e.g. one deployed manually) may have releases without a corresponding
 * `agents` table row, and we must not delete those.
 */
function cleanupOrphanReleases(): string[] {
  const cleaned: string[] = []
  const agentsDir = path.join(os.homedir(), '.cast', 'agents')

  try {
    // Get all distinct release agent names
    const rows = (db as any).db
      .prepare('SELECT DISTINCT agent_name FROM releases')
      .all() as Array<{agent_name: string}>

    for (const row of rows) {
      const name = row.agent_name
      const isTest = isTestAgent(name)
      const onDisk = fs.existsSync(path.join(agentsDir, name))

      if (onDisk) {
        // Real agent on disk — leave alone even if no agents table row.
        continue
      }
      if (!isTest) {
        // No agent directory and not a known test pattern — be
        // conservative and skip. Better to leave a row than to lose
        // a real release record.
        continue
      }

      ;(db as any).db.prepare('DELETE FROM releases WHERE agent_name = ?').run(name)
      cleaned.push(name)
    }
  } catch {}
  return cleaned
}

function main(): void {
  console.log('🧹 Cleaning up test agents...\n')

  const localAgents = cleanupStaleLocalAgents()
  if (localAgents.length > 0) {
    console.log('  Removed local agents:')
    localAgents.forEach(name => console.log(`    - ${name}`))
  }

  const directories = cleanupTestAgentDirectories()
  if (directories.length > 0) {
    console.log('\n  Removed agent directories:')
    directories.forEach(name => console.log(`    - ${name}`))
  }

  const dbAgents = cleanupTestAgentsFromDatabase()
  if (dbAgents.length > 0) {
    console.log('\n  Removed from database:')
    dbAgents.forEach(name => console.log(`    - ${name}`))
  }

  const orphanReleases = cleanupOrphanReleases()
  if (orphanReleases.length > 0) {
    console.log('\n  Removed orphan releases:')
    orphanReleases.forEach(name => console.log(`    - ${name}`))
  }

  if (
    localAgents.length === 0 &&
    directories.length === 0 &&
    dbAgents.length === 0 &&
    orphanReleases.length === 0
  ) {
    console.log('  ✓ No test agents found (all clean)')
  }

  console.log('\n✅ Cleanup complete.')
}

main()