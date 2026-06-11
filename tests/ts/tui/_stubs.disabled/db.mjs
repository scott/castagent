// Configurable stub for the cast-tui db module.
//
// Tests configure the stub via the global `__testConfig.db` object
// BEFORE the cast-tui module is imported. The default configuration
// (no agents, no deployments, no releases) is used otherwise.
//
// The stub exposes the same shape as the real DbApi in
// typescript/cast-tui/src/lib/db.ts, but every method reads from the
// shared test state at call time.

if (!globalThis.__testConfig) globalThis.__testConfig = {}
if (!globalThis.__testConfig.db) globalThis.__testConfig.db = {}

function readConfig() {
  // Always read the latest test config; never cache.
  return globalThis.__testConfig.db
}

export async function getDb() {
  const config = readConfig()
  // If the test sets `disabled: true`, resolve with null so the
  // production handler hits the "no db" path.
  if (config.disabled) return null

  const state = config.state ?? {
    activeDeploymentByAgent: {},
    deploymentsByAgent: {},
    releasesByAgent: {},
    allReleases: [],
    listAllDeploymentsForAgent: {},
  }

  return {
    listAgents() {
      return config.listAgents ?? []
    },
    getAgent(name) {
      return config.getAgent?.[name] ?? null
    },
    getLocalAgent(name) {
      return config.getLocalAgent?.[name] ?? null
    },
    getDeployment(name) {
      return state.activeDeploymentByAgent[name] ?? null
    },
    getDeploymentBySha(sha) {
      // Search all active deployments
      for (const dep of Object.values(state.activeDeploymentByAgent)) {
        if (dep && dep.id === sha) return dep
      }
      return null
    },
    getActiveDeployment(name) {
      return state.activeDeploymentByAgent[name] ?? null
    },
    listDeployments(name) {
      return state.deploymentsByAgent[name] ?? []
    },
    listAllDeploymentsForAgent(name) {
      return state.listAllDeploymentsForAgent[name] ?? []
    },
    removeLocalAgent(name) {
      // No-op for the stub.
    },
    listAllReleases() {
      return state.allReleases
    },
    listAllReleasesForAgent(name) {
      return state.releasesByAgent[name] ?? []
    },
    listReleases(name) {
      return state.releasesByAgent[name] ?? []
    },
  }
}

export function __resetTestDb() {
  globalThis.__testConfig.db = {}
}

export default {getDb, __resetTestDb}
