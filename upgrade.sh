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

Fast-forward this Cast checkout to the newest origin/master commit
(origin/main when master is absent) and rebuild the CLI, TUI, and Python
runtime in place.

Leaves ~/.cast agents, config, and tokens untouched. Stops without rebuilding
when the checkout has uncommitted changes, or when the local upstream branch
has commits that cannot fast-forward.

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

assert_clean_worktree() {
    local git_dir

    git_dir="$(git -C "$ROOT" rev-parse --git-dir)"
    if [[ -n "$(git -C "$ROOT" rev-parse -q --verify MERGE_HEAD 2>/dev/null || true)" \
        || -d "$git_dir/rebase-merge" \
        || -d "$git_dir/rebase-apply" ]]; then
        log_error "A merge or rebase is in progress. Finish it, then run upgrade again."
        exit 1
    fi

    if ! git -C "$ROOT" diff --quiet || ! git -C "$ROOT" diff --cached --quiet; then
        log_error "This checkout has uncommitted changes. Commit or stash them, then run upgrade again."
        git -C "$ROOT" --no-pager diff --stat
        git -C "$ROOT" --no-pager diff --cached --stat
        exit 1
    fi
}

choose_target_branch() {
    if git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/master; then
        printf '%s\n' master
        return 0
    fi
    if git -C "$ROOT" show-ref --verify --quiet refs/remotes/origin/main; then
        printf '%s\n' main
        return 0
    fi
    return 1
}

fast_forward() {
    local target current

    if ! git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
        log_error "This checkout has no origin remote."
        exit 1
    fi

    log_info "Fetching origin..."
    if ! git -C "$ROOT" fetch origin </dev/null; then
        log_error "Could not fetch origin. Check the network and this checkout's origin remote."
        exit 1
    fi

    if ! target="$(choose_target_branch)"; then
        log_error "origin has neither master nor main."
        exit 1
    fi

    if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$target"; then
        if ! git -C "$ROOT" merge-base --is-ancestor "$target" "origin/$target"; then
            log_error "Local $target has commits that are not on origin/$target."
            log_info "Upgrade refused so those commits stay put. Nothing was rebuilt."
            exit 1
        fi
    fi

    current="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)"
    if [[ "$current" != "$target" ]]; then
        log_info "Switching from $current to $target"
        if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$target"; then
            git -C "$ROOT" checkout "$target" </dev/null
        else
            git -C "$ROOT" checkout -b "$target" --track "origin/$target" </dev/null
        fi
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
