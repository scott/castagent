// Stub for `child_process` used by the cast-tui source.
//
// The real `child_process.execFileSync` would actually shell out to
// the cast binary, which (a) is destructive, (b) blocks the test
// process waiting for the child to exit, and (c) writes to stdio
// inherited from the test process. This stub:
//
//   - Records every call to `execFileSync` (and `execSync`, `spawn`)
//     on `__testConfig.execFileSyncCalls` so tests can assert on
//     the binary + args.
//   - Returns a sensible default so the rest of the production code
//     proceeds: `findCastBinary` is the only consumer and treats a
//     falsy return as "binary not found", which leads it to print an
//     error and call `process.exit(1)` (intercepted by the test
//     runner as a sentinel).

if (!globalThis.__testConfig) globalThis.__testConfig = {}
if (!globalThis.__testConfig.execFileSyncCalls) globalThis.__testConfig.execFileSyncCalls = []

// ESM modules don't have `__dirname` defined. The cast-tui source
// uses it inside `findCastBinary`. We define a global that resolves
// to the slash-registry source location so the relative path lookups
// in findCastBinary don't throw.
if (!globalThis.__dirname) {
  globalThis.__dirname = '/Users/scott/Workspace/agent-cast/typescript/cast-tui/dist/commands'
}

export function execFileSync(file, args, options) {
  globalThis.__testConfig.execFileSyncCalls.push({file, args: args || [], options: options || null})
  // `which cast` returns a string when found, an empty string when
  // not. findCastBinary interprets both — it just checks for
  // `castPath && fs.existsSync(castPath)`. An empty string is falsy,
  // so the production code takes the "binary not found" branch.
  if (file === 'which') {
    return ''
  }
  return ''
}

export function execSync(command, options) {
  globalThis.__testConfig.execFileSyncCalls.push({command, options: options || null})
  return ''
}

export function spawn(command, args, options) {
  globalThis.__testConfig.execFileSyncCalls.push({command, args: args || [], options: options || null})
  // Return a no-op ChildProcess-ish object so chained calls don't
  // throw.
  const handlers = {}
  return {
    stdout: {on: (ev, fn) => { handlers[`stdout.${ev}`] = fn }},
    stderr: {on: (ev, fn) => { handlers[`stderr.${ev}`] = fn }},
    on: (ev, fn) => { handlers[ev] = fn; if (ev === 'close') fn(0) },
  }
}

export function __resetExecCalls() {
  globalThis.__testConfig.execFileSyncCalls = []
}

export default {
  execFileSync,
  execSync,
  spawn,
  __resetExecCalls,
}
