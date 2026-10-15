#!/bin/bash
# Exercises install.sh without touching the network, this repo, or /usr/local/bin.
# Toolchains are stubs. The script under test is copied into fake checkouts.

set -euo pipefail

SOURCE_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT_SRC="$SOURCE_ROOT/install.sh"

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

assert_install_hints() {
    local file="$1"
    assert_contains "$file" "cast new" "quick start creates an agent with cast new"
    assert_contains "$file" "cast dev <agent>" "quick start runs an agent with cast dev"
    assert_contains "$file" "Create your first agent: cast new" "next steps use cast new"
    assert_contains "$file" "Start developing: cast dev <agent>" "next steps use cast dev"
    assert_contains "$file" "https://castagent.dev" "install points at the docs site"
    assert_not_contains "$file" "cast <agent-name>" "quick start does not treat an agent name as a command"
    assert_not_contains "$file" "my-first-agent" "next steps do not run an agent name as a command"
    assert_not_contains "$file" "docs/SPEC.md" "install does not point at the spec file"
}

TMP="$(mktemp -d "${TMPDIR:-/tmp}/cast-install-test.XXXXXX")"
TMP="$(cd "$TMP" && pwd)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/stubs" "$TMP/tools" "$TMP/fixtures" "$TMP/work"
REAL_GIT="$(command -v git)"
PATH="$TMP/stubs:/usr/bin:/bin"
export PATH
export CAST_INSTALL_LOG="$TMP/calls.log"
export CAST_INSTALL_SKIP_SYSTEM_BIN=1
export CAST_INSTALL_TEST_SCRIPT="$SCRIPT_SRC"
export CAST_GIT_READY="$TMP/git-ready"
export CAST_UV_STUB="$TMP/fixtures/uv"
export CAST_UNAME_S=Linux
export CAST_UNAME_M=x86_64
export GIT_TERMINAL_PROMPT=0

cat > "$TMP/stubs/uname" << 'EOF'
#!/bin/bash
if [[ "${1:-}" == "-m" ]]; then
    printf '%s\n' "${CAST_UNAME_M:-x86_64}"
else
    printf '%s\n' "${CAST_UNAME_S:-Linux}"
fi
EOF

cat > "$TMP/stubs/git" << 'EOF'
#!/bin/bash
printf 'git %s\n' "$*" >> "${CAST_INSTALL_LOG:?}"
if [[ ! -f "${CAST_GIT_READY:?}" ]]; then
    exit 127
fi
dir="."
if [[ "${1:-}" == "-C" ]]; then
    dir="$2"
    shift 2
fi
if [[ "${1:-}" == "rev-parse" ]]; then
    if [[ -d "$dir/.git" ]]; then
        printf '%s\n' "true"
        exit 0
    fi
    exit 1
fi
if [[ "${1:-}" == "clone" ]]; then
    dest="${!#}"
    mkdir -p "$dest/typescript/cast-cli/bin" "$dest/typescript/cast-tui" "$dest/python" "$dest/.git"
    printf '%s\n' '#!/bin/bash' 'echo cast-cli' > "$dest/typescript/cast-cli/bin/run"
    chmod +x "$dest/typescript/cast-cli/bin/run"
    printf '%s\n' '{"name":"cast-cli"}' > "$dest/typescript/cast-cli/package.json"
    printf '%s\n' '{"name":"cast-tui"}' > "$dest/typescript/cast-tui/package.json"
    printf '%s\n' '[project]' 'name = "cast"' > "$dest/python/pyproject.toml"
    printf '%s\n' '{"name":"castagent"}' > "$dest/package.json"
    cp "${CAST_INSTALL_TEST_SCRIPT:?}" "$dest/install.sh"
    cp "${CAST_INSTALL_TEST_CHECKSUMS:?}" "$dest/install-checksums.txt"
    chmod +x "$dest/install.sh"
    exit 0
fi
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "git version 2.0.0"
    exit 0
fi
exit 0
EOF

cat > "$TMP/stubs/curl" << 'EOF'
#!/bin/bash
url=""
out=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -o)
            out="$2"
            shift 2
            ;;
        -o*)
            out="${1#-o}"
            shift
            ;;
        http://*|https://*)
            url="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done
printf 'curl %s\n' "$url" >> "${CAST_INSTALL_LOG:?}"
if [[ "$url" == *nodejs.org* ]]; then
    printf '%s' 'node-bytes' > "$out"
    exit 0
fi
if [[ "$url" == *github.com/astral-sh/uv* ]]; then
    printf '%s' 'uv-bytes' > "$out"
    exit 0
