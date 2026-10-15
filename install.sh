#!/bin/bash

# One compound command so `curl | bash` reads the whole script before any
# child process can consume unread stdin.
set -e
{

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Checkout that this run builds. prepare_checkout sets it. A piped one-liner
# has no script path, so that function clones the pinned ref into
# ~/.cast/castagent, checks the commit signature, and execs install.sh
# from that checkout.
SCRIPT_DIR=""
PROJECT_NAME="Cast"
export GIT_TERMINAL_PROMPT=0

PATH_HAD_LOCAL_BIN=0
case ":${PATH:-}:" in
    *":$HOME/.local/bin:"*) PATH_HAD_LOCAL_BIN=1 ;;
esac

# Helper functions
log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

check_command() {
    if command -v "$1" &> /dev/null; then
        return 0
    else
        return 1
    fi
}

get_node_version() {
    node -v | sed 's/v//'
}

get_python_version() {
    python3 --version | awk '{print $2}'
}

compare_versions() {
    # Returns 0 if $1 >= $2
    if [ "$(printf '%s\n' "$1" "$2" | sort -V | head -n1)" = "$2" ]; then
        return 0
    else
        return 1
    fi
}

is_cast_checkout() {
    local dir="$1"
    [ -n "$dir" ] || return 1
    [ -f "$dir/typescript/cast-cli/bin/run" ] || return 1
    [ -f "$dir/typescript/cast-tui/package.json" ] || return 1
    [ -f "$dir/python/pyproject.toml" ] || return 1
    git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
    return 0
}

find_checkout() {
    local source dir

    source="${BASH_SOURCE[0]:-}"
    if [ -n "$source" ] && [ "$source" != bash ] && [ -f "$source" ]; then
        dir="$(cd "$(dirname "$source")" && pwd)" || true
        if is_cast_checkout "$dir"; then
            printf '%s\n' "$dir"
            return 0
        fi
    fi

    dir="$(pwd)"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
        if is_cast_checkout "$dir"; then
            printf '%s\n' "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

run_root() {
    if [ "$(id -u)" -eq 0 ]; then
        "$@" </dev/null
    elif check_command sudo; then
        sudo "$@" </dev/null
    else
        log_error "Root is required to install system packages."
        exit 1
    fi
}

linux_build_ready() {
    check_command git || return 1
    check_command curl || return 1
    check_command tar || return 1
    check_command unzip || return 1
    check_command gcc || return 1
    check_command gpg || return 1
    check_command pkg-config || return 1
    pkg-config --exists libsecret-1 >/dev/null 2>&1 || return 1
    return 0
}

ensure_system_packages() {
    if [ "${CAST_INSTALL_PACKAGES_DONE:-}" = 1 ]; then
        return 0
    fi
    case "$(uname -s)" in
        Linux)
            if linux_build_ready; then
                export CAST_INSTALL_PACKAGES_DONE=1
                return 0
            fi
            log_info "Installing system packages..."
            if check_command apt-get; then
                run_root env DEBIAN_FRONTEND=noninteractive apt-get update
                run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y \
                    git curl ca-certificates tar unzip build-essential pkg-config libsecret-1-dev gnupg
            elif check_command dnf; then
                run_root dnf install -y git curl ca-certificates tar unzip gcc gcc-c++ make pkgconf-pkg-config libsecret-devel gnupg2
            elif check_command yum; then
                run_root yum install -y git curl ca-certificates tar unzip gcc gcc-c++ make pkgconfig libsecret-devel gnupg2
            elif check_command pacman; then
                run_root pacman -Sy --noconfirm git curl ca-certificates tar unzip base-devel pkgconf libsecret gnupg
            elif check_command apk; then
                run_root apk add git curl ca-certificates tar unzip build-base pkgconfig libsecret-dev gnupg
            else
                log_error "No supported package manager found."
                log_info "Install git, curl, tar, unzip, a C compiler, libsecret, and gnupg, then run this script again."
                exit 1
            fi
            ;;
        Darwin)
            if ! check_command gpg && check_command brew; then
                log_info "Installing gnupg..."
                brew install gnupg </dev/null
            fi
            ;;
        *)
            log_error "Unsupported operating system: $(uname -s)"
            exit 1
            ;;
    esac
    export CAST_INSTALL_PACKAGES_DONE=1
}

git_works() {
    check_command git || return 1
    git --version >/dev/null 2>&1 || return 1
    return 0
}

ensure_git() {
    if git_works; then
        return 0
    fi
    if [ "$(uname -s)" = Darwin ] && check_command brew; then
        log_info "Installing git..."
        brew install git </dev/null
    fi
    if git_works; then
        return 0
    fi
    log_error "git is not installed."
    if [ "$(uname -s)" = Darwin ]; then
        log_info "Install the Xcode command line tools or Homebrew, then run this script again."
    else
        log_info "Install git, then run this script again."
    fi
    exit 1
}

publish_bin() {
    local name="$1"
    local target="$2"

    mkdir -p "$HOME/.local/bin"
    ln -sfn "$target" "$HOME/.local/bin/$name"
    if [ "${CAST_INSTALL_SKIP_SYSTEM_BIN:-}" != 1 ] && [ -w /usr/local/bin ]; then
        ln -sfn "$target" "/usr/local/bin/$name"
    fi
}

