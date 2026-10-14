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
if [[ "$url" == *SHASUMS256.txt ]]; then
    printf '%s\n' "0123456789abcdef  node-v20.19.0-linux-x64.tar.gz"
    exit 0
fi
if [[ "$url" == *nodejs.org* ]]; then
    printf 'tarball\n' > "$out"
    exit 0
fi
if [[ "$url" == *astral.sh/uv/install.sh ]]; then
    cat > "$out" << 'EOS'
#!/bin/sh
bindir="${UV_UNMANAGED_INSTALL:-$HOME/.local/bin}"
mkdir -p "$bindir"
cp "$CAST_UV_STUB" "$bindir/uv"
chmod +x "$bindir/uv"
EOS
    exit 0
fi
if [[ "$url" == *bun.sh/install ]]; then
    cat > "$out" << 'EOS'
#!/bin/bash
mkdir -p "$HOME/.bun/bin"
printf '%s\n' '#!/bin/bash' 'printf "%s\n" "1.1.0"' > "$HOME/.bun/bin/bun"
chmod +x "$HOME/.bun/bin/bun"
EOS
    exit 0
fi
if [[ "$url" == *install.sh ]]; then
    cp "${CAST_INSTALL_TEST_SCRIPT:?}" "$out"
    chmod +x "$out"
    exit 0
fi
printf 'unexpected curl %s\n' "$url" >&2
exit 1
EOF

cat > "$TMP/stubs/tar" << 'TARSTUB'
#!/bin/bash
dest=""
while [[ $# -gt 0 ]]; do
    case "$1" in
        -C)
            dest="$2"
            shift 2
            ;;
        *)
            shift
            ;;
    esac
done
if [[ -z "$dest" ]]; then
    printf 'tar stub missing -C\n' >&2
    exit 1
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

cat > "$TMP/stubs/sudo" << 'EOF'
#!/bin/bash
printf 'sudo %s\n' "$*" >> "${CAST_INSTALL_LOG:?}"
"$@"
EOF

cat > "$TMP/stubs/apt-get" << 'EOF'
#!/bin/bash
printf 'apt-get %s\n' "$*" >> "${CAST_INSTALL_LOG:?}"
if [[ "$*" == *unzip* ]]; then
    mkdir -p "$HOME/.local/bin"
    printf '%s\n' '#!/bin/bash' 'exit 0' > "$HOME/.local/bin/unzip"
    chmod +x "$HOME/.local/bin/unzip"
fi
if [[ "$*" == *python3-pip* && -n "${CAST_PYTHON_VENV_READY:-}" ]]; then
    touch "$CAST_PYTHON_VENV_READY"
    mkdir -p "$HOME/.local/bin"
    printf '%s\n' '#!/bin/bash' 'printf "%s\n" "pip 24.0 from apt"' > "$HOME/.local/bin/pip3"
    chmod +x "$HOME/.local/bin/pip3"
fi
exit 0
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

chmod +x "$TMP/stubs/"* "$TMP/tools/"* "$TMP/fixtures/uv"

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

touch "$CAST_GIT_READY"
reset_log
LINUX_HOME="$TMP/linux-home"
run_piped "$LINUX_HOME" "$TMP/linux.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/linux.out" >&2; fail "linux one-liner failed ($RUN_STATUS)"; }
CLONE="$LINUX_HOME/.cast/castagent"
assert_contains "$CAST_INSTALL_LOG" "git clone --branch main https://github.com/scott/castagent.git $CLONE" "one-liner clones main"
assert_contains "$CAST_INSTALL_LOG" "apt-get install -y git curl ca-certificates tar unzip build-essential pkg-config libsecret-1-dev" "linux installs build packages"
assert_contains "$CAST_INSTALL_LOG" "curl https://nodejs.org/dist/latest-v20.x/SHASUMS256.txt" "node version is resolved"
assert_contains "$TMP/linux.out" "Downloading node-v20.19.0-linux-x64.tar.gz" "linux downloads the x64 tarball"
assert_contains "$CAST_INSTALL_LOG" "curl https://astral.sh/uv/install.sh" "python comes from uv"
assert_contains "$CAST_INSTALL_LOG" "uv python install 3.12" "python 3.12 is installed"
assert_contains "$CAST_INSTALL_LOG" "curl https://bun.sh/install" "bun is installed"
assert_contains "$CAST_INSTALL_LOG" "npm $CLONE install" "root npm install runs in the clone"
assert_contains "$CAST_INSTALL_LOG" "npm $CLONE/typescript/cast-cli run build" "cli build runs in the clone"
assert_eq "$(readlink "$LINUX_HOME/.local/bin/cast")" "$CLONE/cast" "cast links at the checkout"
assert_eq "$(readlink "$LINUX_HOME/.local/bin/python3")" "$LINUX_HOME/.local/py/bin/python3" "python3 links at the uv runtime"
[[ -x "$LINUX_HOME/.bun/bin/bun" ]] || fail "bun binary should exist"
assert_contains "$LINUX_HOME/.bashrc" "castagent-path" "bash profile gains a PATH line"
assert_not_contains "$CAST_INSTALL_LOG" "npm $SOURCE_ROOT" "install does not build this workspace"
assert_install_hints "$TMP/linux.out"

reset_log
run_piped "$LINUX_HOME" "$TMP/linux-again.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/linux-again.out" >&2; fail "second one-liner failed ($RUN_STATUS)"; }
assert_contains "$TMP/linux-again.out" "Using existing checkout: $CLONE" "second run reuses the checkout"
assert_not_contains "$CAST_INSTALL_LOG" "git clone" "second run does not clone again"

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
run_piped "$BREW_HOME" "$TMP/brew.out"
[[ "$RUN_STATUS" -eq 0 ]] || { cat "$TMP/brew.out" >&2; fail "macOS one-liner failed ($RUN_STATUS)"; }
assert_contains "$CAST_INSTALL_LOG" "brew install git" "macOS installs git with Homebrew"
assert_contains "$TMP/brew.out" "Downloading node-v20.19.0-darwin-arm64.tar.gz" "macOS downloads the arm64 tarball"
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

# REAL_GIT is unused on purpose: the stub must hide the developer git.
: "$REAL_GIT"

printf 'ok\n'