fi
if [[ "$url" == *oven-sh/bun* ]]; then
    case "$url" in
        *bun-linux-aarch64.zip) printf '%s' 'bun-linux-aarch64' > "$out" ;;
        *bun-darwin-x64.zip) printf '%s' 'bun-darwin-x64' > "$out" ;;
        *bun-darwin-aarch64.zip) printf '%s' 'bun-darwin-aarch64' > "$out" ;;
        *) printf '%s' 'bun-linux-x64' > "$out" ;;
    esac
    exit 0
fi
printf 'unexpected curl %s\n' "$url" >&2
exit 1
EOF

cat > "$TMP/stubs/tar" << 'TARSTUB'
#!/bin/bash
dest=""
archive=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -C)
            dest="$2"
            shift 2
            ;;
        *.tar.gz|*.tgz)
            archive="$1"
            shift
            ;;
        *)
            shift
            ;;
    esac
done
printf 'tar-extract %s\n' "$archive" >> "${CAST_INSTALL_LOG:?}"
if [[ -z "$dest" ]]; then
    printf 'tar stub missing -C\n' >&2
    exit 1
fi
if [[ "$archive" == *uv* ]]; then
    cp "${CAST_UV_STUB:?}" "$dest/uv"
    chmod +x "$dest/uv"
    exit 0
fi
mkdir -p "$dest/bin"
cat > "$dest/bin/node" << 'EOF'
#!/bin/bash
if [[ "${1:-}" == "-v" ]]; then
    printf '%s\n' "v20.19.0"
fi
exit 0
EOF
cat > "$dest/bin/npm" << 'EOF'
#!/bin/bash
printf 'npm %s %s\n' "$(pwd)" "$*" >> "${CAST_INSTALL_LOG:?}"
if [[ "${1:-}" == "-v" ]]; then
    printf '%s\n' "10.8.2"
fi
exit 0
EOF
printf '%s\n' '#!/bin/bash' 'exit 0' > "$dest/bin/npx"
chmod +x "$dest/bin/node" "$dest/bin/npm" "$dest/bin/npx"
TARSTUB

cat > "$TMP/fixtures/uv" << 'EOF'
#!/bin/bash
printf 'uv %s\n' "$*" >> "${CAST_INSTALL_LOG:?}"
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "uv 0.5.0"
    exit 0
fi
if [[ "${1:-}" == "python" && "${2:-}" == "install" ]]; then
    mkdir -p "$HOME/.local/py/bin"
    cat > "$HOME/.local/py/bin/python3" << 'PY'
#!/bin/bash
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "Python 3.12.0"
    exit 0
fi
if [[ "${1:-}" == "-c" ]]; then
    exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "ensurepip" ]]; then
    exit 0
fi
exit 0
PY
    chmod +x "$HOME/.local/py/bin/python3"
    exit 0
fi
if [[ "${1:-}" == "python" && "${2:-}" == "find" ]]; then
    printf '%s\n' "$HOME/.local/py/bin/python3"
    exit 0
fi
if [[ "${1:-}" == "venv" ]]; then
    mkdir -p .venv
    printf '%s\n' KEEP > .venv/KEEP
    exit 0
fi
if [[ "${1:-}" == "pip" ]]; then
    exit 0
fi
if [[ "${1:-}" == "run" ]]; then
    exit 1
fi
exit 0
EOF

cat > "$TMP/stubs/unzip" << 'EOF'
#!/bin/bash
dest="."
file=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -d)
            dest="$2"
            shift 2
            ;;
        -*)
            shift
            ;;
        *)
            file="$1"
            shift
            ;;
    esac
done
name="$(cat "$file")"
mkdir -p "$dest/$name"
printf '%s\n' '#!/bin/bash' 'printf "%s\n" "1.1.0"' > "$dest/$name/bun"
chmod +x "$dest/$name/bun"
printf 'unzip-extract %s\n' "$file" >> "${CAST_INSTALL_LOG:?}"
EOF

cat > "$TMP/stubs/sudo" << 'EOF'
#!/bin/bash
printf 'sudo %s\n' "$*" >> "${CAST_INSTALL_LOG:?}"
"$@"
EOF

cat > "$TMP/stubs/apt-get" << 'EOF'
#!/bin/bash
printf 'apt-get %s\n' "$*" >> "${CAST_INSTALL_LOG:?}"
if [[ "$*" == *python3-pip* && -n "${CAST_PYTHON_VENV_READY:-}" ]]; then
    touch "$CAST_PYTHON_VENV_READY"
    mkdir -p "$HOME/.local/bin"
    printf '%s\n' '#!/bin/bash' 'printf "%s\n" "pip 24.0 from apt"' > "$HOME/.local/bin/pip3"
    chmod +x "$HOME/.local/bin/pip3"
fi
exit 0
EOF

cat > "$TMP/stubs/pkg-config" << 'EOF'
#!/bin/bash
# A developer machine may already have libsecret. Report it missing so the
# install test always exercises the package-install path.
exit 1
EOF