export_tool_path() {
    export PATH="$HOME/.local/node/bin:$HOME/.local/bin:$HOME/.bun/bin:${PATH:-}"
    hash -r 2>/dev/null || true
}

node_ok() {
    check_command node || return 1
    check_command npm || return 1
    compare_versions "$(get_node_version)" "18.0.0"
}

checksums_path() {
    local source dir

    source="${BASH_SOURCE[0]:-}"
    if [ -n "$source" ] && [ "$source" != bash ] && [ -f "$source" ]; then
        dir="$(cd "$(dirname "$source")" && pwd)" || true
        if [ -f "$dir/install-checksums.txt" ]; then
            printf '%s\n' "$dir/install-checksums.txt"
            return 0
        fi
    fi
    if [ -n "${SCRIPT_DIR:-}" ] && [ -f "$SCRIPT_DIR/install-checksums.txt" ]; then
        printf '%s\n' "$SCRIPT_DIR/install-checksums.txt"
        return 0
    fi
    return 1
}

pin_version() {
    local file="$1"
    local name="$2"

    awk -v n="$name" '
        $0 ~ /^[[:space:]]*#/ { next }
        $0 ~ /^[[:space:]]*$/ { next }
        $1 == n { print $2; exit }
    ' "$file"
}

pin_value() {
    local file="$1"
    local name="$2"
    local target="$3"

    awk -v n="$name" -v t="$target" '
        $0 ~ /^[[:space:]]*#/ { next }
        $0 ~ /^[[:space:]]*$/ { next }
        $1 == n && $3 == t { print $4; exit }
    ' "$file"
}

sha256_of() {
    local file="$1"
    local sum

    if command -v sha256sum >/dev/null 2>&1; then
        sum="$(sha256sum "$file")" || return 1
    elif command -v shasum >/dev/null 2>&1; then
        sum="$(shasum -a 256 "$file")" || return 1
    else
        log_error "sha256sum or shasum is required to verify downloads."
        return 1
    fi
    printf '%s\n' "${sum%% *}"
}

require_sha256() {
    local file="$1"
    local expected="$2"
    local label="$3"
    local got

    if [ -z "$expected" ]; then
        log_error "No pinned checksum for $label."
        return 1
    fi
    got="$(sha256_of "$file")" || return 1
    if [ "$got" != "$expected" ]; then
        log_error "Checksum mismatch for $label."
        log_error "Expected $expected"
        log_error "Got      $got"
        return 1
    fi
    log_info "Verified SHA-256 for $label"
}

require_pins() {
    local pins

    if ! pins="$(checksums_path)"; then
        # stderr: callers read the path from stdout, including command substitutions.
        log_error "No install-checksums.txt next to this installer. Refusing to download Node, uv, or Bun." >&2
        exit 1
    fi
    printf '%s\n' "$pins"
}

platform_target() {
    case "$(uname -s):$(uname -m)" in
        Linux:x86_64|Linux:amd64) printf 'linux-x64' ;;
        Linux:aarch64|Linux:arm64) printf 'linux-arm64' ;;
        Darwin:x86_64|Darwin:amd64) printf 'darwin-x64' ;;
        Darwin:arm64|Darwin:aarch64) printf 'darwin-arm64' ;;
        *)
            log_error "Unsupported platform: $(uname -s) $(uname -m)"
            return 1
            ;;
    esac
}

linux_is_musl() {
    if [ "$(uname -s)" != Linux ]; then
        return 1
    fi
    if [ -f /etc/alpine-release ]; then
        return 0
    fi
    if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | grep -qi musl; then
        return 0
    fi
    return 1
}

uv_checksum_target() {
    local base

    base="$(platform_target)" || return 1
    if [ "$base" = linux-x64 ] && linux_is_musl; then
        printf 'linux-musl-x64'
        return 0
    fi
    if [ "$base" = linux-arm64 ] && linux_is_musl; then
        printf 'linux-musl-arm64'
        return 0
    fi
    printf '%s\n' "$base"
}

uv_triple() {
    case "$(uv_checksum_target)" in
        linux-x64) printf 'x86_64-unknown-linux-gnu' ;;
        linux-arm64) printf 'aarch64-unknown-linux-gnu' ;;
        linux-musl-x64) printf 'x86_64-unknown-linux-musl' ;;
        linux-musl-arm64) printf 'aarch64-unknown-linux-musl' ;;
        darwin-x64) printf 'x86_64-apple-darwin' ;;
        darwin-arm64) printf 'aarch64-apple-darwin' ;;
        *)
            return 1
            ;;
    esac
}

bun_asset_name() {
    case "$(platform_target)" in
        linux-x64) printf 'bun-linux-x64' ;;
        linux-arm64) printf 'bun-linux-aarch64' ;;
        darwin-x64) printf 'bun-darwin-x64' ;;
        darwin-arm64) printf 'bun-darwin-aarch64' ;;
        *)
            return 1
            ;;
    esac
}

