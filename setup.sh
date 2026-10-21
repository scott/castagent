#!/bin/bash

# Contributor setup for a checkout.
# Creates python/.venv with the runtime packages cast dev imports.
# Does not install Node dependencies or build the CLI.
# Does not change ~/.local/bin/cast unless --link is passed.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LINK_CAST=0

usage() {
    echo "Usage: ./setup.sh [--link]"
    echo ""
    echo "Creates python/.venv and installs the Cast runtime packages."
    echo "Does not run npm ci or npm run build."
    echo ""
    echo "  --link  Point ~/.local/bin/cast at this checkout."
    echo "          Without --link, an existing cast command is left unchanged."
}

for arg in "$@"; do
    case "$arg" in
        --link)
            LINK_CAST=1
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $arg"
            usage
            exit 1
            ;;
    esac
done

install_python_env() {
    local pyroot="$SCRIPT_DIR/python"

    if [ ! -f "$pyroot/pyproject.toml" ]; then
        echo "Python project not found at $pyroot"
        exit 1
    fi

    if ! command -v python3 >/dev/null 2>&1 && ! command -v uv >/dev/null 2>&1; then
        echo "python3 is required to create python/.venv"
        exit 1
    fi

    echo "Setting up Python environment in python/.venv..."
    (
        cd "$pyroot"
        if command -v uv >/dev/null 2>&1; then
            if [ ! -d .venv ]; then
                uv venv
            fi
            uv pip install -e "."
            uv pip install langchain langchain-anthropic langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
        else
            if [ ! -d .venv ]; then
                if ! python3 -m venv .venv; then
                    echo "Could not create python/.venv. On Debian and Ubuntu, install python3-venv and run ./setup.sh again."
                    exit 1
                fi
            fi
            # shellcheck disable=SC1091
            . .venv/bin/activate
            pip install -e "."
            pip install langchain langchain-anthropic langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
        fi
    )
    echo "Python environment ready at python/.venv"
}

link_cast() {
    local dest="$HOME/.local/bin/cast"
    local target="$SCRIPT_DIR/cast"

    if [ "$LINK_CAST" != 1 ]; then
        if [ -L "$dest" ]; then
            echo "Left ~/.local/bin/cast pointing at $(readlink "$dest")."
        elif [ -e "$dest" ]; then
            echo "Left ~/.local/bin/cast in place."
        else
            echo "Did not create ~/.local/bin/cast."
        fi
        echo "Pass --link to point ~/.local/bin/cast at this checkout ($target)."
        return 0
    fi

    mkdir -p "$HOME/.local/bin"
    if [ -L "$dest" ]; then
        local previous
        previous="$(readlink "$dest")"
        ln -sfn "$target" "$dest"
        echo "Replaced ~/.local/bin/cast."
        echo "  was: $previous"
        echo "  now: $target"
    elif [ -e "$dest" ]; then
        ln -sfn "$target" "$dest"
        echo "Replaced ~/.local/bin/cast with a link to $target."
    else
        ln -sfn "$target" "$dest"
        echo "Linked ~/.local/bin/cast -> $target"
    fi

    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        echo ""
        echo "~/.local/bin is not in your PATH."
        echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        echo ""
        echo '    export PATH="$HOME/.local/bin:$PATH"'
        echo ""
        echo "Then reload your shell:"
        echo "    source ~/.bashrc  # or ~/.zshrc"
        echo ""
    fi
}

echo "Setting up the Cast Python environment..."

# The checkout wrapper is local to this repo. It is not the global cast command.
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
    echo "Created checkout wrapper: $SCRIPT_DIR/cast"
fi

install_python_env
link_cast

echo ""
echo "This script does not install Node dependencies or build the CLI."
echo "From this checkout, run:"
echo "    npm ci"
echo "    npm run build"
echo "    ./cast dev <agent>"
echo ""
