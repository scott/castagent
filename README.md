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

```bash
# Clone the repository
git clone <repo-url>
cd agent-cast

# Run the setup script (creates global 'cast' command)
./setup.sh

# Add to your PATH if needed (follow the instructions from setup.sh)
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

# Start an agent in development mode
cast dev demo-agent

# Start without TUI (headless)
cast dev demo-agent --no-tui

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
│   ├── cast-cli/          # oclif CLI
│   └── cast-tui/          # OpenTUI TUI
├── python/
│   └── cast/              # Python runtime
├── tests/
│   ├── ts/                # TypeScript tests
│   └── python/            # Python tests
├── docs/
│   └── SPEC.md            # Full specification
├── cast                   # Wrapper script
├── setup.sh               # Quick setup script
├── install.sh             # Full installation script
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
- ✅ Docker deployment
- ✅ Railway/Fly.io/DigitalOcean deployment stubs
- ✅ Streaming responses
- ✅ Production TUI mode (green theme)
- ✅ Auth token storage (keychain)
- ✅ Agent configuration management
- ✅ Meta-builder test framework

## Configuration

Create `~/.cast/config.yaml`:

```yaml
cast:
  version: "1.0"

defaults:
  agent_storage: ~/cast-agents
  builder_model: openrouter/anthropic/claude-sonnet-4
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
```

## License

Apache License 2.0