cat > "$TMP/stubs/brew" << 'EOF'
#!/bin/bash
printf 'brew %s\n' "$*" >> "${CAST_INSTALL_LOG:?}"
touch "${CAST_GIT_READY:?}"
exit 0
EOF

cat > "$TMP/tools/node" << 'EOF'
#!/bin/bash
if [[ "${1:-}" == "-v" ]]; then
    printf '%s\n' "v20.19.0"
fi
exit 0
EOF

cat > "$TMP/tools/npm" << 'EOF'
#!/bin/bash
printf 'npm %s %s\n' "$(pwd)" "$*" >> "${CAST_INSTALL_LOG:?}"
if [[ "${1:-}" == "-v" ]]; then
    printf '%s\n' "10.8.2"
fi
exit 0
EOF

cat > "$TMP/tools/python3" << 'EOF'
#!/bin/bash
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "Python 3.12.0"
    exit 0
fi
if [[ "${1:-}" == "-c" ]]; then
    exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then
    dest="${3:-.venv}"
    mkdir -p "$dest/bin"
    printf '%s\n' '#!/bin/bash' 'exit 0' > "$dest/bin/python"
    chmod +x "$dest/bin/python"
    cat > "$dest/bin/pip" << 'PIP'
#!/bin/bash
printf 'pip %s %s\n' "$(pwd)" "$*" >> "${CAST_INSTALL_LOG:?}"
exit 0
PIP
    chmod +x "$dest/bin/pip"
    cat > "$dest/bin/activate" << 'ACT'
export PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd):$PATH"
ACT
    exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "ensurepip" ]]; then
    exit 0
fi
exit 0
EOF

cat > "$TMP/tools/pip3" << 'EOF'
#!/bin/bash
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "pip 24.0 from stub"
fi
exit 0
EOF

cat > "$TMP/tools/bun" << 'EOF'
#!/bin/bash
printf '%s\n' "1.1.0"
exit 0
EOF

mkdir -p "$TMP/py-ok"
cp "$TMP/tools/python3" "$TMP/py-ok/python3"
chmod +x "$TMP/stubs/"* "$TMP/tools/"* "$TMP/py-ok/python3" "$TMP/fixtures/uv"

SYSTEM_CAST_BEFORE=""
if [[ -L /usr/local/bin/cast || -e /usr/local/bin/cast ]]; then
    SYSTEM_CAST_BEFORE="$(readlink /usr/local/bin/cast || printf 'file')"
fi

reset_log() {
    : > "$CAST_INSTALL_LOG"
}

seed_checkout() {
    local repo="$1"
    mkdir -p "$repo/typescript/cast-cli/bin" "$repo/typescript/cast-tui" "$repo/python" "$repo/.git"
    printf '%s\n' '#!/bin/bash' 'echo cast-cli' > "$repo/typescript/cast-cli/bin/run"
    chmod +x "$repo/typescript/cast-cli/bin/run"
    printf '%s\n' '{"name":"cast-cli"}' > "$repo/typescript/cast-cli/package.json"
    printf '%s\n' '{"name":"cast-tui"}' > "$repo/typescript/cast-tui/package.json"
    printf '%s\n' '[project]' 'name = "cast"' > "$repo/python/pyproject.toml"
    printf '%s\n' '{"name":"castagent"}' > "$repo/package.json"
    cp "$SCRIPT_SRC" "$repo/install.sh"
    chmod +x "$repo/install.sh"
}

run_piped() {
    local home="$1"
    local out="$2"
    mkdir -p "$home"
    set +e
    (
        cd "$TMP/work"
        HOME="$home" bash -c 'cat "$1" | bash' _ "$SCRIPT_SRC" >"$out" 2>&1
    )
    RUN_STATUS=$?
    set -e
}

run_file() {
    local home="$1"
    local script="$2"
    local out="$3"
    mkdir -p "$home"
    set +e
    (
        cd "$TMP/work"
        HOME="$home" bash "$script" >"$out" 2>&1
    )
    RUN_STATUS=$?
    set -e
}

sha256_bytes() {
    printf '%s' "$1" | sha256sum | awk '{print $1}'
}

NODE_SHA="$(sha256_bytes node-bytes)"
UV_SHA="$(sha256_bytes uv-bytes)"
cat > "$TMP/fixtures/checksums.txt" << EOF
node 20.20.2 linux-x64 ${NODE_SHA}
node 20.20.2 linux-arm64 ${NODE_SHA}
node 20.20.2 darwin-x64 ${NODE_SHA}
node 20.20.2 darwin-arm64 ${NODE_SHA}
uv 0.13.1 linux-x64 ${UV_SHA}
uv 0.13.1 linux-arm64 ${UV_SHA}
uv 0.13.1 linux-musl-x64 ${UV_SHA}
uv 0.13.1 linux-musl-arm64 ${UV_SHA}
uv 0.13.1 darwin-x64 ${UV_SHA}
uv 0.13.1 darwin-arm64 ${UV_SHA}
bun 1.4.3 linux-x64 $(sha256_bytes bun-linux-x64)
bun 1.4.3 linux-arm64 $(sha256_bytes bun-linux-aarch64)
bun 1.4.3 darwin-x64 $(sha256_bytes bun-darwin-x64)
bun 1.4.3 darwin-arm64 $(sha256_bytes bun-darwin-aarch64)
EOF
export CAST_INSTALL_TEST_CHECKSUMS="$TMP/fixtures/checksums.txt"

