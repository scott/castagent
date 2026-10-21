# Contributing

## What "verified" means

A pull request is verified when `gh pr checks` is green. That includes the unit suites, the mocked provider smoke suite, the CLI snapshot suite, and the PR-versus-main compare. Reviewers do not re-run those suites, download full CI logs, or deploy to a real provider to confirm a fix the suites already cover.

Live testing by hand is for a new kind of failure. When that happens, add the case to the mocks in the same change. A real-provider nightly is not part of verification.

Evidence that a fix is verified is one of these, checked in the pull request:

- A test that failed before the fix and passes after it. Say which test in the pull request. A green smoke suite is not a substitute when the fix needs that before-and-after test.
- The mocked provider smoke suite is green, and the change is one the smoke cases cover. It runs `cast` against local fakes. It does not call Sprites, Fly, or DigitalOcean and it does not use secrets.
- A CLI snapshot diff you reviewed. Updating a snapshot is a local command. CI never rewrites snapshots. The diff is the review.

A green compare line means the pull request did not add failures. Tests that already fail on the main tip are listed separately and are not new.

## Run the suites locally

Build the CLI before the smoke suite or the snapshot runner. Both execute `typescript/cast-cli/bin/run`.

```bash
npm install
cd typescript && npm install && cd ..
npm run build:cli
python3 -m pip install --user 'langchain-anthropic>=1.7.6' 'langchain-openai>=1.7.2' 'langchain-core>=1.6.12' pyyaml
```

Unit tests. `npm test` runs mocha. The Python session tests are a separate CI job; this command runs the Python suites locally:

```bash
npm test
cd python && python -m pytest tests/python tests -q
```

Provider smoke, one provider, or one case. `--provider` and `--case` together run only cases that match both:

```bash
node tests/e2e/run.mjs
node tests/e2e/run.mjs --provider fly
node tests/e2e/run.mjs --case sprites.rollback
node tests/e2e/run.mjs --provider fly --case fly.deploy
```

CLI snapshots. This command compares checked-in files. It does not update them:

```bash
node tests/cli-snapshots/run.mjs
node tests/cli-snapshots/run.mjs --case version.unquoted-1-10
```

Rewrite snapshots only when the new CLI text is what you want reviewers to accept:

```bash
UPDATE_SNAPSHOTS=1 node tests/cli-snapshots/run.mjs
UPDATE_ENDINGS=1 node tests/e2e/run.mjs
```

CI exits immediately if either variable is set.

PR versus main. CI reuses the mocha, pytest, smoke, and snapshot results already produced for the pull request. When those results have no failures, the base branch is not checked out. When they do, CI fetches the base tip with depth 1 and reruns only the failing ids. `node_modules` is reused when the lockfiles match. Docs-site dependencies and Bun are installed only for that rerun, because the extractor test and the TUI error-handling tests need them.

```bash
node scripts/compare-failures.mjs --run
```

Limit a local run while you are iterating:

```bash
node scripts/compare-failures.mjs --run --only mocha --mocha-files tests/ts/lib/agent-version.test.ts
```

Compare two result directories you already collected:

```bash
node scripts/compare-failures.mjs --base /tmp/base-results --head /tmp/head-results
```

The summary is `compare-summary.json`. `newFailures` passed on the base and fail on the head. `alreadyFailing` fail on both. The command exits 1 only when `newFailures` is not empty.

## Issue #18

The old TUI slash-command subprocess harness was removed. Release, deploy-list, and connect helpers have mocha tests, and `tests/cli-snapshots/snapshots/slash.version-helpers.txt` records their formatted text. #18 stays open. The modal keyboard flow is not tested, and `/changes`, `/versions`, `/diff`, and `/restore` are not commands anymore.
