# Agent Cast: Build and Deploy AI Agents

Agent Cast is a complete platform for creating, testing, and deploying autonomous AI agents. It combines an interactive CLI with a beautiful terminal UI to guide you through building agents that can reason, use tools, and operate independently.

**Cast transforms how developers build AI agents** — instead of writing boilerplate code, you describe what you want your agent to do, and Cast handles the scaffolding, configuration, and deployment. Your agent becomes a production-ready A2A server that can be connected to from any client.

## Why Agent Cast?

- **Interactive Builder**: Describe your agent in plain language, get a fully scaffolded agent with proper instructions, tools, and configuration
- **Built-in Runtime**: Python-based runtime with A2A protocol support, streaming responses, and secure auth
- **Multiple Deployment Options**: Deploy to Docker, Railway, Fly.io, DigitalOcean, or Sprites with a single command
- **Production-Ready**: Automatic versioning, secure token storage, OAuth credential vault, and deployment tracking

## What Can You Build?

Cast agents are flexible AI assistants that can be customized for virtually any task. Here are examples of agents you can create:

**Developer Agents**
- Code review assistant — reviews PRs, suggests improvements, checks style
- Debugging partner — analyzes errors, traces issues, proposes fixes
- Documentation writer — generates API docs, README files, code comments

**Business Agents**
- Customer support agent — answers questions, handles tickets, escalates issues
- Data analyst — queries databases, generates reports, creates visualizations
- Meeting scheduler — coordinates calendars, sends invites, handles conflicts

**Productivity Agents**
- Email assistant — drafts responses, summarizes threads, manages inbox
- Research assistant — finds information, summarizes papers, extracts insights
- File organizer — categorizes documents, renames files, manages storage

**Communications Agents**
- Slack bot — responds to mentions, runs commands, posts updates
- Newsletter writer — curates content, writes summaries, formats for delivery
- Social media manager — schedules posts, monitors mentions, engages followers

Create any agent with:
```bash
cast new
```

Describe what you want, and Cast builds the complete agent scaffold with instructions, tools, and configuration ready for development.

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

**One-liner** (when repository is public):
```bash
curl -sL https://raw.githubusercontent.com/scott/agent-cast/main/install.sh | bash
```

**Full installation** (recommended for first-time setup):
```bash
# Clone the repository
git clone https://github.com/scott/agent-cast.git
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

# Create a new agent (interactive TUI wizard)
cast new

# List all agents
cast list

# Describe an agent's configuration
cast describe demo-agent

# Edit an existing agent (interactive TUI wizard)
cast edit demo-agent

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

# Shut down a deployed agent (destroy remote resources)
cast shutdown demo-agent

# Connect to deployed agent
cast connect demo-agent

# Update agent configuration
cast update demo-agent --model openrouter/anthropic/claude-3.7-sonnet

# Delete agent
cast delete demo-agent --force

# Run meta-builder tests
cast meta test
```

### Deployment Providers

Cast supports deploying agents to multiple platforms:

| Provider | Description | Command |
|----------|-------------|---------|
| **DigitalOcean** | Deploy to DigitalOcean Droplets (cloud VMs) | `cast deploy demo-agent --provider digitalocean` |
| **Docker** | Containerized deployment to any Docker host | `cast deploy demo-agent --provider docker` |
| **Railway** | Deploy to Railway's cloud platform | `cast deploy demo-agent --provider railway` |
| **Fly.io** | Deploy to Fly.io's global edge network | `cast deploy demo-agent --provider fly` |
| **Sprites** | Firecracker VMs on Fly.io (lightweight, fast) | `cast deploy demo-agent --provider sprites` |

Each provider handles the complete deployment lifecycle including building, provisioning, and configuration. After deployment, connect to your running agent with:

```bash
cast connect demo-agent
```

To shut down and clean up resources:
```bash
cast shutdown demo-agent
```

### Creating a New Agent

The `cast new` command launches an interactive TUI wizard that guides you through creating a new agent:

```bash
# Launch the agent creation wizard
cast new
```

The Builder Agent will:
1. Ask what your agent should do
2. Suggest an available name based on your description
3. Create the agent scaffold (agent.yaml, instructions.md, tools/, mcp/, tests/)
4. Write meaningful initial instructions
5. Offer to configure MCP integrations and model settings

After creation, start your agent with:
```bash
cast dev <agent-name>
```

### Editing an Existing Agent

The `cast edit` command loads an existing agent into the interactive Builder TUI, allowing you to modify its configuration, instructions, tools, and MCP integrations through conversation:

```bash
# Edit an existing agent
cast edit my-agent
```

While inside any TUI session (including `cast dev` or `cast new`), you can also use the slash command:

```
/edit my-agent
```

Or, to pick from a list of all agents:

```
/edit
```

The Builder Agent will load your agent's current configuration and welcome you with suggestions for what you can change.

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

### Agent Versioning

Cast automatically versions your agent whenever changes are made (via CLI, edit command, or builder agent). Each version captures a snapshot of `agent.yaml`, `instructions.md`, and MCP configurations.

```bash
# List all versions of an agent
cast versions my-agent

# Compare two versions
cast diff my-agent 1 3

# Revert to a specific version (creates a new version first for safety)
cast revert my-agent 2
cast revert my-agent        # Revert to latest version
```

In the TUI, use `/versions` to view version history with keyboard navigation.

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
- ✅ Builder Agent tools (create_agent, update_agent_config, update_instructions, install_mcp, list_agents, get_agent_config, read_file, recommend_model, suggest_name)
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
- ✅ Agent shutdown / undeploy
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
  agent_storage: ~/.cast/agents
  builder_model: openrouter/minimax/minimax-m2.5
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
