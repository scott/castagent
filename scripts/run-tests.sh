#!/bin/sh
# npm test entrypoint.
#
# The suite used to be followed by cleanup with `;`. A shell runs the next
# command after `;` whether or not the previous one failed, and the script's
# status is the last command. `npm run clean:test` succeeds even when mocha
# aborts, so Test & Coverage went green without a single passing test.
#
# Cleanup still runs. Its status replaces the suite status only when the
# suite itself exited 0.

set -u

ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

# `npm test` puts node_modules/.bin on PATH. A direct `sh` invocation does not.
# Skip the prepend when nyc is already resolvable so a test can substitute it.
if ! command -v nyc >/dev/null 2>&1; then
  PATH="$ROOT/node_modules/.bin:$PATH"
  export PATH
fi

# providers.json is gitignored. Mocha reads it while loading
# tests/ts/docs/landing-page.test.ts, and a missing file aborts the run
# before any test. Prefer the docs-site extractor; the node fallback covers
# checkouts that have not installed docs-site.
if [ -x "$ROOT/docs-site/node_modules/.bin/tsx" ]; then
  "$ROOT/docs-site/node_modules/.bin/tsx" "$ROOT/docs-site/scripts/extract-providers.ts"
else
  node "$ROOT/scripts/ensure-providers-json.js"
fi
status=$?

if [ "$status" -eq 0 ]; then
  # --exit: a finished suite still holds the sqlite handle and other
  # leftovers, and mocha would otherwise wait forever. The status is
  # the test result; --exit only ends the process after that.
  # Mocha 11 uses only the last --reporter, so a second --reporter json
  # dropped the spec lines from the CI log. This reporter prints spec and
  # writes the JSON file the PR-versus-main compare reads.
  mkdir -p "$ROOT/test-results"
  nyc mocha --forbid-only --exit \
    --reporter "$ROOT/scripts/mocha-spec-json.cjs" \
    --reporter-option "output=$ROOT/test-results/mocha.json" \
    'tests/**/*.test.ts'
  status=$?
fi

npm run clean:test
clean_status=$?
if [ "$status" -eq 0 ]; then
  status=$clean_status
fi

exit "$status"
