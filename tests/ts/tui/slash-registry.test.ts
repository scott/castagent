/**
 * Tests for the cast-tui slash command registry.
 *
 * =============================================================================
 * TODO: REWORK THIS TEST FILE (see GitHub issue #18 for full details)
 * =============================================================================
 *
 * GitHub issue tracking the rework: #18
 * https://github.com/scott/agent-cast/issues/18
 *
 * The previous version of this file (now disabled at
 * `slash-registry.test.ts.disabled`) attempted to test the slash command
 * registry by spawning a Node subprocess with a custom ESM loader. The
 * reason: `cast-tui` is built for Bun and depends on `@opentui/core`,
 * which uses static `import "bun:ffi"` and `import "*.scm" with {
 * type: "file" }` statements that Node's ESM loader cannot resolve.
 *
 * ## What was discovered
 *
 * The subprocess approach has two critical problems:
 *
 *   1. **Inner `test()` calls are silently dropped**. The Mocha output
 *      only ever shows two passing tests:
 *        - "subprocess reported at least one test"
 *        - A single test auto-generated from the runner's filename.
 *      The runner file (`_runner.mjs.disabled`) registers 28 `test()`
 *      calls, and diagnostic logging confirms all 28 fire
 *      (`console.error('REGISTER:', ...)` runs for each one). But
 *      `node --test` only emits the outer subtest to TAP. The inner
 *      test results are lost.
 *
 *   2. **Two subprocess spawns per test file load**. The Mocha wrapper
 *      calls `execFileSync('node', ['--import', loaderBootstrap, '--test',
 *      runnerPath])` twice — once at module load to discover test names,
 *      once in `before()` to run them. Each spawn is ~1.5-2s (Node
 *      startup + ESM loader + dynamic import of the 2,073-line compiled
 *      `slash-registry.js`). This is the dominant cost when the full
 *      suite runs.
 *
 * ## What needs to happen
 *
 * Re-architect this test so the 9 new PRD-mandated slash commands
 * (`/changes`, `/releases`, `/release`, `/deploy`, `/upgrade`,
 * `/restore`, `/diff`, `/registry`, `/connect`) get real coverage
 * without a subprocess. Options to consider:
 *
 *   - **Refactor for testability**: Extract the testable logic
 *     (suggested-version calculation, validation, dispatch tables,
 *     etc.) out of the modal-flow closures into pure functions that
 *     can be tested in-process.
 *
 *   - **In-process module load with a Bun-compatible stub layer**:
 *     Pre-load the module's transitive dependencies via a `require`
 *     shim, or convert `@opentui/core` to a Node-compatible entry
 *     point. Risky but feasible if the TUI ever wants to run under
 *     Node at all.
 *
 *   - **Snapshot/visual tests with a TUI recorder**: For the modal
 *     flow itself (keyboard nav, button selection), use something
 *     like `terminalizer` or a custom OpenTUI recorder that can be
 *     run under Bun in CI.
 *
 *   - **Move the tests to a Bun test runner** (e.g. `bun test`) so
 *     the original TUI source can be loaded directly. Bun test runs
 *     `test()` calls correctly and supports TAP output.
 *
 * ## Files
 *
 *   - `slash-registry.test.ts`               — this file (placeholder)
 *   - `slash-registry.test.ts.disabled`      — the disabled Mocha wrapper
 *   - `_runner.mjs.disabled`                 — the disabled Node-test runner
 *   - `_loader.mjs.disabled`                 — the disabled ESM loader
 *   - `_stubs.disabled/`                     — the disabled stub modules
 *                                              (`@opentui/core`, modal,
 *                                              db, keychain, terminal,
 *                                              transcript, clipboardy,
 *                                              child_process)
 *
 * To re-enable the disabled harness, rename the `.disabled` files
 * back. They will compile and pass (2/28 tests) but with all the
 * limitations above.
 * =============================================================================
 */

describe('slash-registry (placeholder)', () => {
  it('is a placeholder until the TUI test architecture is reworked', () => {
    // Intentionally empty. See the file-level comment and the GitHub
    // issue tracking the rework for what this file should ultimately
    // contain.
  })
})