# CAST_TRUSTED_KEY_FILE overrides the embedded key for tests and for an
# operator who pins a different release key. The default is the GitHub
# web commit signing key, also published at scripts/trusted-commit-key.asc.
write_trusted_key() {
    local dest="$1"

    if [ -n "${CAST_TRUSTED_KEY_FILE:-}" ]; then
        if [ ! -f "$CAST_TRUSTED_KEY_FILE" ]; then
            return 1
        fi
        cat "$CAST_TRUSTED_KEY_FILE" > "$dest"
        return 0
    fi
    cat > "$dest" << 'EOF'
-----BEGIN PGP PUBLIC KEY BLOCK-----

mQINBGWmxXYBEACyN+4viFQM6QQoKr0A2W0rGdMobTJwOZso2QPpewbyBsuL3rNW
5OmHrWwXAhPKNqUIyOzdq8MoSxoTTuqLksoahixEL/X2nyhOBxR9GkYz/oI9R3nY
cLRaFQoSJoVfOt61opkLUzbWAehpbgT8EKln8JsENq0+0nDlWQi0h2Q9oGmqlgVz
skwmVZ8Leyv4Mg7hN6swyZ7moZfkkpD5+U7Z2XVurCzkSSfg4zb2lMRLJos2eCAc
749ECsX0t7OBftF+YqgjIXixXsm2RrUqvU47OkOtZeAhvAYenbC3pr9Fha5NxoBU
Ea+11MK9W6OcRhwvxVCUrMUR6FTSZyC//VpXTTtrRlOqpU5wGMbP3zpn9geqOXCl
8rF7+1gAPG/o+QFQTBsVEruwi4JWogiQuQyOwAIlFe/7dvaxWZGpv/yW2+L3guL7
xaHKFVGsayhlitQQ5Xa+P1iSgKSXDyReCbWotfqAempPySI25LHh3ScXI6NgdHSr
SBaFojwAfgxbPTEQ6adIsKHCQofrnLrNa3UOeGDGiOOK0aYV3jiEDGAouatkNf2q
85Eosj1f9laCqAH3YLJD7dcSne1iChK5qRTByMvIyeSD0NbNnVMFOGpXySyWtKb2
ldpu8AWBQJsJs9FmYBcWAGBA2pp+IxaCn6rBIHIsUVFRN8OVZKsEsBkWywARAQAB
tBtHaXRIdWIgPG5vcmVwbHlAZ2l0aHViLmNvbT6JAk4EEwEKADgWIQSWhHmhr/kn
430aVmu1aQ7uu5UhlAUCZabFdgIbAwULCQgHAgYVCgkICwIEFgIDAQIeAQIXgAAK
CRC1aQ7uu5UhlIMuEAClvVwC+Neoiq0AdixJZsagKHpx1QrMJWrtMRi4eXVTTaeX
+P1unhC/AmSO4Xxd3uRoejHvfWh4F0gitUJ8XKgiejnmuGcq7Dbt5OoO1JuXGlW2
BQ+MiGoYVw2B0sOhWDNrIBWOO/WL4LykcGnAtrRXwoS0Wx4MCydztXQY5lcnCWaW
8rvu7WmduoOikH4HI97rqN5896dc4iBKSx8LZf+46DRCCD/5SfACplBz4hs5zen8
TL8zd+zxjFrXbzota0jSDEGK9WGO4z55S2xScC6zv6v3Bj1OR8Bs5aodGtmamHZ7
sE9w0RJoCfNx+9cR/rE82SrOaBpVU7urLe4lg7zaaNhqDdNV8ymuXGmIJarDgrme
iB5bHS+dLFzLUkTgot4RFlPa9bFiJuJN6Tc9tMu5RJQ9l/zKmxDHIKWsAle5R65u
zEq04LugTQBdEorGxfQCsF2ga9ncKTDMiAThWTvZpOP3NJ/athZRmOBpG4B9iR6r
pRU8F/+MokG4fIMwnvtOhWQFiEzdTkJ7U5JAkPtTAmT3/mznwtPEU7DrFWSGAdqg
IMOlxNCBeGvjwLR0qGH7cB9qHDGNoDLkjaUFpu5tPv4/ivkQaHlHJxjT0ILM6jet
CAzKpKh48rm65tmrJX6KVpj0r2kKMscFf7s7XaPlCNCFds/YA+0puPbzJKWKfA==
=NRlX
-----END PGP PUBLIC KEY BLOCK-----
EOF
}

verify_signed_commit() {
    local dest="$1"
    local keyfile gpghome status

    if ! command -v gpg >/dev/null 2>&1; then
        log_error "gpg is required to verify the Cast checkout. To continue, install gnupg and run this script again."
        exit 1
    fi
    keyfile="$(mktemp "${TMPDIR:-/tmp}/cast-trust.XXXXXX")"
    gpghome="$(mktemp -d "${TMPDIR:-/tmp}/cast-gpg.XXXXXX")"
    chmod 700 "$gpghome"
    if ! write_trusted_key "$keyfile"; then
        rm -rf "$gpghome" "$keyfile"
        log_error "No trusted commit key is available."
        return 1
    fi
    if ! GNUPGHOME="$gpghome" gpg --batch --no-tty --import "$keyfile" >/dev/null 2>&1; then
        rm -rf "$gpghome" "$keyfile"
        log_error "Could not import the trusted commit key."
        return 1
    fi
    set +e
    GNUPGHOME="$gpghome" git -C "$dest" -c gpg.format=openpgp verify-commit HEAD >/dev/null 2>&1
    status=$?
    set -e
    rm -rf "$gpghome" "$keyfile"
    return "$status"
}

