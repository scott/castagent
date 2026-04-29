# Cast: Agent Building & Deployment Platform

Cast is a CLI+TUI application that helps developers create, test, and deploy AI agents.

## Architecture

- **TypeScript CLI/TUI**: User-facing interface built with oclif and OpenTUI
- **Builder Agent**: Python/LangChain agent that helps users create new agents (stdio JSON-RPC)
- **Runtime Agents**: Python/LangChain agents created by users (A2A over HTTP)
- **Meta-Builder**: Test harness that verifies the Builder Agent works correctly

## Quick Start

### Prerequisites

- Node.js >= 18
- Python >= 3.11
- Bun (for OpenTUI - install from https://bun.sh)

### Installation

**Full installation** (recommended for first-time setup):
```bash
# Clone the repository
git clone <repo-url>
cd agent-cast

# Run the full installation script (installs deps, builds, creates config)
./install.sh

# Add to your PATH if needed (follow the instructions from install.sh)
export PATH="$HOME/.local/bin:$PATH"
```

**Quick setup** (if dependencies are already installed):
```bash
# Just create the global 'cast' command
./setup.sh

export PATH="$HOME/.local/bin:$PATH"
```

**Or manually:**
```bash
# Install dependencies
npm install
cd typescript/cast-cli && npm install
cd ../cast-tui && npm install
cd ../..

# Build
npm run build

# Create symlink
mkdir -p ~/.local/bin
ln -sf $(pwd)/cast ~/.local/bin/cast
export PATH="$HOME/.local/bin:$PATH"
```

### Usage

```bash
# Show help
cast --help

# List all agents
cast list

# Describe an agent's configuration
cast describe demo-agent

# Start an agent in development mode
cast dev demo-agent

# Start without TUI (headless)
cast dev demo-agent --no-tui

# View agent logs
cast logs demo-agent

# Stop a running agent
cast stop demo-agent

# Deploy an agent
cast deploy demo-agent --provider docker

# Connect to deployed agent
cast connect demo-agent

# Update agent configuration
cast update demo-agent --model openrouter/anthropic/claude-3.7-sonnet

# Delete agent
cast delete demo-agent --force

# Run meta-builder tests
cast meta test
```

### Updating Agent Configuration

The `cast update` command supports comprehensive agent configuration:

```bash
# Update the LLM model
cast update my-agent --model openrouter/anthropic/claude-3.7-sonnet

# Update description and version
cast update my-agent --description "My new description" --version 1.1.0

# Update system instructions inline
cast update my-agent --instructions-text "You are a helpful coding assistant."

# Or load instructions from a file
cast update my-agent --instructions ./new-prompt.md

# Manage built-in tools
cast update my-agent --add-tool bash --remove-tool glob

# Manage harness principles
cast update my-agent --add-principle "Be concise" --remove-principle "Be verbose"

# Manage permissions (levels: always-allow, ask, deny)
cast update my-agent --permission bash=always-allow --permission read=ask

# Manage Python runtime requirements
cast update my-agent --python-version 3.12 --add-requirement requests

# Preview changes without applying
cast update my-agent --model openrouter/openai/gpt-4o --dry-run
```

## Development

### Project Structure

```
agent-cast/
├── typescript/
│   ├── cast-cli/          # oclif CLI (commands, deploy, MCP, OAuth)
│   └── cast-tui/          # OpenTUI terminal interface
├── python/
│   └── cast/              # Python runtime (agents, providers, tools)
├── tests/
│   ├── ts/                # TypeScript tests
│   └── python/            # Python tests
├── docs/
│   └── SPEC.md            # Full specification
├── cast                   # Bash wrapper script (entry point)
├── setup.sh               # Quick setup (creates symlink only)
├── install.sh             # Full install (deps, build, config)
└── README.md              # This file
```

### Building

```bash
# Build TypeScript
npm run build

# Build CLI only
npm run build:cli

# Build TUI only
npm run build:tui
```

### Testing

```bash
# Run end-to-end test
./test.sh

# Run meta-builder tests
cast meta test

# Run specific scenario
cast meta test --scenario create-simple
```

## Features

### Implemented

- ✅ TypeScript CLI with oclif
- ✅ OpenTUI terminal interface
- ✅ Python Runtime Agent with A2A HTTP server
- ✅ Builder Agent with stdio JSON-RPC
- ✅ Built-in tools (bash, read, glob)
- ✅ MCP Manager (Gmail, Slack, Filesystem)
- ✅ OAuth flow (browser-based)
- ✅ OpenRouter LLM integration
- ✅ Anthropic LLM integration
- ✅ OpenAI LLM integration
- ✅ Ollama (local) LLM integration
- ✅ Docker deployment
- ✅ Railway deployment
- ✅ Fly.io deployment
- ✅ DigitalOcean App Platform deployment
- ✅ Streaming responses
- ✅ Production TUI mode (green theme)
- ✅ Agent configuration management
- ✅ SQLite database for agent metadata and deployments
- ✅ Secure auth token storage (keychain / system credential store)
- ✅ OAuth credential vault (~/.cast/vault/)
- ✅ Meta-builder test framework

### The `cast` Wrapper Script

The `cast` command at the repository root is a bash wrapper that delegates to `typescript/cast-cli/bin/run`. When you run `./setup.sh` or `./install.sh`, it creates a symlink from `~/.local/bin/cast` to this wrapper, making the CLI available globally.

## Configuration

Create `~/.cast/config.yaml`:

```yaml
cast:
  version: "1.0"

defaults:
  agent_storage: ~/cast-agents
  builder_model: openrouter/anthropic/claude-4-sonnet
  deployment_provider: docker

providers:
  openrouter:
    api_key: ${OPENROUTER_API_KEY}
    default_base_url: https://openrouter.ai/api/v1
```

Set environment variables:
```bash
export OPENROUTER_API_KEY="your-key"
export RAILWAY_API_TOKEN="your-token"
export FLY_API_TOKEN="your-token"
export DO_API_TOKEN="your-token"  # DigitalOcean
```

## License

Apache License 2.0
