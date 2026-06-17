---
title: Building and testing
section: development
order: 2
description: npm scripts, test suites, and the test coverage CI workflow.
ref: ['']
---

# Building and testing

## Building

From the repo root:

```bash
npm run build                # CLI + TUI
npm run build:cli            # CLI only
npm run build:tui            # TUI only
```

Each workspace builds with `tsc -b` and emits to its own `dist/`. The
wrapper `cast` at the repo root is a bash script that calls
`typescript/cast-cli/bin/run`.

For the docs site:

```bash
npm --prefix docs-site install
npm --prefix docs-site run dev       # local dev with auto-extraction
npm --prefix docs-site run build     # static build to docs-site/dist/
```

## Testing

End-to-end:

```bash
./test.sh                     # the full local test
```

Per-layer:

```bash
npm test                                 # TypeScript CLI tests + coverage
cd typescript/cast-cli && npm test       # CLI only
cd python && python -m pytest tests/    # Python tests
cast meta test                           # meta-builder scenarios
cast meta test --scenario create-simple  # one scenario
```

The meta-builder is a TypeScript CLI + Python test harness in
`typescript/cast-cli/src/commands/meta/` and `tests/python/`. Each
scenario describes a builder conversation, runs it, and asserts on the
resulting agent scaffold.

## Continuous integration

Every push to `master` and every pull request runs the
**Test Coverage** workflow (`.github/workflows/test.yml`):

- **TypeScript tests with coverage** — Node 18.x and 20.x in parallel,
  with `nyc` instrumentation and `tsc --noEmit` type checking.
- **Python tests with coverage** — Python 3.11 and 3.12.
- **Quality checks** — `tsc --noEmit`, `ruff`/`flake8` linting, and
  `mypy` type checking on the same Python 3.11 + Node 20 runner.
- **Coverage Summary** — downloads the matrix artifacts and posts a
  sticky PR comment summarising per-language coverage runs.
- **Coverage Threshold Check** — enforces the `COVERAGE_THRESHOLD` env
  var (default 70%). Skipped on PRs by default; opt in by including
  `[enforce-coverage]` in the PR title or commit message, or by
  pushing to `master`.
- **Build Verification** — runs `npm run build` to confirm the
  TypeScript projects still produce their `dist/` artifacts.

## Docs CI

The docs site has its own workflow at `.github/workflows/docs.yml`:

- On every PR that touches `docs-site/`, `typescript/cast-cli/src/commands/`,
  `typescript/cast-tui/src/commands/`, or `CHANGELOG.md`, the workflow
  runs `npm --prefix docs-site run check` and posts the manifest diff
  as a PR comment.
- On push to `master`, the workflow builds the site and deploys to
  GitHub Pages.

The manifest diff is the key feature: it tells reviewers exactly which
commands, slash commands, providers, or models were added or removed
in the PR, without them having to read the diff manually.

## Changesets

Cast uses [changesets](https://github.com/changesets/changesets) for
versioning. The `Auto Create Changeset` workflow generates one
automatically from PR labels (`major`/`breaking`, `minor`/`feature`,
`fix`) and conventional commit prefixes (`feat:`, `fix:`,
`BREAKING CHANGE:`). If you prefer to author one by hand:

```bash
npx changeset
# select '*' (all packages)
# select bump type
# write a summary
```

See [the contributing guide](https://github.com/scott/castagent/blob/master/CONTRIBUTING.md)
for the full workflow.