assert_not_contains "$SCRIPT_SRC" "raw.githubusercontent.com/scott/castagent/main/install.sh" "installer does not fetch install.sh from main"
assert_not_contains "$SCRIPT_SRC" "https://astral.sh/uv/install.sh" "installer does not run the uv shell script"
assert_not_contains "$SCRIPT_SRC" "https://bun.sh/install" "installer does not run the bun shell script"
assert_not_contains "$SCRIPT_SRC" "https://nodejs.org/dist/latest-" "installer does not follow the floating Node channel"
grep -F -q 'node 20.20.2 linux-x64 19e56f0825510207dd904f087fe52faa0a4eb6b2aab5f0ea7a33830d04888b8b' "$SOURCE_ROOT/install-checksums.txt" \
    || fail "published node linux-x64 pin drifted"
grep -F -q 'uv 0.13.1 linux-x64 eadd9d27c134ab5ac1ffd4473b97a741407f3ea238288f03121fc4deddf90220' "$SOURCE_ROOT/install-checksums.txt" \
    || fail "published uv linux-x64 pin drifted"
grep -F -q 'bun 1.4.3 linux-x64 3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18' "$SOURCE_ROOT/install-checksums.txt" \
    || fail "published bun linux-x64 pin drifted"
grep -F -q 'docker-apt-key 1 ubuntu 1500c1f56fa9e26b9b8f42452a553675796ade0807cdce11975eb98170b3a570' "$SOURCE_ROOT/install-checksums.txt" \
    || fail "published docker apt key pin drifted"

extract_armored_key() {
    awk 'BEGIN {p=0} /-----BEGIN PGP PUBLIC KEY BLOCK-----/ {p=1} p {print} /-----END PGP PUBLIC KEY BLOCK-----/ {exit}' "$1"
}
extract_armored_key "$SCRIPT_SRC" > "$TMP/key-install.asc"
extract_armored_key "$SOURCE_ROOT/upgrade.sh" > "$TMP/key-upgrade.asc"
diff -q "$SOURCE_ROOT/scripts/trusted-commit-key.asc" "$TMP/key-install.asc" >/dev/null \
    || fail "install.sh trusted key does not match scripts/trusted-commit-key.asc"
diff -q "$SOURCE_ROOT/scripts/trusted-commit-key.asc" "$TMP/key-upgrade.asc" >/dev/null \
    || fail "upgrade.sh trusted key does not match scripts/trusted-commit-key.asc"

