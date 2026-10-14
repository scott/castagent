#!/bin/bash
# Exercises upgrade.sh against temporary git checkouts and stubbed toolchains.
# Never runs the workspace copy in place: that would fast-forward this repo.

set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_SRC="$SOURCE_ROOT/upgrade.sh"

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

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cast-upgrade-test.XXXXXX")"
TMP="$(cd "$TMP" && pwd)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/empty-hooks" "$TMP/stubs"
REAL_GIT="$(command -v git)"
PATH="$TMP/stubs:$(dirname "$REAL_GIT"):/usr/bin:/bin"
export PATH
export CAST_UPGRADE_LOG="$TMP/calls.log"
export CAST_UPGRADE_SKIP_SYSTEM_BIN=1
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=protocol.file.allow
export GIT_CONFIG_VALUE_0=always
unset CAST_UPGRADE_REEXEC CAST_UPGRADE_ROOT || true

cat > "$TMP/stubs/node" << 'EOF'
#!/bin/bash
printf '%s\n' "node $(pwd) $*" >> "${CAST_UPGRADE_LOG:?}"
if [[ "${1:-}" == "-v" ]]; then
    printf '%s\n' "v20.20.0"
fi
exit 0
EOF

cat > "$TMP/stubs/npm" << 'EOF'
#!/bin/bash
printf '%s\n' "npm $(pwd) $*" >> "${CAST_UPGRADE_LOG:?}"
exit 0
EOF

cat > "$TMP/stubs/python3" << 'EOF'
#!/bin/bash
printf '%s\n' "python3 $(pwd) $*" >> "${CAST_UPGRADE_LOG:?}"
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "Python 3.12.0"
    exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then
    dest="${3:-.venv}"
    mkdir -p "$dest/bin"
    abs="$(cd "$dest" && pwd)"
    cat > "$abs/bin/activate" << EOS
export PATH="$abs/bin:\$PATH"
EOS
    cat > "$abs/bin/pip" << 'EOS'
#!/bin/bash
printf '%s\n' "pip $(pwd) $*" >> "${CAST_UPGRADE_LOG:?}"
exit 0
EOS
    chmod +x "$abs/bin/pip"
    printf '%s\n' '#!/bin/bash' 'exit 0' > "$abs/bin/python"
    chmod +x "$abs/bin/python"
    exit 0
fi
exit 0
EOF

cat > "$TMP/stubs/pip3" << 'EOF'
#!/bin/bash
printf '%s\n' "pip3 $(pwd) $*" >> "${CAST_UPGRADE_LOG:?}"
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "pip 24.0 from stub"
fi
exit 0
EOF

chmod +x "$TMP/stubs/node" "$TMP/stubs/npm" "$TMP/stubs/python3" "$TMP/stubs/pip3"

SYSTEM_CAST_BEFORE=""
if [[ -L /usr/local/bin/cast || -e /usr/local/bin/cast ]]; then
    SYSTEM_CAST_BEFORE="$(readlink /usr/local/bin/cast || printf 'file')"
fi

reset_log() {
    : > "$CAST_UPGRADE_LOG"
}

git_identity() {
    local repo="$1"
    git -C "$repo" config user.email upgrade-test@example.com
    git -C "$repo" config user.name "Upgrade Test"
    git -C "$repo" config commit.gpgsign false
    git -C "$repo" config protocol.file.allow always
    git -C "$repo" config core.hooksPath "$TMP/empty-hooks"
}

seed_tree() {
    local repo="$1"
    local version="$2"
    mkdir -p "$repo/typescript/cast-cli/bin" "$repo/typescript/cast-tui" "$repo/python"
    cat > "$repo/package.json" << EOF
{
  "name": "castagent",
  "version": "$version"
}
EOF
    cat > "$repo/typescript/cast-cli/package.json" << EOF
{
  "name": "cast-cli",
  "version": "$version"
}
EOF
    cat > "$repo/typescript/cast-tui/package.json" << EOF
{
  "name": "cast-tui",
  "version": "$version"
}
EOF
    printf '%s\n' '#!/bin/bash' 'echo cast-cli' > "$repo/typescript/cast-cli/bin/run"
    chmod +x "$repo/typescript/cast-cli/bin/run"
    printf '%s\n' '#!/bin/bash' 'echo cast' > "$repo/cast"
    chmod +x "$repo/cast"
    printf '%s\n' '[project]' 'name = "cast"' "version = \"$version\"" > "$repo/python/pyproject.toml"
}

