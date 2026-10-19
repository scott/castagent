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

nyc mocha --forbid-only 'tests/**/*.test.ts'
status=$?

npm run clean:test
clean_status=$?
if [ "$status" -eq 0 ]; then
  status=$clean_status
fi

exit "$status"