touch "$CAST_GIT_READY"
reset_log
LINUX_HOME="$TMP/linux-home"
run_piped "$LINUX_HOME" "$TMP/linux.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/linux.out" >&2; fail "linux one-liner failed ($RUN_STATUS)"; }
CLONE="$LINUX_HOME/.cast/castagent"
assert_contains "$CAST_INSTALL_LOG" "git clone --branch main --depth 1 https://github.com/scott/castagent.git $CLONE" "one-liner clones the pinned ref"
assert_contains "$CAST_INSTALL_LOG" "git -C $CLONE -c gpg.format=openpgp verify-commit HEAD" "one-liner verifies the commit signature"
assert_not_contains "$CAST_INSTALL_LOG" "raw.githubusercontent.com" "one-liner does not download install.sh again"
assert_contains "$CAST_INSTALL_LOG" "apt-get install -y git curl ca-certificates tar unzip build-essential pkg-config libsecret-1-dev" "linux installs build packages"
assert_contains "$CAST_INSTALL_LOG" "curl https://nodejs.org/dist/v20.20.2/node-v20.20.2-linux-x64.tar.gz" "node tarball is pinned"
assert_contains "$TMP/linux.out" "Downloading node-v20.20.2-linux-x64.tar.gz" "linux downloads the x64 tarball"
assert_contains "$TMP/linux.out" "Verified SHA-256 for node 20.20.2 linux-x64" "node tarball is checked before unpack"
assert_contains "$CAST_INSTALL_LOG" "curl https://github.com/astral-sh/uv/releases/download/0.13.1/uv-x86_64-unknown-linux-gnu.tar.gz" "uv archive is pinned"
assert_contains "$TMP/linux.out" "Verified SHA-256 for uv 0.13.1 linux-x64" "uv archive is checked before unpack"
assert_contains "$CAST_INSTALL_LOG" "uv python install 3.12" "python 3.12 is installed"
assert_contains "$CAST_INSTALL_LOG" "curl https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-linux-x64.zip" "bun archive is pinned"
assert_contains "$TMP/linux.out" "Verified SHA-256 for bun 1.4.3 linux-x64" "bun archive is checked before unpack"
assert_not_contains "$CAST_INSTALL_LOG" "astral.sh/uv/install.sh" "uv installer script is not executed"
assert_not_contains "$CAST_INSTALL_LOG" "bun.sh/install" "bun installer script is not executed"
assert_contains "$CAST_INSTALL_LOG" "npm $CLONE install" "root npm install runs in the clone"
assert_contains "$CAST_INSTALL_LOG" "npm $CLONE/typescript/cast-cli run build" "cli build runs in the clone"
assert_eq "$(readlink "$LINUX_HOME/.local/bin/cast")" "$CLONE/cast" "cast links at the checkout"
assert_eq "$(readlink "$LINUX_HOME/.local/bin/python3")" "$LINUX_HOME/.local/py/bin/python3" "python3 links at the uv runtime"
[[ -x "$LINUX_HOME/.bun/bin/bun" ]] || fail "bun binary should exist"
assert_contains "$LINUX_HOME/.bashrc" "castagent-path" "bash profile gains a PATH line"
assert_not_contains "$CAST_INSTALL_LOG" "npm $SOURCE_ROOT" "install does not build this workspace"
assert_install_hints "$TMP/linux.out"
assert_eq "$(stat -c %a "$LINUX_HOME/.cast")" "700" "cast home is created mode 700"
assert_eq "$(stat -c %a "$LINUX_HOME/.cast/tokens")" "700" "token directory is created mode 700"
assert_eq "$(stat -c %a "$LINUX_HOME/.cast/sessions")" "700" "session directory is created mode 700"

chmod 755 "$LINUX_HOME/.cast" "$LINUX_HOME/.cast/tokens" "$LINUX_HOME/.cast/sessions"
install_umask="$(umask)"
umask 022
reset_log
run_piped "$LINUX_HOME" "$TMP/linux-again.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/linux-again.out" >&2; fail "second one-liner failed ($RUN_STATUS)"; }
assert_contains "$TMP/linux-again.out" "Using existing checkout: $CLONE" "second run reuses the checkout"
assert_not_contains "$CAST_INSTALL_LOG" "git clone" "second run does not clone again"
assert_eq "$(stat -c %a "$LINUX_HOME/.cast")" "700" "second run tightens cast home to mode 700"
assert_eq "$(stat -c %a "$LINUX_HOME/.cast/tokens")" "700" "second run tightens the token directory to mode 700"
assert_eq "$(stat -c %a "$LINUX_HOME/.cast/sessions")" "700" "second run tightens the session directory to mode 700"
umask "$install_umask"

OCC_HOME="$TMP/occupied-home"
mkdir -p "$OCC_HOME/.cast/castagent"
printf '%s\n' keep > "$OCC_HOME/.cast/castagent/keep"
reset_log
run_piped "$OCC_HOME" "$TMP/occupied.out"
[[ "$RUN_STATUS" -ne 0 ]] || fail "a non-checkout clone path should fail"
assert_contains "$TMP/occupied.out" "$OCC_HOME/.cast/castagent exists and is not a Cast checkout." "occupied path explains itself"
assert_eq "$(cat "$OCC_HOME/.cast/castagent/keep")" "keep" "occupied path is left in place"
assert_not_contains "$CAST_INSTALL_LOG" "git clone" "occupied path is not cloned over"

mkdir -p "$TMP/ubuntu-bin"
export CAST_PYTHON_VENV_READY="$TMP/ubuntu-venv-ready"
rm -f "$CAST_PYTHON_VENV_READY"
cat > "$TMP/ubuntu-bin/python3" << 'EOF'
#!/bin/bash
if [[ "${1:-}" == "--version" ]]; then
    printf '%s\n' "Python 3.12.3"
    exit 0
fi
if [[ "${1:-}" == "-c" ]]; then
    exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "venv" ]]; then
    if [[ ! -f "${CAST_PYTHON_VENV_READY:?}" ]]; then
        printf '%s\n' "ensurepip is disabled in Debian/Ubuntu for the system python." >&2
        exit 1
    fi
    dest="${3:-.venv}"
    mkdir -p "$dest/bin"
    printf '%s\n' '#!/bin/bash' 'exit 0' > "$dest/bin/python"
    chmod +x "$dest/bin/python"
    printf '%s\n' '#!/bin/bash' 'exit 0' > "$dest/bin/pip"
    chmod +x "$dest/bin/pip"
    printf '%s\n' 'export PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd):$PATH"' > "$dest/bin/activate"
    exit 0
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "ensurepip" ]]; then
    printf '%s\n' "ensurepip is disabled in Debian/Ubuntu for the system python." >&2
    exit 1
