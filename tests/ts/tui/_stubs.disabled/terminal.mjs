// Stub for terminal.js (runDeployInTerminal) — see ../_runner.mjs for
// the test orchestration.
//
// We also record calls so tests can assert that /deploy (with a
// provider arg) skipped the modal flow and went straight to the
// terminal runner.

if (!globalThis.__testConfig) globalThis.__testConfig = {}
if (!globalThis.__testConfig.deployCalls) globalThis.__testConfig.deployCalls = []

export async function runDeployInTerminal(renderer, _input, agentName, provider, _messages) {
  globalThis.__testConfig.deployCalls.push({agentName, provider})
}

export function __resetTestDeployCalls() {
  globalThis.__testConfig.deployCalls = []
}

export default {runDeployInTerminal, __resetTestDeployCalls}
