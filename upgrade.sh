#!/bin/bash
# Upgrade this Cast checkout to the newest upstream commit and rebuild it
# in place: Node dependencies, cast-cli, cast-tui, and the Python runtime.
#
# This updates the local Cast installation. It does not run `cast upgrade`
# and does not touch deployed agents. Files under ~/.cast (agents, config,
# tokens) stay put, except a stale pre-TypeScript binary at ~/.cast/bin/cast.
#
# The whole script is one compound command so `curl | bash` reads it before
# child processes start. Those processes would otherwise consume unread stdin.

{
set -euo pipefail
export GIT_TERMINAL_PROMPT=0

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log_info() {
    printf '%b[INFO]%b %s\n' "$BLUE" "$NC" "$1"
}

log_success() {
    printf '%b[SUCCESS]%b %s\n' "$GREEN" "$NC" "$1"
}

log_warn() {
    printf '%b[WARN]%b %s\n' "$YELLOW" "$NC" "$1"
}

log_error() {
    printf '%b[ERROR]%b %s\n' "$RED" "$NC" "$1"
}

usage() {
    cat << 'EOF'
Usage: ./upgrade.sh

Move this Cast checkout onto the newest origin/main commit and rebuild
the CLI, TUI, and Python runtime in place.

Any local branch is switched onto origin/main, including a checkout on
master that tracks origin/master. origin/master is used only when the
remote has no main branch.

Leaves ~/.cast agents, config, and tokens untouched. Resets tracked TypeScript
build info files, which a build rewrites. Stops without rebuilding when any
other uncommitted change is present, or when the local upstream branch has
commits that cannot fast-forward. Also stops when gpg is missing (install
gnupg), or when the origin commit is not signed by the trusted key shipped
in this script.

This does not upgrade a deployed agent. That command is: cast upgrade <agent>
EOF
}

if [[ "${CAST_UPGRADE_REEXEC:-}" == 1 && -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
    trap 'rm -f "${BASH_SOURCE[0]}"' EXIT
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

if [[ $# -gt 0 ]]; then
    usage >&2
    exit 1
fi

check_command() {
    command -v "$1" >/dev/null 2>&1
}

version_ge() {
    # True when $1 >= $2. `|| true` keeps SIGPIPE from `head` off set -e.
    local lowest
    lowest="$(printf '%s\n' "$1" "$2" | sort -V | head -n 1 || true)"
    if [[ "$lowest" == "$2" ]]; then
        return 0
    fi
    return 1
}

resolve_symlink() {
    local path="$1"
    local hops=0
    local dir target

    while [[ -L "$path" && "$hops" -lt 20 ]]; do
        dir="$(cd "$(dirname "$path")" && pwd)" || return 1
        target="$(readlink "$path")"
        if [[ "$target" == /* ]]; then
            path="$target"
        else
            path="$dir/$target"
        fi
        hops=$((hops + 1))
    done
    printf '%s\n' "$path"
}

is_cast_checkout() {
    local dir="$1"
    [[ -n "$dir" \
        && -f "$dir/typescript/cast-cli/bin/run" \
        && -f "$dir/typescript/cast-tui/package.json" \
        && -f "$dir/python/pyproject.toml" ]] || return 1
    git -C "$dir" rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
    return 0
}

checkout_from_path() {
    local path="$1"
    local dir

    [[ -e "$path" || -L "$path" ]] || return 1
    path="$(resolve_symlink "$path")" || return 1
    if [[ -d "$path" ]]; then
        dir="$(cd "$path" && pwd)" || return 1
    else
        dir="$(cd "$(dirname "$path")" && pwd)" || return 1
    fi

    while [[ -n "$dir" && "$dir" != "/" ]]; do
        if is_cast_checkout "$dir"; then
            printf '%s\n' "$dir"
            return 0
        fi
        dir="$(dirname "$dir")"
    done
    return 1
}

locate_checkout() {
    local source_file="${BASH_SOURCE[0]:-}"
    local found=""
    local candidate

    if [[ "${CAST_UPGRADE_REEXEC:-}" == 1 && -n "${CAST_UPGRADE_ROOT:-}" ]]; then
        if is_cast_checkout "$CAST_UPGRADE_ROOT"; then
            printf '%s\n' "$CAST_UPGRADE_ROOT"
            return 0
        fi
        log_error "CAST_UPGRADE_ROOT is not a Cast checkout: $CAST_UPGRADE_ROOT"
        return 1
    fi

    if [[ -n "$source_file" && -f "$source_file" ]]; then
        if found="$(checkout_from_path "$source_file")"; then
            printf '%s\n' "$found"
            return 0
        fi
    fi

    if [[ -e "${HOME}/.local/bin/cast" || -L "${HOME}/.local/bin/cast" ]]; then
        if found="$(checkout_from_path "${HOME}/.local/bin/cast")"; then
            printf '%s\n' "$found"
            return 0
        fi
    fi

    # Tests set this so a developer machine's own cast binary is not selected.
    if [[ "${CAST_UPGRADE_SKIP_SYSTEM_BIN:-}" != 1 ]]; then
        if [[ -e /usr/local/bin/cast || -L /usr/local/bin/cast ]]; then
            if found="$(checkout_from_path /usr/local/bin/cast)"; then
                printf '%s\n' "$found"
                return 0
            fi
        fi

        if candidate="$(command -v cast 2>/dev/null || true)" && [[ -n "$candidate" ]]; then
            if found="$(checkout_from_path "$candidate")"; then
                printf '%s\n' "$found"
                return 0
            fi
        fi
    fi

    return 1
}

maybe_reexec() {
    local root="$1"
    shift
    local source_file="${BASH_SOURCE[0]:-}"
    local source_dir tmp

    [[ "${CAST_UPGRADE_REEXEC:-}" == 1 ]] && return 0
    [[ -n "$source_file" && -f "$source_file" ]] || return 0
    source_dir="$(cd "$(dirname "$source_file")" && pwd)" || return 0

    case "$source_dir" in
        "$root"|"$root"/*) ;;
        *) return 0 ;;
    esac

    # The fast-forward below replaces this file. Keep running a copy taken first.
    tmp="$(mktemp "${TMPDIR:-/tmp}/cast-upgrade.XXXXXX")"
    cp "$source_file" "$tmp"
    chmod +x "$tmp"
    export CAST_UPGRADE_REEXEC=1
    export CAST_UPGRADE_ROOT="$root"
    exec bash "$tmp" "$@"
}

require_tools() {
    local node_version python_version

    if ! check_command git; then
        log_error "git is not installed"
        exit 1
    fi

    if ! check_command node; then
        log_error "Node.js is not installed (required: >= 18)"
        exit 1
    fi
    node_version="$(node -v | sed 's/^v//')"
    if version_ge "$node_version" "18.0.0"; then
        log_info "Node.js v$node_version"
    else
        log_error "Node.js v$node_version is too old. Required: >= 18"
        exit 1
    fi

    if ! check_command npm; then
        log_error "npm is not installed"
        exit 1
    fi

    if ! check_command python3; then
        log_error "Python 3 is not installed (required: >= 3.11)"
        exit 1
    fi
    python_version="$(python3 --version 2>&1 | awk '{print $2}')"
    if version_ge "$python_version" "3.11.0"; then
        log_info "Python $python_version"
    else
        log_error "Python $python_version is too old. Required: >= 3.11"
        exit 1
    fi

    if check_command uv; then
        UV_AVAILABLE=true
        log_info "$(uv --version)"
    else
        UV_AVAILABLE=false
        if ! check_command pip3; then
            log_error "pip3 is not installed, and uv is not available"
            exit 1
        fi
        log_info "Using pip (uv was not found)"
    fi
}

# tsc -b rewrites these caches. .gitignore already lists them, but checkouts
# from before #128 still track the files. A build then looks like a local edit,
# and the fast-forward that deletes them refuses to overwrite those changes.
generated_build_info_paths() {
    printf '%s\n' \
        typescript/cast-cli/tsconfig.tsbuildinfo \
        typescript/cast-tui/tsconfig.tsbuildinfo
}

is_generated_build_info() {
    local path="$1"
    local known

    while IFS= read -r known; do
        if [[ "$path" == "$known" ]]; then
            return 0
        fi
    done < <(generated_build_info_paths)
    return 1
}

# True when a tracked change is not one of the generated build info files.
changes_block_upgrade() {
    local path

    while IFS= read -r path; do
        [[ -n "$path" ]] || continue
        if ! is_generated_build_info "$path"; then
            return 0
        fi
    done < <(
        git -C "$ROOT" --no-pager diff --name-only HEAD
        git -C "$ROOT" --no-pager diff --name-only --cached
    )
    return 1
}

restore_generated_build_info() {
    local path restored=0

    while IFS= read -r path; do
        git -C "$ROOT" cat-file -e "HEAD:$path" 2>/dev/null || continue
        if git -C "$ROOT" diff --quiet HEAD -- "$path" \
            && git -C "$ROOT" diff --quiet --cached -- "$path"; then
            continue
        fi
        git -C "$ROOT" checkout HEAD -- "$path" </dev/null
        restored=1
    done < <(generated_build_info_paths)
    if [[ "$restored" -eq 1 ]]; then
        log_info "Reset tracked TypeScript build info. A build rewrites these files."
    fi
}

assert_clean_worktree() {
    local git_dir

    git_dir="$(git -C "$ROOT" rev-parse --git-dir)"
    if [[ -n "$(git -C "$ROOT" rev-parse -q --verify MERGE_HEAD 2>/dev/null || true)" \
        || -d "$git_dir/rebase-merge" \
        || -d "$git_dir/rebase-apply" ]]; then
        log_error "A merge or rebase is in progress. Finish it, then run upgrade again."
        exit 1
    fi

    if changes_block_upgrade; then
        log_error "This checkout has uncommitted changes. Commit or stash them, then run upgrade again."
        git -C "$ROOT" --no-pager diff --stat
        git -C "$ROOT" --no-pager diff --cached --stat
        exit 1
    fi

    # Match HEAD so the fast-forward that drops these files can delete them.
    restore_generated_build_info
}

# Fetch one remote branch into refs/remotes/origin/<branch>, ignoring the
# clone's fetch refspec. A checkout cloned when master was the default, or
# cloned with a master-only refspec, still learns about main.
# Returns 0 when the branch exists, 2 when it does not, and 1 on any other
# failure (the git message is printed).
fetch_upstream_branch() {
    local branch="$1"
    local err rc
    err="$(mktemp "${TMPDIR:-/tmp}/cast-upgrade-fetch.XXXXXX")"
    set +e
    git -C "$ROOT" fetch origin "+refs/heads/${branch}:refs/remotes/origin/${branch}" </dev/null >/dev/null 2>"$err"
    rc=$?
    set -e
    if [[ "$rc" -eq 0 ]]; then
        rm -f "$err"
        return 0
    fi
    if grep -qiE 'could not find remote ref|couldn.t find remote ref|remote ref does not exist' "$err"; then
        rm -f "$err"
        return 2
    fi
    cat "$err" >&2
    rm -f "$err"
    return 1
}

choose_target_branch() {
    local rc=0
    fetch_upstream_branch main || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        printf '%s\n' main
        return 0
    fi
    if [[ "$rc" -eq 1 ]]; then
        return 1
    fi
    rc=0
    fetch_upstream_branch master || rc=$?
    if [[ "$rc" -eq 0 ]]; then
        printf '%s\n' master
        return 0
    fi
    return "$rc"
}

# `git checkout --track origin/<branch>` only accepts a remote-tracking branch
# that matches remote.origin.fetch. A master-only clone does not match main,
# and a fetch spec for a deleted master makes a later plain `git fetch` fail.
ensure_branch_can_track() {
    local branch="$1"
    local specs
    specs="$(git -C "$ROOT" config --get-all remote.origin.fetch || true)"
    if printf '%s\n' "$specs" | grep -q 'refs/heads/\*'; then
        return 0
    fi
    if printf '%s\n' "$specs" | grep -q "refs/heads/${branch}:"; then
        return 0
    fi
    git -C "$ROOT" config --unset-all remote.origin.fetch || true
    git -C "$ROOT" config --add remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
}

# CAST_TRUSTED_KEY_FILE overrides the embedded key for tests and for an
# operator who pins a different release key. The default is the GitHub
# web commit signing key, also published at scripts/trusted-commit-key.asc.
write_trusted_key() {
    local dest="$1"

    if [[ -n "${CAST_TRUSTED_KEY_FILE:-}" ]]; then
        if [[ ! -f "$CAST_TRUSTED_KEY_FILE" ]]; then
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
    local rev="$1"
    local keyfile gpghome status

    if ! command -v gpg >/dev/null 2>&1; then
        log_error "gpg is required to verify the upstream commit. To continue, install gnupg and run this script again."
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
    GNUPGHOME="$gpghome" git -C "$ROOT" -c gpg.format=openpgp verify-commit "$rev" >/dev/null 2>&1
    status=$?
    set -euo pipefail
    rm -rf "$gpghome" "$keyfile"
    return "$status"
}

fast_forward() {
    local target current choose_rc=0

    if ! git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
        log_error "This checkout has no origin remote."
        exit 1
    fi

    log_info "Fetching origin..."
    target="$(choose_target_branch)" || choose_rc=$?
    if [[ "$choose_rc" -ne 0 || -z "$target" ]]; then
        if [[ "$choose_rc" -eq 2 ]]; then
            log_error "origin has neither main nor master."
        else
            log_error "Could not fetch origin. Check the network and this checkout's origin remote."
        fi
        exit 1
    fi

    if ! verify_signed_commit "origin/$target"; then
        log_error "Refusing to check out origin/$target. The commit is not signed by the trusted key."
        exit 1
    fi

    if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$target"; then
        if ! git -C "$ROOT" merge-base --is-ancestor "$target" "origin/$target"; then
            log_error "Local $target has commits that are not on origin/$target."
            log_info "Upgrade refused so those commits stay put. Nothing was rebuilt."
            exit 1
        fi
    fi

    ensure_branch_can_track "$target"

    current="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
    if [[ "$current" != "$target" && "$current" != "HEAD" ]]; then
        if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$current"; then
            if ! git -C "$ROOT" merge-base --is-ancestor "$current" "origin/$target"; then
                log_warn "Local $current has commits that are not on origin/$target. Those commits stay on $current."
            fi
        fi
    fi

    if [[ "$current" != "$target" ]]; then
        log_info "Switching from $current to $target"
        if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$target"; then
            if ! git -C "$ROOT" checkout "$target" </dev/null; then
                log_error "Could not switch to $target. The checkout was not rebuilt."
                exit 1
            fi
        else
            if ! git -C "$ROOT" checkout -b "$target" --track "origin/$target" </dev/null; then
                log_error "Could not switch to $target. The checkout was not rebuilt."
                exit 1
            fi
        fi
    fi

    if ! git -C "$ROOT" branch --set-upstream-to="origin/$target" "$target" >/dev/null 2>&1; then
        log_warn "Could not set $target to track origin/$target."
    fi

    if [[ "$(git -C "$ROOT" rev-parse HEAD)" == "$(git -C "$ROOT" rev-parse "origin/$target")" ]]; then
        log_info "Already on the newest $target commit ($(git -C "$ROOT" rev-parse --short HEAD)). Rebuilding in place."
    else
        log_info "Fast-forwarding $target to $(git -C "$ROOT" rev-parse --short "origin/$target")"
        if ! git -C "$ROOT" merge --ff-only "origin/$target" </dev/null; then
            log_error "Fast-forward failed. The checkout was not rebuilt."
            exit 1
        fi
    fi
}

install_node() {
    log_info "Installing Node.js dependencies..."
    (cd "$ROOT" && npm install --no-fund --no-audit </dev/null)
    (cd "$ROOT/typescript/cast-cli" && npm install --no-fund --no-audit </dev/null)
    (cd "$ROOT/typescript/cast-tui" && npm install --no-fund --no-audit </dev/null)
    log_success "Node.js dependencies installed"
}

build_typescript() {
    log_info "Building cast-cli..."
    (cd "$ROOT/typescript/cast-cli" && npm run build </dev/null)
    log_info "Building cast-tui..."
    (cd "$ROOT/typescript/cast-tui" && npm run build </dev/null)
    log_success "TypeScript projects built"
    # The rebuild rewrites tracked build info on checkouts that still have it
    # in git. Put those files back so the next upgrade is not blocked.
    restore_generated_build_info
}

install_python() {
    log_info "Installing Python dependencies..."
    (
        cd "$ROOT/python"
        if [[ "$UV_AVAILABLE" == true ]]; then
            if [[ ! -d .venv ]]; then
                uv venv
            fi
            uv pip install -e "."
            uv pip install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
        else
            if [[ ! -d .venv ]]; then
                python3 -m venv .venv
            fi
            # shellcheck disable=SC1091
            source .venv/bin/activate
            pip install -e "."
            pip install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
        fi
    )
    log_success "Python dependencies installed"
}

link_cast() {
    local cli="$ROOT/typescript/cast-cli/bin/run"
    local resolved=""

    if [[ ! -f "$ROOT/cast" ]]; then
        cat > "$ROOT/cast" << 'EOF'
#!/bin/bash
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -L "$0" ]; then
    SCRIPT_DIR="$(cd "$(dirname "$(readlink "$0")")" && pwd)"
fi
exec "$SCRIPT_DIR/typescript/cast-cli/bin/run" "$@"
EOF
        chmod +x "$ROOT/cast"
    fi

    mkdir -p "${HOME}/.local/bin"
    ln -sfn "$ROOT/cast" "${HOME}/.local/bin/cast"
    log_success "Linked ~/.local/bin/cast -> $ROOT/cast"

    if [[ -L /usr/local/bin/cast ]]; then
        resolved="$(resolve_symlink /usr/local/bin/cast || true)"
        case "$resolved" in
            "$ROOT"/*)
                if ln -sfn "$cli" /usr/local/bin/cast; then
                    log_success "Refreshed /usr/local/bin/cast"
                else
                    log_warn "Could not refresh /usr/local/bin/cast"
                fi
                ;;
        esac
    fi

    if [[ -f "${HOME}/.cast/bin/cast" ]]; then
        rm -f "${HOME}/.cast/bin/cast"
        log_info "Removed stale binary ~/.cast/bin/cast"
    fi
}

package_version() {
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
        "$ROOT/typescript/cast-cli/package.json" | head -n 1 || true
}

ROOT="$(locate_checkout || true)"
if [[ -z "$ROOT" ]]; then
    log_error "Could not find a Cast checkout."
    log_info "Run ./upgrade.sh from the repository, or install Cast so ~/.local/bin/cast points at it."
    exit 1
fi

maybe_reexec "$ROOT" "$@"

printf '%bCast upgrade%b — rebuild this checkout in place\n' "$BLUE" "$NC"
log_info "Checkout: $ROOT"

require_tools
assert_clean_worktree
fast_forward
install_node
build_typescript
install_python
link_cast

if ! check_command bun; then
    log_warn "Bun is not installed. The TUI needs it: https://bun.sh"
fi

VERSION="$(package_version)"
SHA="$(git -C "$ROOT" rev-parse --short HEAD)"

printf '\n'
log_success "Cast was rebuilt in place."
printf '  checkout: %s\n' "$ROOT"
printf '  commit:   %s\n' "$SHA"
printf '  version:  %s\n' "${VERSION:-unknown}"
printf '  command:  %s\n' "${HOME}/.local/bin/cast"
printf '\n'
printf 'Deployed agents are unchanged. Upgrade one with: cast upgrade <agent>\n'

exit 0
}