checkout_installer_is_current() {
    local dest="$1"

    [ -f "$dest/install.sh" ] || return 1
    [ -f "$dest/install-checksums.txt" ] || return 1
    grep -q 'require_sha256()' "$dest/install.sh" || return 1
    return 0
}

install_node_tarball() {
    local os arch target version name url tmp prefix pins expected

    case "$(uname -s)" in
        Linux) os=linux ;;
        Darwin) os=darwin ;;
        *)
            log_error "Unsupported operating system: $(uname -s)"
            exit 1
            ;;
    esac
    case "$(uname -m)" in
        x86_64|amd64) arch=x64 ;;
        aarch64|arm64) arch=arm64 ;;
        *)
            log_error "Unsupported architecture: $(uname -m)"
            exit 1
            ;;
    esac

    target="${os}-${arch}"
    pins="$(require_pins)"
    version="$(pin_version "$pins" node)"
    expected="$(pin_value "$pins" node "$target")"
    if [ -z "$version" ] || [ -z "$expected" ]; then
        log_error "install-checksums.txt has no Node.js pin for $target."
        exit 1
    fi
    name="node-v${version}-${target}.tar.gz"
    url="https://nodejs.org/dist/v${version}/${name}"
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/cast-node.XXXXXX")"
    prefix="$HOME/.local/node"
    log_info "Downloading $name"
    if ! curl -fsSL "$url" -o "$tmp/node.tar.gz"; then
        rm -rf "$tmp"
        log_error "Could not download $name."
        exit 1
    fi
    if ! require_sha256 "$tmp/node.tar.gz" "$expected" "node ${version} ${target}"; then
        rm -rf "$tmp"
        exit 1
    fi
    rm -rf "$prefix"
    mkdir -p "$prefix"
    tar -xzf "$tmp/node.tar.gz" -C "$prefix" --strip-components=1
    rm -rf "$tmp"
    publish_bin node "$prefix/bin/node"
    publish_bin npm "$prefix/bin/npm"
    publish_bin npx "$prefix/bin/npx"
    export_tool_path
}

ensure_node() {
    export_tool_path
    if node_ok; then
        return 0
    fi
    install_node_tarball
    if ! node_ok; then
        log_error "Node.js >= 18 is still not available after installation."
        exit 1
    fi
}

python_ok() {
    check_command python3 || return 1
    compare_versions "$(get_python_version)" "3.11.0"
}

python_venv_ok() {
    local tmp

    # Importing ensurepip succeeds on Debian/Ubuntu even though the system
    # Python disables it. A real venv is the check that matters.
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/cast-venv.XXXXXX")"
    if python3 -m venv "$tmp/venv" >/dev/null 2>&1 && [ -x "$tmp/venv/bin/python" ]; then
        rm -rf "$tmp"
        return 0
    fi
    rm -rf "$tmp"
    return 1
}

ensure_pip() {
    export_tool_path
    if check_command pip3 || python3 -m pip --version >/dev/null 2>&1; then
        return 0
    fi
    # uv provides its own package installer. Debian's python3 -m ensurepip
    # exits with "ensurepip is disabled" even when the venv module works.
    if check_command uv; then
        log_info "pip3 not found. Using uv for Python packages."
        return 0
    fi
    if check_command apt-get; then
        log_info "Installing python3-pip and python3-venv..."
        run_root env DEBIAN_FRONTEND=noninteractive apt-get update
        run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y python3-pip python3-venv
    elif python3 -m ensurepip --upgrade >/dev/null 2>&1; then
        return 0
    fi
    export_tool_path
    if check_command pip3 || python3 -m pip --version >/dev/null 2>&1; then
        return 0
    fi
    log_error "Failed to install pip"
    log_info "Install pip and run this script again: https://pip.pypa.io/en/stable/installation/"
    exit 1
}

install_uv_python() {
    local tmp py pins version triple target url expected

    if ! check_command uv; then
        pins="$(require_pins)"
        version="$(pin_version "$pins" uv)"
        target="$(uv_checksum_target)" || exit 1
        triple="$(uv_triple)" || exit 1
        expected="$(pin_value "$pins" uv "$target")"
        if [ -z "$version" ] || [ -z "$expected" ]; then
            log_error "install-checksums.txt has no uv pin for $target."
            exit 1
        fi
        log_info "Installing uv ${version}..."
        url="https://github.com/astral-sh/uv/releases/download/${version}/uv-${triple}.tar.gz"
        tmp="$(mktemp -d "${TMPDIR:-/tmp}/cast-uv.XXXXXX")"
        if ! curl -fsSL "$url" -o "$tmp/uv.tar.gz"; then
            rm -rf "$tmp"
            log_error "Could not download uv."
            exit 1
        fi
        if ! require_sha256 "$tmp/uv.tar.gz" "$expected" "uv ${version} ${target}"; then
            rm -rf "$tmp"
            exit 1
        fi
        mkdir -p "$tmp/root"
        tar -xzf "$tmp/uv.tar.gz" -C "$tmp/root" --strip-components=1
        if [ ! -x "$tmp/root/uv" ]; then
            rm -rf "$tmp"
            log_error "uv archive did not contain an executable."
            exit 1
        fi
        mkdir -p "$HOME/.local/bin"
        install -m 0755 "$tmp/root/uv" "$HOME/.local/bin/uv"
        rm -rf "$tmp"
        export_tool_path
    fi
    if ! check_command uv; then
        log_error "uv is not available."
        log_info "Install Python >= 3.11 and run this script again."
        exit 1
    fi
    log_info "Installing Python 3.12..."
    uv python install 3.12 </dev/null
    py="$(uv python find 3.12)"
    if [ ! -x "$py" ]; then
        log_error "uv did not install Python 3.12."
        exit 1
    fi
    publish_bin python3 "$py"
    export_tool_path
}