commit_all() {
    local repo="$1"
    local message="$2"
    git -C "$repo" add .
    git -C "$repo" commit -m "$message" >/dev/null
}

make_pair() {
    local name="$1"
    local origin="$TMP/$name/origin.git"
    local repo="$TMP/$name/repo"
    rm -rf "${TMP:?}/${name:?}"
    mkdir -p "$repo"
    git -c init.defaultBranch=master init --bare "$origin" >/dev/null
    seed_tree "$repo" "1.0.0"
    git -c init.defaultBranch=master init "$repo" >/dev/null
    git_identity "$repo"
    commit_all "$repo" "initial"
    git -C "$repo" branch -M master
    git -C "$repo" remote add origin "$origin"
    git -C "$repo" push -u origin master >/dev/null
    cp "$SCRIPT_SRC" "$repo/upgrade.sh"
    chmod +x "$repo/upgrade.sh"
    PAIR_ORIGIN="$origin"
    PAIR_REPO="$repo"
}

advance_origin() {
    local origin="$1"
    local version="$2"
    local clone="$TMP/advance-$RANDOM"
    git clone "$origin" "$clone" >/dev/null 2>&1
    git_identity "$clone"
    local file="$clone/typescript/cast-cli/package.json"
    local tmp
    tmp="$(mktemp)"
    sed "s/\"version\": \"[^\"]*\"/\"version\": \"$version\"/" "$file" > "$tmp"
    mv "$tmp" "$file"
    git -C "$clone" add typescript/cast-cli/package.json
    git -C "$clone" commit -m "version $version" >/dev/null
    git -C "$clone" push origin HEAD >/dev/null
}

prepare_home() {
    local home="$1"
    local repo="$2"
    mkdir -p "$home/.cast/agents/demo" "$home/.cast/bin" "$home/.local/bin"
    printf '%s\n' 'SENTINEL-CONFIG' > "$home/.cast/config.yaml"
    printf '%s\n' 'SENTINEL-AGENT' > "$home/.cast/agents/demo/agent.yaml"
    printf '%s\n' 'stale-binary' > "$home/.cast/bin/cast"
    ln -sfn "$repo/cast" "$home/.local/bin/cast"
}

prepare_venv() {
    local repo="$1"
    local venv="$repo/python/.venv"
    mkdir -p "$venv/bin"
    printf '%s\n' 'KEEP' > "$venv/KEEP"
    cat > "$venv/bin/activate" << EOF
export PATH="$venv/bin:\$PATH"
EOF
    cat > "$venv/bin/pip" << 'EOF'
#!/bin/bash
printf '%s\n' "pip $(pwd) $*" >> "${CAST_UPGRADE_LOG:?}"
exit 0
EOF
    chmod +x "$venv/bin/pip"
    printf '%s\n' '#!/bin/bash' 'exit 0' > "$venv/bin/python"
    chmod +x "$venv/bin/python"
}

run_upgrade() {
    local script="$1"
    local home="$2"
    local out="$3"
    shift 3
    set +e
    HOME="$home" bash "$script" "$@" >"$out" 2>&1
    RUN_STATUS=$?
    set -e
}

help_out="$TMP/help.out"
bash "$SCRIPT_SRC" --help >"$help_out"
assert_contains "$help_out" "Usage: ./upgrade.sh" "help prints usage"
assert_contains "$help_out" "origin/main" "help follows main"
assert_contains "$help_out" "cast upgrade <agent>" "help distinguishes deployed-agent upgrade"
set +e
bash "$SCRIPT_SRC" --nope >"$TMP/bad.out" 2>&1
bad_status=$?
set -e
[[ "$bad_status" -ne 0 ]] || fail "unknown flag should fail"
assert_contains "$TMP/bad.out" "Usage: ./upgrade.sh" "unknown flag prints usage"

