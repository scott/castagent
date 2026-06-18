# Agent Cast: Build and Deploy AI Agents

Agent Cast is a complete platform for creating, testing, and deploying autonomous AI agents. It combines an interactive CLI with a beautiful terminal UI to guide you through building agents that can reason, use tools, and operate independently.

**Cast transforms how developers build AI agents** — instead of writing boilerplate code, you describe what you want your agent to do, and Cast handles the scaffolding, configuration, and deployment. Your agent becomes a production-ready A2A server that can be connected to from any client.

## Why Agent Cast?

- **Interactive Builder**: Describe your agent in plain language, get a fully scaffolded agent with proper instructions, tools, and configuration
- **Built-in Runtime**: Python-based runtime with A2A protocol support, streaming responses, and secure auth
- **Multiple Deployment Options**: Deploy to Docker, Railway, Fly.io, DigitalOcean, or Sprites with a single command
- **Production-Ready**: Automatic change tracking, semantic release management, secure token storage, OAuth credential vault, and deployment tracking
- **Agent Versioning**: Track every change to your agent with automatic snapshots, create intentional semantic releases, compare with diffs, and rollback to any state
- **GitHub Integration**: Full Git operations for agents—init, commit, push, pull, and branch management
- **Agent Memory**: Persistent memory system for agents to maintain context across sessions

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
curl -sL https://raw.githubusercontent.com/scott/castagent/main/install.sh | bash
```

**Full installation** (recommended for first-time setup):
```bash
# Clone the repository
git clone https://github.com/scott/castagent.git
cd castagent

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

# Show version
cast version

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

# Rename an agent
cast rename old-name new-name

# Clone an agent from Git repository
cast clone https://github.com/user/my-agent
cast clone https://github.com/user/my-agent my-local-name

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

### Chatting On-Host (Docker container shell)

By default, DigitalOcean-deployed agents are **lean** — the image only
contains what's needed to run the A2A server, not the on-host TUI. To
get the bundled `cast-tui` command in the container, deploy with
`--with-tui`:

```bash
cast deploy demo-agent --provider digitalocean --with-tui
```

With the TUI bundled, you can reach the container and run `cast-tui`
to open a chat session that talks directly to the A2A server on
`localhost:8080`:

```bash
# SSH into the droplet (or use the DO web console)
ssh -i ~/.ssh/cast_do_key root@<droplet-ip>

# Enter the agent container
docker exec -it cast-agent bash

# Launch the on-host chat TUI
cast-tui
```

The on-host TUI is functionally identical to `cast connect` — streaming
responses, slash commands, and production-mode chat. No public network
exposure, no bearer token sent over the wire. The chat runs entirely inside
the container.

If the TUI bundle is unavailable or a JS runtime is missing, a Python REPL
fallback is used automatically instead. Run `cast-tui` and it will use
whichever is available.

> **Security note:** Anyone with the SSH key and droplet IP who can
> `docker exec` into the container can also run `cast-tui` with the
> agent's `AUTH_TOKEN` (inherited from the container environment). Keep
> the key at `~/.ssh/cast_do_key` secured. This matches the existing
> privilege model — the SSH key already grants full root access to the
> droplet.

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

Cast tracks two kinds of versions for your agent:

- **Changes** — automatic, sequential snapshots (v1, v2, v3…) taken whenever the agent is modified. Use these for debugging, diffing, and rollback during development.
- **Releases** — intentional semantic versions (1.0, 1.5, 2.0) you create when you're ready to ship. Releases are the deployment artifact.

```bash
# List all automatic changes
cast changes my-agent

# List all releases
cast releases my-agent

# Create a new semantic release
cast release my-agent 1.6
cast release my-agent 1.6 --message "Added email parsing"

# Restore local files to a previous change or release
cast restore my-agent --change 5
cast restore my-agent --release 1.0

# Compare two changes
cast diff my-agent --change 1 --change 3
```

In the TUI, use `/changes` and `/releases` to view the respective histories with keyboard navigation, or `/release`, `/deploy`, `/upgrade`, and `/restore` to manage releases and deployments interactively.

To upgrade an existing deployment to a new release:

```bash
# Upgrade by agent name (uses most recent deployment)
cast upgrade my-agent --version 1.6

# Upgrade by deployment SHA (recommended for multi-deployment agents)
cast upgrade abc123 --version 1.6
```

#### TUI Slash Commands

Slash commands in the TUI use interactive modals for input — no need to remember flag syntax. Every command works with no arguments; if parameters are needed, a modal prompts for them.

| Command | Category | What it does |
|---------|----------|--------------|
| `/changes` | session | Shows the automatic change history with per-item Restore (`R`) and Diff (`D`) actions. |
| `/releases` | session | Shows semantic releases with `C` (Create Release) and `U` (Upgrade, if deployed) shortcuts. |
| `/release` | agent | Opens a modal to create a new semantic release. Suggests patch/minor/major versions based on the current release. |
| `/deploy` | agent | Release picker → provider picker → live deploy with SHA shown on success. |
| `/upgrade` | agent | Operates on the current agent. Modal lists releases to upgrade to. |
| `/restore` | agent | Source picker (Changes or Releases) → item picker → confirmation. Use `--change N` or `--release V` to skip the picker. |
| `/diff` | agent | Pick a kind (Changes or Releases) and two items, then see the diff inline. |
| `/registry` | session | Modal table of all releases across all agents, with deployment status. |
| `/connect` | session | Recent deployments table with SHA, provider, and version. Pick a row or type a SHA directly. |