ensure_python() {
    export_tool_path
    if python_ok && python_venv_ok; then
        return 0
    fi
    if python_ok && check_command apt-get; then
        log_info "Installing python3-venv and python3-pip..."
        run_root env DEBIAN_FRONTEND=noninteractive apt-get update
        run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y python3-venv python3-pip
        export_tool_path
        if python_ok && python_venv_ok; then
            return 0
        fi
    fi
    install_uv_python
    if ! python_ok; then
        log_error "Python >= 3.11 is still not available after installation."
        exit 1
    fi
}

ensure_unzip() {
    check_command unzip && return 0
    log_info "Installing unzip..."
    if check_command apt-get; then
        run_root env DEBIAN_FRONTEND=noninteractive apt-get update
        run_root env DEBIAN_FRONTEND=noninteractive apt-get install -y unzip
    elif check_command dnf; then
        run_root dnf install -y unzip
    elif check_command yum; then
        run_root yum install -y unzip
    elif check_command pacman; then
        run_root pacman -Sy --noconfirm unzip
    elif check_command apk; then
        run_root apk add unzip
    elif [ "$(uname -s)" = Darwin ] && check_command brew; then
        brew install unzip </dev/null
    else
        log_warn "unzip is not installed. Bun's installer needs it."
        return 1
    fi
    export_tool_path
    if check_command unzip; then
        return 0
    fi
    log_warn "unzip is still not available. Bun's installer needs it."
    return 1
}

ensure_bun() {
    local tmp pins version target asset url expected

    export_tool_path
    if check_command bun || [ -x "$HOME/.bun/bin/bun" ]; then
        export_tool_path
        return 0
    fi
    if ! ensure_unzip; then
        log_warn "Bun was not installed. The TUI needs it: https://bun.sh"
        return 0
    fi
    pins="$(require_pins)"
    version="$(pin_version "$pins" bun)"
    target="$(platform_target)" || exit 1
    asset="$(bun_asset_name)" || exit 1
    expected="$(pin_value "$pins" bun "$target")"
    if [ -z "$version" ] || [ -z "$expected" ]; then
        log_error "install-checksums.txt has no Bun pin for $target."
        exit 1
    fi
    log_info "Installing Bun ${version}..."
    url="https://github.com/oven-sh/bun/releases/download/bun-v${version}/${asset}.zip"
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/cast-bun.XXXXXX")"
    if ! curl -fsSL "$url" -o "$tmp/bun.zip"; then
        log_warn "Could not download Bun. The TUI needs it: https://bun.sh"
        rm -rf "$tmp"
        return 0
    fi
    if ! require_sha256 "$tmp/bun.zip" "$expected" "bun ${version} ${target}"; then
        rm -rf "$tmp"
        exit 1
    fi
    mkdir -p "$tmp/root"
    if ! unzip -q "$tmp/bun.zip" -d "$tmp/root"; then
        rm -rf "$tmp"
        log_error "Could not unpack Bun."
        exit 1
    fi
    if [ ! -f "$tmp/root/${asset}/bun" ]; then
        rm -rf "$tmp"
        log_error "Bun archive did not contain ${asset}/bun."
        exit 1
    fi
    mkdir -p "$HOME/.bun/bin"
    install -m 0755 "$tmp/root/${asset}/bun" "$HOME/.bun/bin/bun"
    rm -rf "$tmp"
    publish_bin bun "$HOME/.bun/bin/bun"
    export_tool_path
}

persist_path() {
    local profile default

    export_tool_path
    if [ "$(uname -s)" = Darwin ]; then
        default="$HOME/.zshrc"
    else
        default="$HOME/.bashrc"
    fi
    for profile in "$HOME/.zshrc" "$HOME/.bashrc"; do
        if [ -f "$profile" ] && grep -q 'castagent-path' "$profile"; then
            continue
        fi
        if [ -f "$profile" ] || [ "$profile" = "$default" ]; then
            printf '\n%s\n' 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH" # castagent-path' >> "$profile"
            log_info "Added Cast tools to PATH in ${profile/#$HOME/~}"
        fi
    done
}

install_repo() {
    printf '%s\n' "${CAST_INSTALL_REPO:-https://github.com/scott/castagent.git}"
}

install_ref() {
    printf '%s\n' "${CAST_INSTALL_REF:-main}"
}