missing_home="$TMP/missing/home"
mkdir -p "$missing_home" "$TMP/missing/outside"
cp "$SCRIPT_SRC" "$TMP/missing/outside/upgrade.sh"
reset_log
run_upgrade "$TMP/missing/outside/upgrade.sh" "$missing_home" "$TMP/missing/out"
[[ "$RUN_STATUS" -ne 0 ]] || fail "missing checkout should fail"
assert_contains "$TMP/missing/out" "Could not find a Cast checkout" "missing checkout explains itself"
assert_not_contains "$CAST_UPGRADE_LOG" "npm " "missing checkout does not install"

make_pair "ff"
advance_origin "$PAIR_ORIGIN" "2.0.0"
feature_base="$(git -C "$PAIR_REPO" rev-parse HEAD)"
git -C "$PAIR_REPO" checkout -b feature >/dev/null
printf '%s\n' 'local note' > "$PAIR_REPO/local-note.txt"
prepare_home "$TMP/ff/home" "$PAIR_REPO"
prepare_venv "$PAIR_REPO"
reset_log
run_upgrade "$PAIR_REPO/upgrade.sh" "$TMP/ff/home" "$TMP/ff/out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/ff/out" >&2; fail "fast-forward upgrade failed ($RUN_STATUS)"; }
assert_eq "$(git -C "$PAIR_REPO" rev-parse --abbrev-ref HEAD)" "master" "upgrade checks out the upstream branch"
assert_eq "$(git -C "$PAIR_REPO" rev-parse HEAD)" "$(git -C "$PAIR_REPO" rev-parse origin/master)" "upgrade fast-forwards to origin"
assert_contains "$PAIR_REPO/typescript/cast-cli/package.json" '"version": "2.0.0"' "checkout now has the new version"
assert_eq "$(git -C "$PAIR_REPO" rev-parse feature)" "$feature_base" "previous branch tip stays put"
assert_eq "$(cat "$TMP/ff/home/.cast/config.yaml")" "SENTINEL-CONFIG" "config is unchanged"
assert_eq "$(cat "$TMP/ff/home/.cast/agents/demo/agent.yaml")" "SENTINEL-AGENT" "agent files are unchanged"
assert_eq "$(cat "$PAIR_REPO/python/.venv/KEEP")" "KEEP" "existing virtualenv is reused"
assert_eq "$(cat "$PAIR_REPO/local-note.txt")" "local note" "untracked files stay"
[[ ! -e "$TMP/ff/home/.cast/bin/cast" ]] || fail "stale binary should be removed"
assert_eq "$(readlink "$TMP/ff/home/.local/bin/cast")" "$PAIR_REPO/cast" "symlink points at this checkout"
assert_contains "$CAST_UPGRADE_LOG" "npm $PAIR_REPO install --no-fund --no-audit" "root npm install"
assert_contains "$CAST_UPGRADE_LOG" "npm $PAIR_REPO/typescript/cast-cli install --no-fund --no-audit" "cli npm install"
assert_contains "$CAST_UPGRADE_LOG" "npm $PAIR_REPO/typescript/cast-tui install --no-fund --no-audit" "tui npm install"
assert_contains "$CAST_UPGRADE_LOG" "npm $PAIR_REPO/typescript/cast-cli run build" "cli build"
assert_contains "$CAST_UPGRADE_LOG" "npm $PAIR_REPO/typescript/cast-tui run build" "tui build"
assert_contains "$CAST_UPGRADE_LOG" "pip $PAIR_REPO/python install -e ." "python reinstall"
assert_contains "$CAST_UPGRADE_LOG" "pip $PAIR_REPO/python install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv" "python runtime deps"
assert_not_contains "$CAST_UPGRADE_LOG" "python3 $PAIR_REPO/python -m venv" "existing virtualenv is not recreated"
assert_contains "$TMP/ff/out" "Switching from feature to master" "upgrade tells you it left the old branch"
assert_contains "$TMP/ff/out" "Cast was rebuilt in place." "upgrade reports success"

