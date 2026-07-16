#!/bin/bash

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_NAME="Cast"

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

# Check pip
if check_command pip3; then
    PIP_VERSION=$(pip3 --version | awk '{print $2}')
    log_info "pip found: v$PIP_VERSION"
else
    log_warn "pip3 not found. Attempting to install..."
    python3 -m ensurepip --upgrade 2>/dev/null || {
        log_error "Failed to install pip"
        log_info "Please install pip manually: https://pip.pypa.io/en/stable/installation/"
        exit 1
    }
fi

# Check UV (optional but recommended)
UV_AVAILABLE=false
if check_command uv; then
    UV_VERSION=$(uv --version)
    log_info "UV found: $UV_VERSION"
    UV_AVAILABLE=true
else
    log_warn "UV not found. UV is recommended for Python dependency management"
    log_info "Install UV: curl -LsSf https://astral.sh/uv/install.sh | sh"
    log_info "Continuing with pip..."
fi

echo ""

# ============================================
# CREATE DIRECTORIES
# ============================================
log_info "Creating directories..."

mkdir -p "$HOME/.cast"
mkdir -p "$HOME/.cast/vault"
mkdir -p "$HOME/.cast/tokens"
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
npm install

# Install CLI dependencies
log_info "Installing cast-cli dependencies..."
cd "$SCRIPT_DIR/typescript/cast-cli"
npm install

# Install TUI dependencies
log_info "Installing cast-tui dependencies..."
cd "$SCRIPT_DIR/typescript/cast-tui"
npm install

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
npm run build

# Build TUI
log_info "Building cast-tui..."
cd "$SCRIPT_DIR/typescript/cast-tui"
npm run build

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
    # Check if we can create a global symlink
    if [ -w "/usr/local/bin" ] || [ -w "$HOME/.local/bin" ]; then
        if [ -w "/usr/local/bin" ]; then
            ln -sf "$CLI_PATH" /usr/local/bin/cast
            log_success "Created symlink: /usr/local/bin/cast"
        else
            mkdir -p "$HOME/.local/bin"
            ln -sf "$CLI_PATH" "$HOME/.local/bin/cast"
            log_success "Created symlink: $HOME/.local/bin/cast"
            
            # Check if ~/.local/bin is in PATH
            if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
                log_warn "$HOME/.local/bin is not in your PATH"
                log_info "Add this to your shell profile:"
                log_info "  export PATH=\"\$HOME/.local/bin:\$PATH\""
            fi
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

# Check for required env vars
MISSING_VARS=()

if [ -z "$OPENROUTER_API_KEY" ]; then
    MISSING_VARS+=("OPENROUTER_API_KEY")
fi

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    log_warn "Some environment variables are not set:"
    for var in "${MISSING_VARS[@]}"; do
        log_warn "  - $var"
    done
    
    echo ""
    log_info "Add these to your shell profile (e.g., ~/.bashrc, ~/.zshrc):"
    for var in "${MISSING_VARS[@]}"; do
        if [ "$var" = "OPENROUTER_API_KEY" ]; then
            log_info "  export OPENROUTER_API_KEY='your-key-here'"
        fi
    done
    
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
    
    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        log_warn "~/.local/bin is not in your PATH"
        log_info "Add this to your shell profile:"
        log_info '  export PATH="$HOME/.local/bin:$PATH"'
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
echo "  cast <agent-name>            # Create or run an agent"
echo "  cast <agent-name> dev        # Start agent in development mode"
echo "  cast --help                  # Show help"
echo ""

log_info "Project structure:"
echo "  ~/.cast/                     # Global state and config"
echo "  ~/.cast/agents/              # Your agents"
echo "  $SCRIPT_DIR                  # Project files"
echo ""

log_info "Next steps:"
echo "  1. Set up your API keys in ~/.cast/config.yaml or as env vars"
echo "  2. Create your first agent: cast my-first-agent"
echo "  3. Start developing: cast my-first-agent dev"
echo ""

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
    log_warn "Don't forget to set your environment variables!"
fi

log_info "For more information, see: $SCRIPT_DIR/docs/SPEC.md"
echo ""
