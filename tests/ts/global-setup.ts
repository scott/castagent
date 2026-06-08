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
}

export function fullCleanup(): void {
  cleanupStaleLocalAgents()
  cleanupTestAgentDirectories()
  cleanupTestAgentsFromDatabase()
}

// Run cleanup at startup to handle any stale entries from previous runs
fullCleanup()