make_pair "current"
prepare_home "$TMP/current/home" "$PAIR_REPO"
prepare_venv "$PAIR_REPO"
reset_log
run_upgrade "$PAIR_REPO/upgrade.sh" "$TMP/current/home" "$TMP/current/out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/current/out" >&2; fail "up-to-date upgrade failed"; }
assert_contains "$TMP/current/out" "Already on the newest master commit" "already-current checkout still rebuilds"
assert_contains "$CAST_UPGRADE_LOG" "npm $PAIR_REPO install --no-fund --no-audit" "up-to-date checkout reinstalls"
assert_eq "$(cat "$TMP/current/home/.cast/config.yaml")" "SENTINEL-CONFIG" "up-to-date upgrade leaves config"

make_pair "dirty"
printf '%s\n' 'dirty' >> "$PAIR_REPO/package.json"
dirty_sha="$(git -C "$PAIR_REPO" rev-parse HEAD)"
prepare_home "$TMP/dirty/home" "$PAIR_REPO"
reset_log
run_upgrade "$PAIR_REPO/upgrade.sh" "$TMP/dirty/home" "$TMP/dirty/out"
[[ "$RUN_STATUS" -ne 0 ]] || fail "dirty checkout should fail"
assert_eq "$(git -C "$PAIR_REPO" rev-parse HEAD)" "$dirty_sha" "dirty checkout is not moved"
assert_contains "$TMP/dirty/out" "uncommitted changes" "dirty checkout explains why it stopped"
assert_not_contains "$CAST_UPGRADE_LOG" "npm " "dirty checkout does not install"
assert_eq "$(cat "$TMP/dirty/home/.cast/config.yaml")" "SENTINEL-CONFIG" "failed upgrade leaves config"
[[ -f "$TMP/dirty/home/.cast/bin/cast" ]] || fail "failed upgrade should leave the stale binary"

make_pair "ahead"
git -C "$PAIR_REPO" commit --allow-empty -m "local only" >/dev/null
ahead_sha="$(git -C "$PAIR_REPO" rev-parse HEAD)"
git -C "$PAIR_REPO" checkout -b feature >/dev/null
prepare_home "$TMP/ahead/home" "$PAIR_REPO"
reset_log
run_upgrade "$PAIR_REPO/upgrade.sh" "$TMP/ahead/home" "$TMP/ahead/out"
[[ "$RUN_STATUS" -ne 0 ]] || fail "diverged master should fail"
assert_eq "$(git -C "$PAIR_REPO" rev-parse --abbrev-ref HEAD)" "feature" "diverged upgrade stays on the current branch"
assert_eq "$(git -C "$PAIR_REPO" rev-parse master)" "$ahead_sha" "local commits stay on the upstream branch"
assert_contains "$TMP/ahead/out" "Local master has commits that are not on origin/master." "diverged upgrade explains itself"
assert_not_contains "$CAST_UPGRADE_LOG" "npm " "diverged upgrade does not install"
[[ -f "$TMP/ahead/home/.cast/bin/cast" ]] || fail "diverged upgrade should leave the stale binary"

make_pair "discover"
advance_origin "$PAIR_ORIGIN" "2.0.0"
discover_home="$TMP/discover/home"
prepare_home "$discover_home" "$PAIR_REPO"
prepare_venv "$PAIR_REPO"
mkdir -p "$TMP/discover/outside"
cp "$SCRIPT_SRC" "$TMP/discover/outside/upgrade.sh"
reset_log
run_upgrade "$TMP/discover/outside/upgrade.sh" "$discover_home" "$TMP/discover/out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/discover/out" >&2; fail "symlink discovery upgrade failed"; }
assert_eq "$(git -C "$PAIR_REPO" rev-parse HEAD)" "$(git -C "$PAIR_REPO" rev-parse origin/master)" "discovered checkout fast-forwards"
assert_contains "$PAIR_REPO/typescript/cast-cli/package.json" '"version": "2.0.0"' "discovered checkout updates"
assert_eq "$(readlink "$discover_home/.local/bin/cast")" "$PAIR_REPO/cast" "discovered checkout keeps its symlink"