fi
if [[ "${1:-}" == "-m" && "${2:-}" == "pip" ]]; then
    [[ -f "${CAST_PYTHON_VENV_READY:?}" ]]
    exit $?
fi
exit 1
EOF
chmod +x "$TMP/ubuntu-bin/python3"
UBUNTU_HOME="$TMP/ubuntu-home"
UBUNTU_REPO="$TMP/ubuntu-repo"
seed_checkout "$UBUNTU_REPO"
reset_log
PATH="$TMP/ubuntu-bin:$TMP/tools:$TMP/stubs:/usr/bin:/bin"
export PATH
run_file "$UBUNTU_HOME" "$UBUNTU_REPO/install.sh" "$TMP/ubuntu.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/ubuntu.out" >&2; fail "Ubuntu system Python install failed ($RUN_STATUS)"; }
assert_contains "$CAST_INSTALL_LOG" "apt-get install -y python3-venv python3-pip" "Ubuntu installs the distro venv and pip"
assert_not_contains "$TMP/ubuntu.out" "Failed to install pip" "Ubuntu does not stop on disabled ensurepip"
assert_not_contains "$CAST_INSTALL_LOG" "astral.sh" "a usable system Python does not install uv"
assert_contains "$CAST_INSTALL_LOG" "npm $UBUNTU_REPO install" "Ubuntu install builds the checkout"
PATH="$TMP/stubs:/usr/bin:/bin"
export PATH
unset CAST_PYTHON_VENV_READY

export CAST_UNAME_S=Darwin
export CAST_UNAME_M=arm64
rm -f "$CAST_GIT_READY"
BREW_HOME="$TMP/brew-home"
reset_log
# Debian's /usr/bin/python3 cannot create a venv. Give the Darwin run a
# working interpreter so it does not fall through to apt-get.
PATH="$TMP/py-ok:$TMP/stubs:/usr/bin:/bin"
export PATH
run_piped "$BREW_HOME" "$TMP/brew.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/brew.out" >&2; fail "macOS one-liner failed ($RUN_STATUS)"; }
assert_contains "$CAST_INSTALL_LOG" "brew install git" "macOS installs git with Homebrew"
assert_contains "$TMP/brew.out" "Downloading node-v20.20.2-darwin-arm64.tar.gz" "macOS downloads the arm64 tarball"
assert_contains "$CAST_INSTALL_LOG" "curl https://github.com/oven-sh/bun/releases/download/bun-v1.4.3/bun-darwin-aarch64.zip" "macOS bun archive is pinned"
assert_not_contains "$CAST_INSTALL_LOG" "apt-get " "macOS does not use apt"
assert_contains "$BREW_HOME/.zshrc" "castagent-path" "zsh profile gains a PATH line"
assert_eq "$(readlink "$BREW_HOME/.local/bin/cast")" "$BREW_HOME/.cast/castagent/cast" "macOS links cast"

mv "$TMP/stubs/brew" "$TMP/brew-held"
rm -f "$CAST_GIT_READY"
NOGIT_HOME="$TMP/nogit-home"
reset_log
run_piped "$NOGIT_HOME" "$TMP/nogit.out"
[[ "$RUN_STATUS" -ne 0 ]] || fail "macOS without git or Homebrew should fail"
assert_contains "$TMP/nogit.out" "Install the Xcode command line tools or Homebrew" "macOS explains how to get git"
assert_not_contains "$CAST_INSTALL_LOG" "git clone" "macOS without git does not clone"
mv "$TMP/brew-held" "$TMP/stubs/brew"

touch "$CAST_GIT_READY"
FILE_HOME="$TMP/file-home"
FILE_REPO="$TMP/file-repo"
seed_checkout "$FILE_REPO"
reset_log
PATH="$TMP/tools:$TMP/stubs:/usr/bin:/bin"
export PATH
run_file "$FILE_HOME" "$FILE_REPO/install.sh" "$TMP/file.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/file.out" >&2; fail "checkout install failed ($RUN_STATUS)"; }
assert_not_contains "$CAST_INSTALL_LOG" "git clone" "a checkout install does not clone"
assert_not_contains "$CAST_INSTALL_LOG" "nodejs.org" "an existing Node.js is reused"
assert_not_contains "$CAST_INSTALL_LOG" "astral.sh" "an existing Python is reused"
assert_contains "$CAST_INSTALL_LOG" "npm $FILE_REPO install" "checkout install builds that repo"
assert_eq "$(readlink "$FILE_HOME/.local/bin/cast")" "$FILE_REPO/cast" "checkout install links its own cast"
[[ ! -e "$FILE_HOME/.cast/castagent" ]] || fail "checkout install should not create the default clone"
assert_install_hints "$TMP/file.out"