# A piped one-liner has no script file. Clone the pinned ref, require a
# commit signed by the trusted key, and exec install.sh from that checkout.
# Do not download install.sh from main again. An older checkout that has
# no checksum pins is built by this script instead of its own installer.
clone_pinned_checkout() {
    local dest repo ref

    dest="${CAST_INSTALL_DIR:-$HOME/.cast/castagent}"
    repo="$(install_repo)"
    ref="$(install_ref)"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
        if is_cast_checkout "$dest"; then
            log_info "Using existing checkout: $dest"
            if checkout_installer_is_current "$dest"; then
                export CAST_INSTALL_PACKAGES_DONE=1
                exec bash "$dest/install.sh"
            fi
            log_info "Existing checkout installer has no checksum pins. Continuing with this installer."
            SCRIPT_DIR="$dest"
            return 0
        fi
        log_error "$dest exists and is not a Cast checkout."
        log_info "Move it aside or set CAST_INSTALL_DIR to a new path, then run this script again."
        exit 1
    fi

    log_info "Cloning Cast ${ref} into $dest"
    mkdir -p "$(dirname "$dest")"
    if ! git clone --branch "$ref" --depth 1 "$repo" "$dest" </dev/null; then
        log_error "Could not clone Cast into $dest"
        exit 1
    fi
    if ! verify_signed_commit "$dest"; then
        log_error "Refusing to run install.sh from $dest. The commit is not signed by the trusted key."
        exit 1
    fi
    if ! checkout_installer_is_current "$dest"; then
        log_error "Cloned installer has no checksum pins. Refusing to continue."
        exit 1
    fi
    export CAST_INSTALL_PACKAGES_DONE=1
    exec bash "$dest/install.sh"
}

prepare_checkout() {
    local found

    if found="$(find_checkout)"; then
        SCRIPT_DIR="$found"
        return 0
    fi
    ensure_system_packages
    ensure_git
    clone_pinned_checkout
}

prepare_checkout

# Header
echo -e "${BLUE}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}          ${GREEN}Cast${NC} - Agent Building & Deployment Platform       ${BLUE}║${NC}"
echo -e "${BLUE}║${NC}                     Installation Script                      ${BLUE}║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

log_info "Starting installation from: $SCRIPT_DIR"
echo ""

# ============================================
# PREREQUISITE CHECKS
# ============================================
log_info "Checking prerequisites..."

ensure_system_packages
ensure_git
ensure_node
ensure_python
ensure_bun
persist_path

# Check Node.js
if check_command node; then
    NODE_VERSION=$(get_node_version)
    log_info "Node.js found: v$NODE_VERSION"
    
    if compare_versions "$NODE_VERSION" "18.0.0"; then
        log_success "Node.js version is compatible (>= 18.0.0)"
    else
        log_error "Node.js version $NODE_VERSION is too old. Required: >= 18.0.0"
        log_info "Please upgrade Node.js: https://nodejs.org/"
        exit 1
    fi
else
    log_error "Node.js is not installed"
    log_info "Please install Node.js >= 18.0.0: https://nodejs.org/"
    exit 1
fi

# Check npm
if check_command npm; then
    NPM_VERSION=$(npm -v)
    log_info "npm found: v$NPM_VERSION"
else
    log_error "npm is not installed"
    log_info "npm should be included with Node.js installation"
    exit 1
fi

# Check Python
if check_command python3; then
    PYTHON_VERSION=$(get_python_version)
    log_info "Python found: v$PYTHON_VERSION"
    
    if compare_versions "$PYTHON_VERSION" "3.11.0"; then
        log_success "Python version is compatible (>= 3.11.0)"
    else
        log_error "Python version $PYTHON_VERSION is too old. Required: >= 3.11.0"
        log_info "Please upgrade Python: https://www.python.org/downloads/"
        exit 1
    fi
else
    log_error "Python 3 is not installed"
    log_info "Please install Python >= 3.11.0: https://www.python.org/downloads/"
    exit 1
fi

# Check pip. Debian/Ubuntu disables ensurepip for the system Python.
ensure_pip
if check_command pip3; then
    PIP_VERSION=$(pip3 --version | awk '{print $2}')
    log_info "pip found: v$PIP_VERSION"
elif check_command uv; then
    log_info "Python packages will be installed with uv"
else
    log_error "pip3 is not available"
    exit 1
fi

# Check UV (optional but recommended)
UV_AVAILABLE=false
if check_command uv; then
    UV_VERSION=$(uv --version)
    log_info "UV found: $UV_VERSION"
    UV_AVAILABLE=true
else
    log_warn "UV not found. UV is recommended for Python dependency management"
    log_info "install-checksums.txt pins the uv archive. The installer checks that digest before unpacking."
    log_info "Continuing with pip..."
fi

echo ""

# ============================================
# CREATE DIRECTORIES
# ============================================
log_info "Creating directories..."

# mkdir applies the process umask. umask 077 makes these directories
# born mode 0700. chmod repairs a directory this script used to leave
# at 0755. The caller's umask is restored before later install steps.
previous_umask="$(umask)"
umask 077
mkdir -p "$HOME/.cast"
mkdir -p "$HOME/.cast/tokens"
mkdir -p "$HOME/.cast/sessions"
umask "$previous_umask"
chmod 700 "$HOME/.cast" "$HOME/.cast/tokens" "$HOME/.cast/sessions"
mkdir -p "$HOME/.cast/vault"
mkdir -p "$HOME/.cast/builder"
mkdir -p "$HOME/.cast/builder/tools"
mkdir -p "$HOME/.cast/agents"

