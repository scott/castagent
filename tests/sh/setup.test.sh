#!/bin/bash
# Exercises setup.sh without touching the network, this repo, or the real home directory.

set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_SRC="$SOURCE_ROOT/setup.sh"

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

assert_eq() {
    local got="$1"
    local want="$2"
    local msg="$3"
    if [[ "$got" != "$want" ]]; then
        printf 'FAIL: %s\n  got:  [%s]\n  want: [%s]\n' "$msg" "$got" "$want" >&2
        exit 1
    fi
}

assert_contains() {
    local file="$1"
    local needle="$2"
    local msg="$3"
    if ! grep -F -q -- "$needle" "$file"; then
        printf 'FAIL: %s\n  missing: [%s]\n  log:\n' "$msg" "$needle" >&2
        cat "$file" >&2
        exit 1
    fi
}

assert_not_contains() {
    local file="$1"
    local needle="$2"
    local msg="$3"
    if grep -F -q -- "$needle" "$file"; then
        printf 'FAIL: %s\n  unexpected: [%s]\n  log:\n' "$msg" "$needle" >&2
        cat "$file" >&2
        exit 1
    fi
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cast-setup-test.XXXXXX")"
TMP="$(cd "$TMP" && pwd)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/stubs" "$TMP/binonly"
LOG="$TMP/calls.log"
ORIGINAL_PATH="$PATH"
: > "$LOG"

cat > "$TMP/stubs/uv" << 'EOF'
#!/bin/bash
printf '%s\n' "uv $(pwd) $*" >> "${CAST_SETUP_LOG:?}"
if [[ "${1:-}" == "venv" ]]; then
    mkdir -p .venv
    if [[ ! -f .venv/KEEP ]]; then
        printf '%s\n' 'KEEP-UV' > .venv/KEEP
    fi
    exit 0
fi
exit 0
EOF
chmod +x "$TMP/stubs/uv"

cat > "$TMP/stubs/python3" << 'PYSTUB'
#!/bin/bash
printf '%s\n' "python3 $(pwd) $*" >> "${CAST_SETUP_LOG:?}"
if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then
    if [[ "${CAST_SETUP_VENV_FAIL:-}" == 1 ]]; then
        exit 1
    fi
    dest="${3:-.venv}"
    case "$dest" in
        /*) ;;
        *) dest="$(pwd)/$dest" ;;
    esac
    mkdir -p "$dest/bin"
    cat > "$dest/bin/activate" << ACTIVATE
export PATH="$dest/bin:\$PATH"
ACTIVATE
    cat > "$dest/bin/pip" << 'PIPSTUB'
#!/bin/bash
printf '%s\n' "pip $(pwd) $*" >> "${CAST_SETUP_LOG:?}"
exit 0
PIPSTUB
    chmod +x "$dest/bin/pip"
    if [[ ! -f "$dest/KEEP" ]]; then
        printf '%s\n' 'KEEP-PY' > "$dest/KEEP"
    fi
    exit 0
fi
exit 0
PYSTUB
chmod +x "$TMP/stubs/python3"

prepare_checkout() {
    local dest="$1"
    rm -rf "$dest"
    mkdir -p "$dest/python"
    printf '%s\n' '[project]' 'name = "cast"' > "$dest/python/pyproject.toml"
    cp "$SCRIPT_SRC" "$dest/setup.sh"
    chmod +x "$dest/setup.sh"
}

run_setup() {
    local checkout="$1"
    local home="$2"
    local out="$3"
    shift 3
    mkdir -p "$home"
    : > "$LOG"
    set +e
    CAST_SETUP_LOG="$LOG" HOME="$home" PATH="$PATH" bash "$checkout/setup.sh" "$@" >"$out" 2>&1
    RUN_STATUS=$?
    set -e
}

RUNTIME_PKGS="langchain langchain-anthropic langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv"

# uv creates the virtualenv and installs the runtime packages.
prepare_checkout "$TMP/uv-checkout"
mkdir -p "$TMP/uv-home"
PATH="$TMP/stubs:/bin"
export PATH
run_setup "$TMP/uv-checkout" "$TMP/uv-home" "$TMP/uv.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/uv.out" >&2; fail "uv setup failed ($RUN_STATUS)"; }
assert_eq "$(cat "$TMP/uv-checkout/python/.venv/KEEP")" "KEEP-UV" "uv creates python/.venv"
assert_contains "$LOG" "uv $TMP/uv-checkout/python venv" "uv creates the virtualenv"
assert_contains "$LOG" "uv $TMP/uv-checkout/python pip install -e ." "uv installs the Cast package"
assert_contains "$LOG" "uv $TMP/uv-checkout/python pip install $RUNTIME_PKGS" "uv installs cast dev packages"
assert_not_contains "$LOG" "python3 " "uv path does not call python3 -m venv"
[[ ! -e "$TMP/uv-home/.local/bin/cast" ]] || fail "default setup leaves ~/.local/bin/cast alone"
assert_contains "$TMP/uv.out" "Did not create ~/.local/bin/cast." "default setup says it skipped the global link"
assert_contains "$TMP/uv.out" "Pass --link to point ~/.local/bin/cast at this checkout ($TMP/uv-checkout/cast)." "default setup names --link"
assert_contains "$TMP/uv.out" "Python environment ready at python/.venv" "uv setup reports the virtualenv"
assert_contains "$TMP/uv.out" "npm ci" "setup names npm ci"
assert_contains "$TMP/uv.out" "npm run build" "setup names the TypeScript build"
assert_contains "$TMP/uv.out" "./cast dev <agent>" "setup names the checkout command"
assert_not_contains "$TMP/uv.out" "Cast is now installed" "setup does not claim the CLI is installed"

# An existing virtualenv is reused. Packages are still installed.
run_setup "$TMP/uv-checkout" "$TMP/uv-home" "$TMP/uv-again.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/uv-again.out" >&2; fail "second uv setup failed"; }
assert_eq "$(cat "$TMP/uv-checkout/python/.venv/KEEP")" "KEEP-UV" "existing virtualenv is reused"
assert_not_contains "$LOG" "uv $TMP/uv-checkout/python venv" "existing virtualenv is not recreated"
assert_contains "$LOG" "uv $TMP/uv-checkout/python pip install -e ." "existing virtualenv still installs packages"

# python3 -m venv when uv is absent.
prepare_checkout "$TMP/py-checkout"
PATH="$TMP/stubs:/bin"
# Hide uv for this run by using a path that contains python3 only.
mkdir -p "$TMP/py-stubs"
cp "$TMP/stubs/python3" "$TMP/py-stubs/python3"
PATH="$TMP/py-stubs:/bin"
run_setup "$TMP/py-checkout" "$TMP/py-home" "$TMP/py.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/py.out" >&2; fail "python3 setup failed ($RUN_STATUS)"; }
assert_eq "$(cat "$TMP/py-checkout/python/.venv/KEEP")" "KEEP-PY" "python3 creates python/.venv"
assert_contains "$LOG" "python3 $TMP/py-checkout/python -m venv .venv" "python3 creates the virtualenv"
assert_contains "$LOG" "pip $TMP/py-checkout/python install -e ." "pip installs the Cast package"
assert_contains "$LOG" "pip $TMP/py-checkout/python install $RUNTIME_PKGS" "pip installs cast dev packages"
assert_not_contains "$LOG" "uv " "python3 path does not call uv"

# A failed venv creation stops setup and explains the Debian package.
prepare_checkout "$TMP/fail-checkout"
export CAST_SETUP_VENV_FAIL=1
run_setup "$TMP/fail-checkout" "$TMP/fail-home" "$TMP/fail.out"
unset CAST_SETUP_VENV_FAIL
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/fail.out" >&2; fail "failed venv should stop setup"; }
assert_contains "$TMP/fail.out" "Could not create python/.venv. On Debian and Ubuntu, install python3-venv and run ./setup.sh again." "failed venv names python3-venv"
[[ ! -d "$TMP/fail-checkout/python/.venv" ]] || fail "failed venv left python/.venv behind"

# Neither python3 nor uv is available. /bin is /usr/bin on this image, so
# the PATH has to be a directory that contains the shell tools and nothing else.
prepare_checkout "$TMP/missing-checkout"
mkdir -p "$TMP/minpath"
for cmd in bash mkdir rm ln chmod cat dirname pwd; do
    ln -sfn "$(command -v "$cmd")" "$TMP/minpath/$cmd"
done
PATH="$TMP/minpath"
run_setup "$TMP/missing-checkout" "$TMP/missing-home" "$TMP/missing.out"
PATH="$ORIGINAL_PATH"
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/missing.out" >&2; fail "missing python3 should stop setup"; }
assert_contains "$TMP/missing.out" "python3 is required to create python/.venv" "missing python3 explains itself"

# An existing global cast command stays put unless --link is passed.
prepare_checkout "$TMP/link-checkout"
mkdir -p "$TMP/link-home/.local/bin" "$TMP/other-checkout"
printf '%s\n' '#!/bin/bash' 'echo other' > "$TMP/other-checkout/cast"
chmod +x "$TMP/other-checkout/cast"
ln -s "$TMP/other-checkout/cast" "$TMP/link-home/.local/bin/cast"
PATH="$TMP/stubs:/bin"
run_setup "$TMP/link-checkout" "$TMP/link-home" "$TMP/link-keep.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/link-keep.out" >&2; fail "setup without --link failed"; }
assert_eq "$(readlink "$TMP/link-home/.local/bin/cast")" "$TMP/other-checkout/cast" "default setup keeps the existing cast link"
assert_contains "$TMP/link-keep.out" "Left ~/.local/bin/cast pointing at $TMP/other-checkout/cast." "default setup prints the link it left alone"

run_setup "$TMP/link-checkout" "$TMP/link-home" "$TMP/link-move.out" --link
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/link-move.out" >&2; fail "setup --link failed"; }
assert_eq "$(readlink "$TMP/link-home/.local/bin/cast")" "$TMP/link-checkout/cast" "--link points cast at this checkout"
assert_contains "$TMP/link-move.out" "Replaced ~/.local/bin/cast." "--link says it replaced the command"
assert_contains "$TMP/link-move.out" "  was: $TMP/other-checkout/cast" "--link prints the previous target"
assert_contains "$TMP/link-move.out" "  now: $TMP/link-checkout/cast" "--link prints the new target"

run_setup "$TMP/link-checkout" "$TMP/fresh-link-home" "$TMP/link-new.out" --link
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/link-new.out" >&2; fail "setup --link with no existing command failed"; }
assert_eq "$(readlink "$TMP/fresh-link-home/.local/bin/cast")" "$TMP/link-checkout/cast" "--link creates ~/.local/bin/cast"
assert_contains "$TMP/link-new.out" "Linked ~/.local/bin/cast -> $TMP/link-checkout/cast" "--link prints a new link"

rm -f "$TMP/link-home/.local/bin/cast"
printf '%s\n' '#!/bin/bash' 'echo file' > "$TMP/link-home/.local/bin/cast"
run_setup "$TMP/link-checkout" "$TMP/link-home" "$TMP/link-file.out" --link
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/link-file.out" >&2; fail "setup --link over a file failed"; }
assert_contains "$TMP/link-file.out" "Replaced ~/.local/bin/cast with a link to $TMP/link-checkout/cast." "--link names a replaced file"
[[ -L "$TMP/link-home/.local/bin/cast" ]] || fail "--link replaces a regular file with a symlink"

run_setup "$TMP/link-checkout" "$TMP/bad-home" "$TMP/bad.out" --nope
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/bad.out" >&2; fail "unknown option should fail"; }
assert_contains "$TMP/bad.out" "Unknown option: --nope" "unknown option is named"
[[ ! -e "$TMP/bad-home/.local/bin/cast" ]] || fail "unknown option does not create a cast link"

printf '%s\n' "ok"