if [[ -L /usr/local/bin/cast || -e /usr/local/bin/cast ]]; then
    system_cast_after="$(readlink /usr/local/bin/cast || printf 'file')"
    assert_eq "$system_cast_after" "$SYSTEM_CAST_BEFORE" "/usr/local/bin/cast outside the test home is left alone"
elif [[ -e /usr/local/bin/cast ]]; then
    fail "/usr/local/bin/cast was created by the tests"
fi

export CAST_UNAME_S=Linux
export CAST_UNAME_M=x86_64
PATH="$TMP/stubs:/usr/bin:/bin"
export PATH

BAD_NODE="$TMP/fixtures/checksums-bad-node.txt"
sed -E 's/^(node [^ ]+ [^ ]+) [0-9a-f]{64}$/\1 0000000000000000000000000000000000000000000000000000000000000000/' \
    "$TMP/fixtures/checksums.txt" > "$BAD_NODE"
export CAST_INSTALL_TEST_CHECKSUMS="$BAD_NODE"
BAD_NODE_HOME="$TMP/bad-node-home"
reset_log
run_piped "$BAD_NODE_HOME" "$TMP/bad-node.out"
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/bad-node.out" >&2; fail "a bad node checksum should fail"; }
assert_contains "$TMP/bad-node.out" "Checksum mismatch for node 20.20.2 linux-x64." "bad node bytes are rejected"
assert_not_contains "$CAST_INSTALL_LOG" "tar-extract " "a bad node archive is not unpacked"
assert_not_contains "$CAST_INSTALL_LOG" "npm " "a bad node archive does not reach npm"
[[ ! -e "$BAD_NODE_HOME/.local/node" ]] || fail "a bad node archive must not replace the node prefix"

BAD_BUN="$TMP/fixtures/checksums-bad-bun.txt"
sed -E 's/^(bun [^ ]+ [^ ]+) [0-9a-f]{64}$/\1 1111111111111111111111111111111111111111111111111111111111111111/' \
    "$TMP/fixtures/checksums.txt" > "$BAD_BUN"
export CAST_INSTALL_TEST_CHECKSUMS="$BAD_BUN"
BAD_BUN_HOME="$TMP/bad-bun-home"
reset_log
run_piped "$BAD_BUN_HOME" "$TMP/bad-bun.out"
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/bad-bun.out" >&2; fail "a bad bun checksum should fail"; }
assert_contains "$TMP/bad-bun.out" "Checksum mismatch for bun 1.4.3 linux-x64." "bad bun bytes are rejected"
assert_not_contains "$CAST_INSTALL_LOG" "unzip-extract " "a bad bun archive is not unpacked"
assert_not_contains "$CAST_INSTALL_LOG" "npm " "a bad bun archive does not reach npm"
[[ ! -e "$BAD_BUN_HOME/.bun/bin/bun" ]] || fail "a bad bun archive must not install bun"

export CAST_INSTALL_TEST_CHECKSUMS="$TMP/fixtures/checksums.txt"
OLD_HOME="$TMP/old-installer-home"
OLD_REPO="$OLD_HOME/.cast/castagent"
mkdir -p "$OLD_REPO/typescript/cast-cli/bin" "$OLD_REPO/typescript/cast-tui" "$OLD_REPO/python" "$OLD_REPO/.git"
printf '%s\n' '#!/bin/bash' 'echo cast-cli' > "$OLD_REPO/typescript/cast-cli/bin/run"
chmod +x "$OLD_REPO/typescript/cast-cli/bin/run"
printf '%s\n' '{"name":"cast-tui"}' > "$OLD_REPO/typescript/cast-tui/package.json"
printf '%s\n' '[project]' 'name = "cast"' > "$OLD_REPO/python/pyproject.toml"
printf '%s\n' '#!/bin/bash' 'echo RAN_OLD_INSTALLER' 'exit 0' > "$OLD_REPO/install.sh"
chmod +x "$OLD_REPO/install.sh"
reset_log
run_piped "$OLD_HOME" "$TMP/old-installer.out"
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/old-installer.out" >&2; fail "an unpinned checkout installer should not be executed"; }
assert_not_contains "$TMP/old-installer.out" "RAN_OLD_INSTALLER" "the old installer is not executed"
assert_contains "$TMP/old-installer.out" "Existing checkout installer has no checksum pins." "the old installer is skipped"
assert_contains "$TMP/old-installer.out" "No install-checksums.txt next to this installer." "downloads without pins are refused"
assert_not_contains "$CAST_INSTALL_LOG" "raw.githubusercontent.com" "the old checkout is not replaced from main"
assert_not_contains "$CAST_INSTALL_LOG" "curl https://nodejs.org" "node is not downloaded without pins"