log_success "Directories created"
echo ""

# ============================================
# INSTALL NODE.JS DEPENDENCIES
# ============================================
log_info "Installing Node.js dependencies..."

cd "$SCRIPT_DIR"

# Install root package
log_info "Installing root dependencies..."
npm install </dev/null

# Install CLI dependencies
log_info "Installing cast-cli dependencies..."
cd "$SCRIPT_DIR/typescript/cast-cli"
npm install </dev/null

# Install TUI dependencies
log_info "Installing cast-tui dependencies..."
cd "$SCRIPT_DIR/typescript/cast-tui"
npm install </dev/null

cd "$SCRIPT_DIR"

log_success "Node.js dependencies installed"
echo ""

# ============================================
# BUILD TYPESCRIPT
# ============================================
log_info "Building TypeScript projects..."

# Build CLI
log_info "Building cast-cli..."
cd "$SCRIPT_DIR/typescript/cast-cli"
npm run build </dev/null

# Build TUI
log_info "Building cast-tui..."
cd "$SCRIPT_DIR/typescript/cast-tui"
npm run build </dev/null

cd "$SCRIPT_DIR"

log_success "TypeScript projects built"
echo ""

# ============================================
# INSTALL PYTHON DEPENDENCIES
# ============================================
log_info "Installing Python dependencies..."

cd "$SCRIPT_DIR/python"

if [ "$UV_AVAILABLE" = true ]; then
    log_info "Using UV for Python dependency management..."
    
    # Create virtual environment if it doesn't exist
    if [ ! -d ".venv" ]; then
        log_info "Creating Python virtual environment..."
        uv venv
    fi
    
    # Install dependencies
    log_info "Installing Python packages with UV..."
    uv pip install -e "."
    
    # Install additional runtime dependencies
    uv pip install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
else
    log_info "Using pip for Python dependency management..."
    
    # Create virtual environment if it doesn't exist
    if [ ! -d ".venv" ]; then
        log_info "Creating Python virtual environment..."
        python3 -m venv .venv
    fi
    
    # Activate virtual environment
    source .venv/bin/activate
    
    # Install dependencies
    log_info "Installing Python packages with pip..."
    pip install -e "."
    pip install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
fi

cd "$SCRIPT_DIR"

log_success "Python dependencies installed"
echo ""

# ============================================
# SET UP GLOBAL CLI
# ============================================
log_info "Setting up global cast CLI..."

# Create symlink or wrapper script
CLI_PATH="$SCRIPT_DIR/typescript/cast-cli/bin/run"

if [ -f "$CLI_PATH" ]; then
    # Check if we can create a global symlink. Tests set
    # CAST_INSTALL_SKIP_SYSTEM_BIN so a developer machine's /usr/local/bin/cast
    # is left alone.
    if [ "${CAST_INSTALL_SKIP_SYSTEM_BIN:-}" != 1 ] && [ -w "/usr/local/bin" ]; then
        ln -sf "$CLI_PATH" /usr/local/bin/cast
        log_success "Created symlink: /usr/local/bin/cast"
    elif [ -w "$HOME/.local/bin" ] || mkdir -p "$HOME/.local/bin"; then
        ln -sf "$CLI_PATH" "$HOME/.local/bin/cast"
        log_success "Created symlink: $HOME/.local/bin/cast"
        if [ "$PATH_HAD_LOCAL_BIN" != 1 ]; then
            log_warn "$HOME/.local/bin is not in your PATH"
            log_info "Add this to your shell profile:"
            log_info '  export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"'
        fi
    else
        log_warn "Cannot create global symlink (no write permission)"
        log_info "You can run Cast directly with:"
        log_info "  $CLI_PATH"
        log_info ""
        log_info "Or add an alias to your shell profile:"
        log_info "  alias cast='$CLI_PATH'"
    fi
else
    log_error "CLI entry point not found at $CLI_PATH"
    log_info "Build may have failed. Check output above for errors."
fi

echo ""

# ============================================
# CREATE CONFIG FILES
# ============================================
log_info "Creating configuration files..."

# Create default config if it doesn't exist
if [ ! -f "$HOME/.cast/config.yaml" ]; then
    cat > "$HOME/.cast/config.yaml" << 'EOF'
cast:
  version: "1.0"

defaults:
  agent_storage: ~/.cast/agents
  builder_model: openrouter/minimax/minimax-m2.5
  deployment_provider: railway

providers:
  openrouter:
    api_key: ${OPENROUTER_API_KEY}
    default_base_url: https://openrouter.ai/api/v1
  digitalocean_inference:
    api_key: ${DIGITALOCEAN_MODEL_ACCESS_KEY}
    default_base_url: https://inference.do-ai.run/v1

deployment:
  railway:
    api_token: ${RAILWAY_API_TOKEN}
    project_id: ${RAILWAY_PROJECT_ID}
  digitalocean:
    api_token: ${DO_API_TOKEN}
    app_id: ${DO_APP_ID}
  fly:
    api_token: ${FLY_API_TOKEN}
  docker:
    registry: localhost:5000