make_pair "mainonly"
git -C "$PAIR_REPO" push origin master:main >/dev/null
git --git-dir "$PAIR_ORIGIN" symbolic-ref HEAD refs/heads/main
git -C "$PAIR_REPO" push origin --delete master >/dev/null
git -C "$PAIR_REPO" fetch origin --prune >/dev/null
git -C "$PAIR_REPO" branch -M main
git -C "$PAIR_REPO" branch -u origin/main main
prepare_home "$TMP/mainonly/home" "$PAIR_REPO"
prepare_venv "$PAIR_REPO"
reset_log
run_upgrade "$PAIR_REPO/upgrade.sh" "$TMP/mainonly/home" "$TMP/mainonly/out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/mainonly/out" >&2; fail "main-only upgrade failed"; }
assert_eq "$(git -C "$PAIR_REPO" rev-parse --abbrev-ref HEAD)" "main" "main-only checkout stays on main"
assert_contains "$TMP/mainonly/out" "Already on the newest main commit" "main is the upstream when master is absent"

make_pair "prefermain"
prefer_old="$(git -C "$PAIR_REPO" rev-parse HEAD)"
git -C "$PAIR_REPO" push origin master:main >/dev/null
git --git-dir "$PAIR_ORIGIN" symbolic-ref HEAD refs/heads/main
advance_origin "$PAIR_ORIGIN" "2.0.0"
prepare_home "$TMP/prefermain/home" "$PAIR_REPO"
prepare_venv "$PAIR_REPO"
reset_log
run_upgrade "$PAIR_REPO/upgrade.sh" "$TMP/prefermain/home" "$TMP/prefermain/out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/prefermain/out" >&2; fail "main wins over a stale master ref"; }
assert_eq "$(git -C "$PAIR_REPO" rev-parse --abbrev-ref HEAD)" "main" "upgrade leaves master when main exists"
assert_eq "$(git -C "$PAIR_REPO" rev-parse HEAD)" "$(git -C "$PAIR_REPO" rev-parse origin/main)" "upgrade fast-forwards to origin/main"
assert_eq "$(git -C "$PAIR_REPO" rev-parse master)" "$prefer_old" "stale master ref is not the upstream"
assert_contains "$PAIR_REPO/typescript/cast-cli/package.json" '"version": "2.0.0"' "main commit is the one that is built"
assert_contains "$TMP/prefermain/out" "Switching from master to main" "upgrade says it left master for main"

cat > "$TMP/stubs/uv" << 'EOF'
#!/bin/bash
printf '%s\n' "uv $(pwd) $*" >> "${CAST_UPGRADE_LOG:?}"
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "uv 0.5.0"
    exit 0
fi
if [[ "${1:-}" == "venv" ]]; then
    mkdir -p .venv
    printf '%s\n' 'KEEP-UV' > .venv/KEEP
    exit 0
fi
exit 0
EOF
chmod +x "$TMP/stubs/uv"
make_pair "uvpath"
uv_home="$TMP/uvpath/home"
prepare_home "$uv_home" "$PAIR_REPO"
reset_log
run_upgrade "$PAIR_REPO/upgrade.sh" "$uv_home" "$TMP/uvpath/out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/uvpath/out" >&2; fail "uv upgrade failed"; }
assert_eq "$(cat "$PAIR_REPO/python/.venv/KEEP")" "KEEP-UV" "uv creates the virtualenv when it is missing"
assert_contains "$CAST_UPGRADE_LOG" "uv $PAIR_REPO/python venv" "uv creates the virtualenv"
assert_contains "$CAST_UPGRADE_LOG" "uv $PAIR_REPO/python pip install -e ." "uv reinstalls the runtime"
assert_contains "$CAST_UPGRADE_LOG" "uv $PAIR_REPO/python pip install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv" "uv installs runtime deps"
assert_not_contains "$CAST_UPGRADE_LOG" "python3 $PAIR_REPO/python -m venv" "uv path does not call venv"
rm -f "$TMP/stubs/uv"

if [[ -L /usr/local/bin/cast || -e /usr/local/bin/cast ]]; then
    system_cast_after="$(readlink /usr/local/bin/cast || printf 'file')"
    assert_eq "$system_cast_after" "$SYSTEM_CAST_BEFORE" "/usr/local/bin/cast outside the checkout is left alone"
elif [[ -e /usr/local/bin/cast ]]; then
    fail "/usr/local/bin/cast was created by the tests"
fi

printf 'ok\n'