# Real git: an unsigned commit, and a commit signed by some other key, are
# both refused before the cloned install.sh runs.
mkdir -p "$TMP/realgit"
ln -sfn "$REAL_GIT" "$TMP/realgit/git"
SIG_PATH="$TMP/realgit:$TMP/stubs:/usr/bin:/bin"

write_signed_fixture() {
    local repo="$1"
    local mode="$2"
    mkdir -p "$repo/typescript/cast-cli/bin" "$repo/typescript/cast-tui" "$repo/python"
    printf '%s\n' '#!/bin/bash' 'echo cast-cli' > "$repo/typescript/cast-cli/bin/run"
    chmod +x "$repo/typescript/cast-cli/bin/run"
    printf '%s\n' '{"name":"cast-tui"}' > "$repo/typescript/cast-tui/package.json"
    printf '%s\n' '[project]' 'name = "cast"' > "$repo/python/pyproject.toml"
    cat > "$repo/install.sh" << 'EOF'
#!/bin/bash
require_sha256() { :; }
echo RAN_CLONED_INSTALLER
exit 0
EOF
    chmod +x "$repo/install.sh"
    printf '%s\n' 'node 1 linux-x64 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' > "$repo/install-checksums.txt"
    "$REAL_GIT" -C "$repo" init -q
    "$REAL_GIT" -C "$repo" config user.email install-test@example.com
    "$REAL_GIT" -C "$repo" config user.name "Install Test"
    "$REAL_GIT" -C "$repo" config gpg.format openpgp
    "$REAL_GIT" -C "$repo" config commit.gpgsign false
    "$REAL_GIT" -C "$repo" add .
    if [[ "$mode" == signed ]]; then
        "$REAL_GIT" -C "$repo" config user.signingkey "$CAST_TEST_FPR"
        "$REAL_GIT" -C "$repo" -c commit.gpgsign=true commit -qm "signed fixture"
    else
        "$REAL_GIT" -C "$repo" -c commit.gpgsign=false commit -qm "unsigned fixture"
    fi
    "$REAL_GIT" -C "$repo" tag v9.9.9
}

run_repo_install() {
    local home="$1"
    local repo="$2"
    local out="$3"
    mkdir -p "$home"
    set +e
    (
        cd "$TMP/work"
        PATH="$SIG_PATH" \
        HOME="$home" \
        CAST_INSTALL_REPO="$repo" \
        CAST_INSTALL_REF="v9.9.9" \
        bash -c 'cat "$1" | bash' _ "$SCRIPT_SRC" >"$out" 2>&1
    )
    RUN_STATUS=$?
    set -e
}

UNSIGNED_REPO="$TMP/unsigned-repo"
write_signed_fixture "$UNSIGNED_REPO" unsigned
reset_log
run_repo_install "$TMP/unsigned-home" "$UNSIGNED_REPO" "$TMP/unsigned-install.out"
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/unsigned-install.out" >&2; fail "unsigned clone should fail"; }
assert_contains "$TMP/unsigned-install.out" "The commit is not signed by the trusted key." "unsigned clone is refused"
assert_not_contains "$TMP/unsigned-install.out" "RAN_CLONED_INSTALLER" "unsigned install.sh is not executed"
assert_not_contains "$TMP/unsigned-install.out" "Cloned installer has no checksum pins." "refusal happens at the signature check"
assert_not_contains "$CAST_INSTALL_LOG" "curl https://nodejs.org" "unsigned clone does not download node"

CAST_TEST_GNUPGHOME="$TMP/gnupg"
mkdir -p "$CAST_TEST_GNUPGHOME"
chmod 700 "$CAST_TEST_GNUPGHOME"
GNUPGHOME="$CAST_TEST_GNUPGHOME" gpg --batch --pinentry-mode loopback --passphrase '' \
    --quick-gen-key "Cast Install Test <install-test@example.com>" ed25519 sign never >/dev/null
CAST_TEST_FPR="$(GNUPGHOME="$CAST_TEST_GNUPGHOME" gpg --with-colons --list-secret-keys | awk -F: '$1=="fpr" {print $10; exit}')"
OTHER_REPO="$TMP/otherkey-repo"
GNUPGHOME="$CAST_TEST_GNUPGHOME" write_signed_fixture "$OTHER_REPO" signed
reset_log
run_repo_install "$TMP/otherkey-home" "$OTHER_REPO" "$TMP/otherkey-install.out"
[[ "$RUN_STATUS" -ne 0 ]] || { cat "$TMP/otherkey-install.out" >&2; fail "a commit signed by another key should fail"; }
assert_contains "$TMP/otherkey-install.out" "The commit is not signed by the trusted key." "another signing key is refused"
assert_not_contains "$TMP/otherkey-install.out" "RAN_CLONED_INSTALLER" "another key's install.sh is not executed"

printf 'ok\n'