### Git Integration

Cast agents include built-in Git support for version control:

```bash
# Initialize a Git repository
cast git init my-agent

# Check status
cast git status my-agent

# Stage and commit changes
cast git add my-agent -A
cast git commit my-agent -m "Update instructions"

# Push to remote
cast git push my-agent

# View commit history
cast git log my-agent

# View changes
cast git diff my-agent

# Manage remotes
cast git remote my-agent add origin https://github.com/user/repo.git
cast git remote my-agent list
```

## Development

### Project Structure

```
castagent/
├── typescript/
│   ├── cast-cli/          # oclif CLI (commands, deploy, MCP, OAuth)
│   └── cast-tui/          # OpenTUI terminal interface
├── python/
│   └── cast/              # Python runtime (agents, providers, tools)
├── tests/
│   ├── ts/                # TypeScript tests
│   └── python/            # Python tests
├── docs/
│   ├── SPEC.md            # Full specification
│   └── site/              # Documentation site (Astro, auto-generated)
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

### Continuous Integration

Every push to `master` and every pull request runs the **Test Coverage** workflow (`.github/workflows/test.yml`):

- **TypeScript tests with coverage** — Node 18.x and 20.x in parallel, with `nyc` instrumentation and `tsc --noEmit` type checking.
- **Python tests with coverage** — Python 3.11 and 3.12. The `pip install` step intentionally installs only test tooling; runtime deps (`pyyaml`, `langchain-core`) are tracked separately and the Python test step is `continue-on-error` until that lands.
- **Quality checks** — `tsc --noEmit`, `ruff`/`flake8` linting, and `mypy` type checking on the same Python 3.11 + Node 20 runner.
- **Coverage Summary** — downloads the matrix artifacts and posts a sticky PR comment summarising per-language coverage runs. The comment is updated in place on subsequent runs (it is identified by an HTML marker, so only one coverage comment accumulates per PR).
- **Coverage Threshold Check** — enforces the `COVERAGE_THRESHOLD` env var (default 70%). Skipped on PRs by default; opt in by including `[enforce-coverage]` in the PR title or commit message, or by pushing to `master`.
- **Build Verification** — runs `npm run build` to confirm the TypeScript projects still produce their `dist/` artifacts.

## Configuration

The `cast` command at the repository root is a bash wrapper that delegates to `typescript/cast-cli/bin/run`. When you run `./setup.sh` or `./install.sh`, it creates a symlink from `~/.local/bin/cast` to this wrapper, making the CLI available globally.

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

## Documentation

The full user documentation lives in `docs/site/` and is built with
[Astro](https://astro.build). The CLI command reference, TUI slash-command
reference, deployment provider pages, and changelog are **auto-extracted
from source on every build**, so the docs cannot drift from the code.

```bash
# Install + dev server (auto-extracts reference data on every reload)
npm --prefix docs-site install
npm --prefix docs-site run dev

# Production build (writes docs-site/dist/)
npm run docs:build

# CI check: diff the regenerated manifest against the committed baseline
# and fail on any unresolved {% ref %} targets
npm run docs:check
```

A pull request that adds, removes, or renames a CLI command, TUI slash
command, deployment provider, or known model surfaces a manifest diff as
a PR comment via `.github/workflows/docs.yml`. The `master` branch builds
and deploys the site to GitHub Pages at
`https://<owner>.github.io/<repo>/`. The workflow derives the site URL
and base path from the GitHub repo name, so renames "just work".

## Versioning

We use [changesets](https://github.com/changesets/changesets) for automated version management. All packages in the monorepo share a unified version.

### Workspace Packages

The monorepo is a private root `castagent` workspace. The versioned, published packages are:

- `cast-cli` — `typescript/cast-cli/`
- `cast-tui` — `typescript/cast-tui/`

Both are bumped together in lockstep (changesets `fixed: [["*"]]` config) and share a single version line.

### Making a Change

You do **not** need to hand-author a changeset. When a PR is merged to `master` (or `main`), the `Auto Create Changeset` workflow automatically generates a changeset file from:

- The PR's labels (`major` / `breaking`, `minor` / `feature` / `enhancement`, `fix` / `bugfix` / `hotfix`) and/or
- Conventional commit prefixes in the PR title (`feat:`, `fix:`, `BREAKING CHANGE:`)

The generated changeset targets both `cast-cli` and `cast-tui` at the determined bump level.

If you prefer to author a changeset by hand, you can still do so:

1. Make your changes in a feature branch
2. Run `npx changeset` to describe your change
3. Commit the changeset file along with your code
4. Open a PR with your changeset

When writing a changeset by hand, use the workspace package names (`cast-cli`, `cast-tui`), not the root `castagent` workspace name — the root package is private and not a changeset target.

### Changeset Prompt Guide

When running `npx changeset`:
- **Package**: Select `*` (all packages — unified versioning)
- **Bump type**:
  - `patch` — Bug fixes (0.1.0 → 0.1.1)
  - `minor` — New features (0.1.0 → 0.2.0)
  - `major` — Breaking changes (0.1.0 → 1.0.0)
- **Summary**: Brief description of the change

### Release Process

1. PR with changeset merged to `main`/`master`
2. GitHub Actions workflow automatically:
   - Bumps version in all package.json files (`cast-cli`, `cast-tui`)
   - Updates `CHANGELOG.md` files
   - Creates a git tag (e.g., `v0.2.0`)
   - Creates a GitHub Release
3. No manual version bumping required

## License

Apache License 2.0