EOF
    log_success "Created default config: ~/.cast/config.yaml"
else
    log_warn "Config already exists: ~/.cast/config.yaml"
fi

# Create builder instructions if they don't exist
if [ ! -f "$HOME/.cast/builder/instructions.md" ]; then
    cat > "$HOME/.cast/builder/instructions.md" << 'EOF'
# Cast Builder Agent

You are the Cast Builder Agent, designed to help users create AI agents.

## Your Mission

Through conversation, understand what the user wants their agent to do, then:
1. Create the agent scaffold in ~/.cast/agents/<agent-name>/
2. Configure MCP integrations they need
3. Recommend appropriate models
4. Ensure the agent is ready to run

## Your Personality

- **Curious but focused**: Ask clarifying questions
- **Helpful and proactive**: Suggest useful tools
- **Transparent**: Explain what you're doing
- **Security-conscious**: Recommend appropriate permissions

## Security Guidelines

- Never suggest always-allow for destructive operations
- Recommend approve-once for sending/deleting
- Be explicit about what data the agent will access
EOF
    log_success "Created builder instructions: ~/.cast/builder/instructions.md"
else
    log_warn "Builder instructions already exist"
fi

echo ""

# ============================================
# ENVIRONMENT SETUP
# ============================================
log_info "Checking environment variables..."

if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$DIGITALOCEAN_MODEL_ACCESS_KEY" ]; then
    log_warn "No LLM API key is set. Either key is enough to run an agent:"
    log_info "  export OPENROUTER_API_KEY='your-key-here'"
    log_info "  export DIGITALOCEAN_MODEL_ACCESS_KEY='your-model-access-key'"

    echo ""
    log_info "For deployment, you'll also need:"
    log_info "  export RAILWAY_API_TOKEN='your-token'"
    log_info "  export FLY_API_TOKEN='your-token'"
    log_info "  export DO_API_TOKEN='your-token'"
fi

echo ""

# ============================================
# VERIFICATION
# ============================================
log_info "Verifying installation..."

# Set up global cast command
if [ ! -f "$SCRIPT_DIR/cast" ]; then
    cat > "$SCRIPT_DIR/cast" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -L "$0" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$(readlink "$0")")" && pwd)"
fi
exec "$SCRIPT_DIR/typescript/cast-cli/bin/run" "$@"
EOF
    chmod +x "$SCRIPT_DIR/cast"
fi

# Remove stale Go binary from older (pre-TypeScript-rewrite) versions of Cast.
# This binary lives at ~/.cast/bin/cast and, if ~/.cast/bin appears in $PATH
# before ~/.local/bin, silently shadows the new TypeScript CLI — even after
# we've set up the symlinks below. Clean it up so the new CLI wins.
if [ -f "$HOME/.cast/bin/cast" ]; then
    log_info "Removing stale Cast binary from older (pre-TypeScript) version at ~/.cast/bin/cast"
    rm -f "$HOME/.cast/bin/cast"
fi

mkdir -p "$HOME/.local/bin"
if [ -L "$HOME/.local/bin/cast" ]; then
    rm "$HOME/.local/bin/cast"
fi
ln -sf "$SCRIPT_DIR/cast" "$HOME/.local/bin/cast"

# Check if cast command is available
if [ -f "$HOME/.local/bin/cast" ]; then
    log_success "cast command installed at ~/.local/bin/cast"
    
    if [ "$PATH_HAD_LOCAL_BIN" != 1 ] && [ ! -x /usr/local/bin/cast ] && [ ! -L /usr/local/bin/cast ]; then
        log_info "Open a new shell, or run:"
        log_info '  export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"'
    else
        log_success "Cast CLI is ready to use"
    fi
else
    log_warn "cast command setup failed"
    log_info "You can use the full path: $CLI_PATH"
fi

# Check Python runtime
if [ "$UV_AVAILABLE" = true ]; then
    if uv run python -c "import cast" &> /dev/null; then
        log_success "Python runtime is accessible"
    else
        log_warn "Python runtime may need activation"
    fi
else
    if [ -f "$SCRIPT_DIR/python/.venv/bin/python" ]; then
        if "$SCRIPT_DIR/python/.venv/bin/python" -c "import cast" &> /dev/null; then
            log_success "Python runtime is accessible"
        fi
    fi
fi

echo ""

# ============================================
# COMPLETION
# ============================================
echo -e "${GREEN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}              Installation Complete!                          ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

log_success "Cast has been installed successfully!"
echo ""

log_info "Quick start:"
echo "  cast list                    # List all agents"
echo "  cast new                     # Create an agent"
echo "  cast dev <agent>             # Start an agent in development mode"
echo "  cast --help                  # Show help"
echo ""

log_info "Project structure:"
echo "  ~/.cast/                     # Global state and config"
echo "  ~/.cast/agents/              # Your agents"
echo "  $SCRIPT_DIR                  # Project files"
echo ""

log_info "Next steps:"
echo "  1. Set up your API keys in ~/.cast/config.yaml or as env vars"
echo "  2. Create your first agent: cast new"
echo "  3. Start developing: cast dev <agent>"
echo ""

log_info "For more information, see: https://castagent.dev"
echo ""
}
