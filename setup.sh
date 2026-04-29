#!/bin/bash

# Quick setup script for Cast
# This creates the global 'cast' command without reinstalling dependencies

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Setting up Cast CLI..."

# Create wrapper script
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
    echo "✓ Created wrapper script"
fi

# Create symlink
mkdir -p "$HOME/.local/bin"
if [ -L "$HOME/.local/bin/cast" ]; then
    rm "$HOME/.local/bin/cast"
fi
ln -sf "$SCRIPT_DIR/cast" "$HOME/.local/bin/cast"
echo "✓ Created symlink: ~/.local/bin/cast"

# Check if ~/.local/bin is in PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
    echo ""
    echo "⚠️  ~/.local/bin is not in your PATH"
    echo "Add this to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
    echo ""
    echo '    export PATH="$HOME/.local/bin:$PATH"'
    echo ""
    echo "Then reload your shell:"
    echo "    source ~/.bashrc  # or ~/.zshrc"
    echo ""
fi

echo "✅ Cast is now installed!"
echo ""
echo "Try it out:"
echo "    cast --help"
echo "    cast list"
echo "    cast dev demo-agent"
echo ""
