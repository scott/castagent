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
        db.deleteAgent(agentName)
        cleaned.push(agentName)
      }
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

  if (localAgents.length === 0 && directories.length === 0 && dbAgents.length === 0) {
    console.log('  ✓ No test agents found (all clean)')
  }

  console.log('\n✅ Cleanup complete.')
}

main()