---
title: Verified changes
section: getting-started
order: 5
description: What counts as evidence that a fix is verified, and how to run those checks locally.
ref: ['']
---

# Verified changes

A pull request is verified when its checks are green. That includes the unit
suites, the mocked provider smoke suite, the CLI snapshot suite, and the
comparison against the merge base. Reviewers do not re-run those suites,
download full logs, or deploy to a real provider to confirm a fix the suites
already cover.

Hand testing is for a new kind of failure. Add that case to the mocks in the
same change.

## Evidence

One of these is enough to call a fix verified:

- A test that failed before the change and passes after it.
- The provider smoke suite is green. It runs `cast` against local fakes of
  Sprites, Fly, and DigitalOcean. It does not call those APIs and it does not
  use secrets.
- A CLI snapshot diff that a reviewer read. Snapshots change only when you
  run the update command locally and commit the new file. CI does not rewrite
  them.

The compare check lists two groups. A new failure passes on the merge base
and fails on the pull request. A failure that already fails on the base is
reported on its own and is not counted as new.

## Run them locally

Build the CLI first. The smoke suite and the snapshot runner both execute it.

```bash
npm install
cd typescript && npm install && cd ..
npm run build:cli
python3 -m pip install --user 'langchain-openai>=1.7.2' 'langchain-core>=1.6.12' pyyaml
```

Unit tests:

```bash
npm test
cd python && python -m pytest tests/python tests -q
```

Provider smoke. `--provider` and `--case` limit the run.

```bash
node tests/e2e/run.mjs
node tests/e2e/run.mjs --provider fly
node tests/e2e/run.mjs --case sprites.rollback
```

CLI snapshots, including the agent.yaml version messages:

```bash
node tests/cli-snapshots/run.mjs
```

Update a snapshot after you have read the new text:

```bash
UPDATE_SNAPSHOTS=1 node tests/cli-snapshots/run.mjs
UPDATE_ENDINGS=1 node tests/e2e/run.mjs
```

Compare this checkout with the merge base. The script reuses `node_modules`
when the lockfiles match and rebuilds the CLI and the TUI in each tree.
CI installs the docs-site dependencies and Bun first, so the extractor
test and the TUI error-handling tests run the same way as the unit job.

```bash
node scripts/compare-failures.mjs --run
```

`CONTRIBUTING.md` is the same rule for people working in the repository.
