# Cast Agent: Build and Deploy AI Agents

Cast Agent is a complete platform for creating, testing, and deploying autonomous AI agents. It combines an interactive CLI with a beautiful terminal UI to guide you through building agents that can reason, use tools, and operate independently. The project site is [castagent.dev](https://castagent.dev).

**Cast Agent transforms how developers build AI agents** — instead of writing boilerplate code, you describe what you want your agent to do, and Cast Agent handles the scaffolding, configuration, and deployment. Your agent becomes a production-ready A2A server that can be connected to from any client.

## Why Cast Agent?

- **Interactive Builder**: Describe your agent in plain language, get a fully scaffolded agent with proper instructions, tools, and configuration
- **Built-in Runtime**: Python-based runtime with A2A protocol support, streaming responses, and secure auth
- **Multiple Deployment Options**: Deploy to Docker, Railway, Fly.io, DigitalOcean, or Sprites with a single command
- **Production-Ready**: Automatic change tracking, semantic release management, secure token storage, OAuth credential vault, and deployment tracking
- **Agent Versioning**: Track every change to your agent with automatic snapshots, create intentional semantic releases, compare with diffs, and rollback to any state
- **GitHub Integration**: Full Git operations for agents—init, commit, push, pull, and branch management
- **Agent Memory**: Persistent memory system for agents to maintain context across sessions

## What Can You Build?

Agents you build with Cast Agent are flexible AI assistants that can be customized for virtually any task. Here are examples of agents you can create:

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

Describe what you want, and Cast Agent builds the complete agent scaffold with instructions, tools, and configuration ready for development.

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

**Upgrading / re-running install:**
Re-running `./install.sh` is the safe way to upgrade. The script is idempotent: it rebuilds the TypeScript projects, refreshes the `~/.local/bin/cast` symlink, and removes any stale binaries left over from older versions of Cast Agent (e.g. the pre-TypeScript Go binary that used to live at `~/.cast/bin/cast`). If you ever see the wrong version of `cast` running after a rebuild, re-run `./install.sh` — it will clear the conflict.

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

# Clone an agent from a Git repository, GitHub user/repo, or local directory
cast clone https://github.com/user/my-agent
cast clone https://github.com/user/my-agent my-local-name
cast clone user/my-agent
cast clone ./path/to/local-agent
cast clone /absolute/path/to/local-agent my-local-name

# Deploy an agent
cast deploy demo-agent --provider docker

# Shut down a deployed agent (destroy remote resources)
cast shutdown demo-agent

# Connect to deployed agent
cast connect demo-agent

# Update agent configuration
cast update demo-agent --model openrouter/anthropic/claude-3.7-sonnet

# Show or set the builder's model (not the model of an agent being created).
# A running builder does not hot-swap; start it again to apply.
cast model
cast model anthropic/claude-3.5-sonnet

# Delete agent
cast delete demo-agent --force

# Run meta-builder tests
cast meta test
```

### Deployment Providers

Cast Agent supports deploying agents to multiple platforms:

| Provider | Description | Command |
|----------|-------------|---------|
| **DigitalOcean** | Deploy to DigitalOcean Droplets (cloud VMs) | `cast deploy demo-agent --provider digitalocean` |
| **DigitalOcean MicroVM** | Firecracker microVM in MKC1. Pauses when idle and resumes on the next request. Public preview. | `cast deploy demo-agent --provider microvm` |
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

DigitalOcean MicroVMs (`--provider microvm`) are separate from Droplets. They are in public preview in region MKC1, run linux/amd64 images from DigitalOcean Container Registry, and pause when idle. The next request resumes a paused MicroVM. Cast Agent retries HTTP 503 while it wakes. The edge also closes a chat stream that sends no bytes for about 15 seconds, so the runtime sends a keepalive during long steps such as installing a skill. Redeploy to pick that up. `--with-tui` is rejected. The endpoint expects your DigitalOcean token on `Authorization` and the agent token on `X-Cast-Authorization`. If the edge does not forward that second header, rerun with `--edge-auth-only`. Logs are `doctl compute microvm exec <id> -- <log command>`. `doctl` 1.173.0 or newer is required.

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

### Agent versioning

Cast Agent tracks an agent with three independent concepts:

- **Undo log (internal)** — automatic, sequential snapshots taken on every edit. You don't manage this directly; you interact with it through `cast undo` / `cast redo`. The log also feeds `cast release`'s auto-changelog.
- **Releases** — intentional semantic versions (1.0, 1.5, 2.0) you create when you're ready to ship. Releases are the deployment artifact.
- **Sessions** — saved conversations tied to an agent. Connecting (`cast connect`, `/connect`, or the on-host TUI) starts a new session with an empty model context. Cast Agent auto-saves every chat turn into that session. Continuing an old conversation is an explicit resume (`cast session resume`, `/session resume`, or `/sessions`). You can also fork, rename, or audit conversations.

```bash
# Undo and redo (the user-facing surface of the change log)
cast undo my-agent
cast undo my-agent --steps 3
cast redo my-agent

# Releases
cast releases my-agent
cast release my-agent 1.6
cast release my-agent 1.6 --message "Added email parsing"

# Restore local files to a previous release
cast restore my-agent --release 1.0

# Sessions
cast session list
cast session new my-agent --name "auth experiment"
cast session resume <id|name>
cast session fork <id>
cast session export <id> --out backup.json
```

`cast connect` starts a new session. It does not continue the previous
conversation. Resume a saved session when you want the model to see
that transcript again.

In the TUI, use `/undo` and `/redo` for iteration, `/sessions` to
browse saved conversations (with a modal picker that follows the
AGENTS.md design standards), and `/release`, `/deploy`, `/upgrade`,
and `/shutdown` to manage releases and deployments interactively.
Restore a local agent with `cast restore <agent> --release <version>`.

To upgrade an existing deployment to a new release:

```bash
# Upgrade by agent name (uses most recent deployment)
cast upgrade my-agent --version 1.6

# Upgrade by deployment SHA (recommended for multi-deployment agents)
cast upgrade abc123 --version 1.6
```

#### TUI Slash Commands

Slash commands in the TUI use interactive modals for input — no need
to remember flag syntax. Every command works with no arguments; if
parameters are needed, a modal prompts for them.

Highlighting text with the mouse copies that selection to the clipboard.

| Command | Category | What it does |
|---------|----------|--------------|
| `/undo [steps]` | agent | Step back one (or N) changes. Shells out to `cast undo`. |
| `/redo [steps]` | agent | Step forward one (or N) changes. |
| `/skills [add <github-or-folder>]` | agent | Add or remove skills on this agent. Hidden in on-host. |
| `/sessions` | session | Modal picker over saved sessions. `Enter` or `R` resumes, `F` forks, `N` renames, `D` deletes. |
| `/session new [name]` | session | Start a fresh session and model context, and switch the chat to it. |
| `/session resume [id\|name]` | session | Replay a session's transcript into the chat and the model context. Opens the picker if no argument. |
| `/releases` | session | Shows semantic releases with `C` (Create Release) and `U` (Upgrade, if deployed) shortcuts. |
| `/release` | agent | Opens a modal to create a new semantic release. Suggests patch/minor/major versions based on the current release. |
| `/deploy` | agent | Release picker → provider picker → live deploy with SHA shown on success. |
| `/upgrade` | agent | Operates on the current agent. Modal lists releases to upgrade to. |
| `/shutdown` | agent | Lists active deployments (every provider) and shuts one down after Y/N. Streams `cast shutdown --force`. Dev and production only. |
| `/registry` | session | Modal table of all releases across all agents, with deployment status. |
| `/connect` | session | Recent deployments table with SHA, provider, and version. Pick a row or type a SHA directly. Connecting starts a new session for that agent. |
| `/import [source] [name]` | agent | Import a Cast agent from GitHub or a local path. |
| `/builder-skills [add <github-or-folder>]` | agent | Add or remove skills the builder uses when creating agents. Dev mode only. Applies on the next `cast new` or `cast edit`. |
| `/model` | agent | Change the model the builder uses. Dev mode only. Hidden in production and on-host. Applies on the next `cast dev`. |

### Git Integration

Cast Agent includes built-in Git support for version control:

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
  digitalocean_inference:
    api_key: ${DIGITALOCEAN_MODEL_ACCESS_KEY}
    default_base_url: https://inference.do-ai.run/v1
  digitalocean:
    token: ${DIGITALOCEAN_API_TOKEN}   # deploy only; not used for inference

# Optional external inference providers (paths or importable modules).
inferenceProviders:
  - ~/src/acme/provider.py
```

Set environment variables:
```bash
export OPENROUTER_API_KEY="your-key"
export DIGITALOCEAN_MODEL_ACCESS_KEY="your-model-access-key"
export RAILWAY_API_TOKEN="your-token"
export FLY_API_TOKEN="your-token"
export DO_API_TOKEN="your-token"  # DigitalOcean deploy token
```

### LLM providers

OpenRouter stays the default. The model string selects the inference provider. Both keys may be set; the prefix wins, and a missing key does not fall back to the other provider.

| Model string | Provider | API key | Base URL |
|---|---|---|---|
| `openrouter/...` or a bare alias | OpenRouter | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` |
| `digitalocean/<model-id>` | DigitalOcean serverless inference | `DIGITALOCEAN_MODEL_ACCESS_KEY` | `https://inference.do-ai.run/v1` |

The `digitalocean/` prefix is stripped and the catalog id is sent unchanged. It is not rewritten and is not given an `anthropic/` or `openai/` prefix. Starter ids: `llama3.3-70b-instruct`, `deepseek-v3.2`. Any other catalog id is accepted. `providers.digitalocean` is the deploy token for Droplets and MicroVMs, not this key.

```bash
cast update demo-agent --model digitalocean/llama3.3-70b-instruct
```

`cast model <id>` writes `defaults.builder_model` from the curated list (`cast model --list`). The builder reads that raw value when it starts. A running builder does not hot-swap; run `cast dev <agent>` again. `digitalocean/<model-id>` still selects DigitalOcean. The default remains `openrouter/minimax/minimax-m2.5`. The runtime, the builder, and memory reflection call `get_provider(model)` instead of naming a provider class.

Another inference provider can register without editing those callers. Put a folder at `~/.cast/inference-providers/<key>/` (`provider.json` and `provider.py`), list a module path under `inferenceProviders` in `~/.cast/config.yaml`, or publish a `cast.inference` entry point. Deployed agents receive whatever API keys the registry declares (`inferenceEnv()`), including external providers. `providers.digitalocean.token` is still only the deploy token.

## Documentation

The full user documentation lives in `docs-site/` and is built with
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
and deploys the site to GitHub Pages at [castagent.dev](https://castagent.dev).

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
