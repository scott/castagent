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

**One-liner** (macOS and Linux):
```bash
curl -sL https://raw.githubusercontent.com/scott/castagent/main/install.sh | bash
```

Installs git, Node.js 20.20.2, Python 3.12, and Bun 1.4.3 when they are missing, clones the signed `main` commit into `~/.cast/castagent`, builds Cast, and links `cast`. Node, uv, and Bun are pinned archives. `install-checksums.txt` is checked before each archive is unpacked. The one-liner runs `install.sh` from that checkout and does not download `install.sh` again. On Linux it also installs a C compiler, unzip, libsecret, and gnupg. On macOS it installs gnupg with Homebrew when `gpg` is missing. A second run rebuilds the checkout it already has and does not fetch new commits. Use `./upgrade.sh` from the checkout to update. When it finishes, it prints `cast new` to create an agent and `cast dev <agent>` to run it. Guides are at [castagent.dev](https://castagent.dev).

**Full installation** (clone it yourself):
```bash
# Clone the repository
git clone https://github.com/scott/castagent.git
cd castagent

# Run the full installation script (installs deps, builds, creates config)
./install.sh

# Add to your PATH if needed (follow the instructions from install.sh)
export PATH="$HOME/.local/bin:$PATH"
```

**Quick setup** (contributor checkout, including a pull request branch):
```bash
npm ci
npm run build
./setup.sh
./cast dev <agent>
```

`./setup.sh` creates `python/.venv` with the runtime packages `cast dev` imports. It does not install Node dependencies, build the CLI, or change `~/.local/bin/cast`. Pass `--link` to point that command at this checkout. The script prints the previous target when it replaces one. `npm ci` and `npm run build` leave the virtualenv uncreated, and `cast dev` then falls back to system `python3` and exits with `ModuleNotFoundError: No module named 'langchain_core'`. `./upgrade.sh` fast-forwards to a commit signed by the trusted key, so a pull request branch uses `./setup.sh` instead.

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

# Python runtime for cast dev. ./setup.sh does this as well.
cd python
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
pip install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
```

**Upgrading the Cast checkout:**
```bash
./upgrade.sh
```

`upgrade.sh` moves this checkout onto the newest `origin/main` commit and rebuilds the CLI, TUI, and Python runtime in place. It refuses that commit unless the signature matches the trusted key shipped in the script (`scripts/trusted-commit-key.asc`, GitHub's web commit signing key). An unsigned commit stays where it is and nothing is rebuilt. If `gpg` is not on `PATH`, upgrade stops and tells you to install gnupg. It does not describe that commit as unsigned. A checkout on any branch is switched, including local `master` that tracks `origin/master`. `origin/master` is used only when the remote has no `main` branch. Agents, config, and tokens under `~/.cast` stay in place. A stale pre-TypeScript binary at `~/.cast/bin/cast` is removed so it cannot shadow the rebuilt CLI.

An agent that still stores its history in `.cast/versions/` (the layout from before 1.1.0) should be updated with Cast 2.5.1 before this upgrade. The changelog names that step. Opening the database and creating an agent do not depend on that old command.

Tracked TypeScript build info (`typescript/cast-cli/tsconfig.tsbuildinfo` and `typescript/cast-tui/tsconfig.tsbuildinfo`) is reset. `tsc -b` rewrites those files, and checkouts from before they were removed from git still track them, so a build would otherwise look like a local edit and block the fast-forward. Any other uncommitted change stops the upgrade before it rebuilds. The script also stops when the local upstream branch has commits that cannot fast-forward. Commits that exist only on the branch you were on stay on that branch. It does not upgrade a deployed agent. That command is still `cast upgrade <agent>`.

A checkout created before the default branch was `main` can still contain the older `upgrade.sh`, which follows `origin/master` and reports that it is already current. Run the current script instead. It finds the checkout through `~/.local/bin/cast` or the `cast` command on `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/scott/castagent/main/upgrade.sh | bash
```

Re-running `./install.sh` rebuilds the current checkout and refreshes the symlink without fetching. Use `./upgrade.sh` to move to the newest version and rebuild. If the wrong `cast` still runs afterwards, `./upgrade.sh` clears a stale `~/.cast/bin/cast` binary.

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

# Describe an agent's configuration.
# Custom tools print as the string entry or the path field.
cast describe demo-agent

# Edit an existing agent (interactive TUI wizard)
cast edit demo-agent

# Start an agent in development mode
cast dev demo-agent

# Start without TUI (headless)
cast dev demo-agent --no-tui

# View agent logs (local runtime output, or Docker container logs)
cast logs demo-agent

# Stop a running local agent, a Docker container on this machine, or the
# container on a DigitalOcean droplet. The deployment and its memory stay.
# cast shutdown removes them.
cast stop demo-agent

# Rename an agent
cast rename old-name new-name

# Clone an agent from a Git repository, GitHub user/repo, or local directory.
# The optional name sets the local directory and the name field in agent.yaml.
cast clone https://github.com/user/my-agent
cast clone https://github.com/user/my-agent my-local-name
cast clone user/my-agent
cast clone ./path/to/local-agent
cast clone /absolute/path/to/local-agent my-local-name

# Deploy an agent
cast deploy demo-agent --provider docker

# Shut down a deployed agent (destroy remote resources)
cast shutdown demo-agent
cast shutdown abc123          # one deployment, when the agent has several

# Connect to deployed agent
cast connect demo-agent

# Update agent configuration
cast update demo-agent --model openrouter/anthropic/claude-sonnet-4.6

# Show or set the builder's model (not the model of an agent being created).
# A running builder does not hot-swap; start it again to apply.
cast model
cast model anthropic/claude-sonnet-4.6
cast model openrouter/minimax/minimax-m2.5

# Delete agent
cast delete demo-agent --force

# Run meta-builder tests (temporary agents dir, offline echo builder)
cast meta test
```

### Deployment Providers

Cast Agent supports deploying agents to multiple platforms:

| Provider | Description | Command |
|----------|-------------|---------|
| **DigitalOcean** | Deploy to DigitalOcean Droplets (cloud VMs) | `cast deploy demo-agent --provider digitalocean` |
| **DigitalOcean MicroVM** | Firecracker microVM in MKC1. Pauses when idle and resumes on the next request. Public preview. | `cast deploy demo-agent --provider microvm` |
| **Docker** | Containerized deployment to any Docker host. The image installs `python/pyproject.toml` dependencies (GitPython 3.2.1 or newer) and `runtime.requirements`, then deploy waits until the container is running. A container that exits is a failed deploy. Memory is the `cast-<agent>` volume, reused on the next deploy. `cast stop` stops the running container and leaves the deployment and volume in place. `cast shutdown` removes the container, the `cast-<agent>:latest` image, that volume, and any older `cast-<agent>-<id>-memory` volumes. | `cast deploy demo-agent --provider docker` |
| **Railway** | Deploy to Railway's cloud platform. The image installs the shared `requirements.txt`. | `cast deploy demo-agent --provider railway` |
| **Fly.io** | Deploy to Fly.io's global edge network. The image includes the Cast runtime. The first deploy creates the app with `flyctl apps create`, then a memory volume Fly will accept. A later deploy reuses a volume of that name. Secrets are staged and applied only when deploy succeeds. Deploy waits until `/.well-known/agent.json` responds. A current `Error loading agent config` log fails that check while the machine is still up. `cast logs`, `cast stop`, and `cast status` talk to that app. Shutdown destroys the machines and the app, then deletes every remaining volume of that name by its Fly volume ID. A failed remote step keeps the local record. | `cast deploy demo-agent --provider fly` |
| **Sprites** | Firecracker VMs on Fly.io. The agent runs as a sprite service and comes back after the VM wakes. `sprite login` or `SPRITES_TOKEN` authenticates the sprite CLI. Deploy ships `requirements.txt` and the Cast runtime, omits the Docker build-context paths (including `.cast/`), and fails unless the service becomes ready. | `cast deploy demo-agent --provider sprites` |

Sprites needs the `sprite` CLI. Set `SPRITES_TOKEN` to a token created at [sprites.dev/account](https://sprites.dev/account) in the `org-slug/org-id/token-id/token-value` format. `sprite login` is an alternative. `FLY_API_TOKEN` is not a Sprites token. Cast copies `SPRITES_TOKEN` to `SPRITE_TOKEN` for the sprite CLI. `cast upgrade` redeploys the existing `cast-<agent>` sprite with that same install. If the redeploy fails, the local agent directory is restored and Cast redeploys that previous release through the same path. The recorded version stays the last known-good release. If that rollback also fails, the row is marked `remote-state-unknown` and `cast upgrade <agent> <recorded version>` is allowed. That restore prints `Restoring <recorded version> on the remote...` once and redeploys the recorded release once. A failure ends with one `Logs: sprite exec -s cast-<agent> -- cat /.sprite/logs/services/cast-agent.log` line. When no version was recorded, the failure says to run `cast upgrade <agent> --list-versions`.

`cast connect <agent>` is how you reach a Sprites agent. `https://cast-<agent>.sprites.app` needs Sprites org auth and returns 302 to the Sprites login page, so it is not a direct agent URL. `cast connect` starts `sprite proxy` on localhost and sends the deployment bearer token. A proxy you start yourself runs in the foreground and needs `sprite login` or `SPRITE_TOKEN="$SPRITES_TOKEN"`, because Cast copies that variable only for sprite processes it starts. The agent answers JSON-RPC POST. `message/send` needs `params.message` with `role` and `parts`. A plain GET through the proxy returns 404. The deployment overview has the commands, including a curl example that keeps the token in a header.

`cast deploy` reads `agent.yaml` before any provider work. If the file cannot be parsed, or its top level is not a mapping, the command exits non-zero and prints the error. The runtime exits the same way and does not start on defaults.

`cast deploy` then writes `requirements.txt` before the provider runs. The minimums declared in `python/pyproject.toml` are the source of truth. That file is read from the Cast checkout (`python/cast` and `python/pyproject.toml` together), not from an unrelated project that happens to contain `python/pyproject.toml`. The built-in fallback list carries those same floors, including `typing-extensions`. A pin from `pip freeze`, or a floor in that list, is kept only when it is at least that minimum. A pre-release or dev pin sorts below the matching final release. A post-release (`1.2.16-1`) sorts above that final release, and an epoch (`1!0.5`) sorts above a lower epoch. A line in `runtime.requirements` is kept as written, except a plain name or a lower bound below that floor, which is raised. Extras, compatible upper bounds, and environment markers stay on the line. A marker does not remove the unconditional floor. A direct URL or VCS reference is kept, with one warning, because it cannot be checked against the floor. `--hash` options are removed, and deploy prints one warning that hashes are not supported. Package names match after PEP 503 normalization (`PyYAML` and `pyyaml` are the same package). A pin or upper bound that cannot meet the floor fails the deploy before the image is built. The error names the package, the agent's spec, and the required floor, and it says to raise the bound or remove the line. A malformed line, such as a missing version or a trailing backslash, fails the same way. URL userinfo is masked in that error and in warnings. Docker, Fly, Sprites, Droplets, MicroVMs, and Railway install that file with `pip install -r requirements.txt`. A new provider installs the same file and does not copy the package list.

`--provider local` is not implemented. `cast deploy` still writes that `requirements.txt`, then the provider exits with an error and does not install the packages or record a deployment. Use `--provider docker` to run on this machine. That command prints a deployment SHA and stores the same id. `cast registry` lists it, and `cast connect <sha>` finds that deployment.

Each provider handles the complete deployment lifecycle including building, provisioning, and configuration. The deployment bearer token is stored in the system keychain. The runtime reads it from the `AUTH_TOKEN` environment variable and does not accept it as a command-line flag. On a machine with no Secret Service, Cast writes it under `~/.cast/tokens/` (directory mode 0700, file mode 0600), outside the agent directory, and `cast connect` reads it back. Deploying the same agent again on the same provider and resource marks the previous deployment row deleted and removes `~/.cast/tokens/deployments/<old-sha>.token`. `cast connect <agent>` and `cast shutdown <agent>` then see one live deployment. An agent that already has several active rows for that resource is repaired the next time those commands resolve the name: the newest row stays, the older token files are removed, and the remote keeps running. A second provider, and each MicroVM, stays registered. After deployment, connect to your running agent with:

```bash
cast connect demo-agent
```

To shut down and clean up resources:
```bash
cast shutdown demo-agent
cast shutdown abc123   # only that deployment; other providers stay registered
```

Docker shutdown removes the local image `cast-<agent>:latest` along with the container and memory volumes. The auth token line names the keychain or the token file under `~/.cast/tokens/`, matching the place the token was removed from. A file deletion is reported as the token file, and the line does not say keychain unless the keychain held the token. DigitalOcean droplet shutdown leaves account SSH keys in place, including `cast-do-key`.

Droplet and MicroVM images copy the Cast package to `/app/cast` and set `PYTHONPATH=/app`. `requirements.txt` lists runtime dependencies and does not pip-install `cast`. The image installs git with `apt-get install -y --no-install-recommends git` and deletes the apt package lists in that same step. Recommended packages such as openssh-client, xauth, less, and patch stay out of the image. perl stays, because git depends on it. GitPython 3.2.1 raises ImportError at import when the git binary is missing, and the runtime imports GitPython while loading its tools. The generated Dockerfile does not include a compiler. langgraph, langchain, httpx, starlette, uvicorn, and PyYAML install from wheels on python:3.11-slim-bookworm. An agent that needs a compiler should edit the Dockerfile, for example by adding `build-essential` to the apt line. Cast keeps an edited Dockerfile and prints `Keeping your edited Dockerfile; delete it to regenerate.` Delete the file to regenerate it. Cast replaces a Dockerfile only when the file still matches a template Cast generated. Droplet deploy waits until the container is running and has printed `Agent ready`. A container that exits or keeps restarting fails the deploy, and Cast does not print a deployment SHA. A MicroVM whose workload exits is deleted. If that delete fails, the MicroVM is recorded so `cast shutdown` can remove it. When the MicroVM is deleted, Cast also deletes the registry tag it pushed and the auth token file written for that attempt. When no other MicroVM of that agent remains, and no other live MicroVM on the account uses an image from it, Cast also deletes the `cast-<agent>` repository it created. The tag, repository, and token stay when the MicroVM remains and the deployment is recorded.

DigitalOcean MicroVMs (`--provider microvm`) are separate from Droplets. They are in public preview in region MKC1, run linux/amd64 images from DigitalOcean Container Registry, and pause when idle. The next request resumes a paused MicroVM. Cast Agent retries HTTP 503 while it wakes. The edge closes each chat response about 15 seconds after the request starts, even while bytes are still arriving. Cast keeps that reply running and the client continues it on the next request. A keepalive still covers proxies that drop a quiet stream. Deploy or upgrade the agent so the image includes that runtime, and reconnect with a current build. `--with-tui` is rejected. The endpoint expects your DigitalOcean token on `Authorization` and the agent token on `X-Cast-Authorization`. If the edge does not forward that second header, rerun with `--edge-auth-only`. Logs are `doctl compute microvm exec <id> -- <log command>`. `doctl` 1.173.0 or newer is required. Cast passes the DigitalOcean API token to `doctl` as `DIGITALOCEAN_ACCESS_TOKEN` in that process's environment. The token is not a command-line argument. A successful `cast shutdown` deletes that deployment's registry tag after the MicroVM is destroyed. Another MicroVM for the same agent keeps its own tag and the shared repository. When that shutdown removes the last MicroVM for the agent, Cast deletes the registry repository it created for that agent (`cast-<agent>`). Before that delete, Cast lists the live MicroVMs on the account and leaves the repository in place, with a warning that names it, when another MicroVM's image uses that repository. A digest reference, an untagged reference, or an image Cast cannot read also keeps it. Each MicroVM agent uses one repository, and an empty repository still counts toward the registry limit. Repositories Cast did not create for this agent are left in place. Account SSH keys are left in place. If the tag delete or the repository delete fails, Cast warns and names the tag or repository that is still in the registry, then continues the rest of shutdown. Before building an image, deploy reads the repository limit from the registry subscription. When the registry is already full and this agent's repository is not there yet, deploy stops with the limit and the names of empty `cast-*` repositories.

DigitalOcean Droplets keep the agent on `127.0.0.1:8080`. Port 8080 is not opened to the internet, and a redeploy removes a public allow rule left by an older deploy. The registry URL is `https://<droplet-ip>`. That value identifies the droplet. It is not a public A2A listener. `cast connect` opens an SSH tunnel to the loopback port and sends the bearer token inside SSH. The token is written to `/var/lib/cast/cast-agent.env` (mode 0600) and passed to `docker run` with `--env-file`, so it is not a shell argument. Redeploy an existing droplet to move it off a public port. `cast stop` SSHs to that address and runs `docker stop cast-agent` when the container is running. The droplet and its memory volume stay in place. `cast shutdown` deletes the droplet. The droplet memory volume is named `cast-<agent>`. Deploy attaches it before the container starts, formats it only when it has no filesystem, and mounts it at `/mnt/cast-<agent>`. The mount is stored in `/etc/fstab` by filesystem UUID with `nofail`. A redeploy, upgrade, or replacement droplet reuses the volume and does not format it again. Deploy fails if that path is not the mounted volume or the container's `/app/agent/memory` is not the same mount. `Volume attached at /mnt/cast-<agent>` is printed only after the check succeeds. Shutdown looks that volume up by name and region, waits until it has no attached droplets, deletes it by its DigitalOcean volume ID, and does the same for any older `cast-<agent>-<uuid>-memory` volume from a previous deploy. A 409 while the volume is still detaching is retried for about two minutes. It reports the volume as removed only when the delete succeeds. If the lookup finds no volume, shutdown stays quiet. If the volume is still attached when that wait ends, shutdown reports the error and leaves the deployment recorded so a later shutdown can retry. Deploy requires `ssh` and `ssh-keygen` and checks both before it writes an auth token. A failed deploy removes that attempt's token file under `~/.cast/tokens/deployments/`. If the failure happens after the droplet is created, Cast deletes that droplet, any volume created for the attempt, and its `known_hosts` entry. That volume delete uses the same name and region lookup, waits for the volume to finish detaching, and treats the volume as already gone only when the lookup finds nothing. That cleanup does not delete account SSH keys. If the droplet or volume cannot be deleted, Cast records the deployment so `cast shutdown` can remove it. `cast shutdown` leaves every account SSH key in place, including `cast-do-key`. The local file `~/.ssh/cast_do_key` is kept. Deploy reuses any account SSH key with that public key's fingerprint, under any name, and passes that key's id when it creates a droplet. When no account key has the fingerprint, deploy uploads the public key as `cast-do-key-<first 8 hex characters>`. If that name already belongs to a different key, deploy picks a distinct suffix. Deploy does not delete, rename, or modify existing account SSH keys.

A new droplet uses size `s-2vcpu-2gb`. Pass `--size` with a DigitalOcean size slug to choose another size, for example `cast deploy demo-agent --provider digitalocean --size s-1vcpu-1gb`. An existing droplet keeps the size it was created with.

A Fly deploy writes `fly.toml`, then creates the app with `flyctl apps create` when `flyctl status` cannot find it. The memory volume is created after the app exists, and only when `flyctl volumes list` has no volume of that name. Fly allows several volumes to share a name, so a later deploy reuses the existing one instead of creating another. Its name is `cast_<agent>_memory`: lowercase letters, numbers, and underscores, at most 30 characters, with hyphens from the agent name turned into underscores. The same name is the `[mounts] source`. `cast shutdown` destroys each machine with `flyctl machine destroy --force` and prints a line for each machine destroyed, then the app, then any remaining volumes of that name by `vol_...` id. Fly will not delete a volume that is bound to a machine, and stopping the machine does not release it. Shutdown says the volume was removed only when a delete exits 0. When destroying the app already removed the volume, shutdown says the memory volume was removed with the app. It says the volume was not present when the app was already gone and the list has no volume of that name. Shutdown says the app was destroyed only when `flyctl apps destroy` exits 0. An app that is already gone is recognized from either stdout or stderr. If a machine, the app, or a volume cannot be removed, shutdown exits non-zero and leaves the deployment and its token recorded so it can be run again. Fly's error text and the retry hint are separated by a newline. Secrets go to `flyctl secrets import --stage` on stdin, so a failed build leaves the running machine on its previous `AUTH_TOKEN`. Cast drops the new token only when that deploy did not succeed. After `flyctl deploy` exits 0, Cast waits until a machine is started and `https://cast-<agent>.fly.dev/.well-known/agent.json` responds. A stopped machine, a log line `No module named 'cast'`, or a card that never responds fails the deploy. A current log line `Error loading agent config` fails it too, including while the machine is still started or starting. An older copy of that line followed by `Agent ready` does not. Cast does not print the success banner when the check fails, and the new token stays because that release is already live. A failed deploy records the deployment as soon as the app exists, so `cast shutdown` can remove a partial deploy, and it deletes the token file written for that attempt. `cast logs` prints `flyctl logs --no-tail`. `cast stop` stops Fly machines that are started, starting, or replacing. `cast status` prints `flyctl status`. Pass `--local-only`, `--remote-only`, `--depot`, or `--no-depot` to choose the image builder.

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
ssh -i ~/.ssh/cast_do_key -o UserKnownHostsFile=~/.cast/ssh/known_hosts -o StrictHostKeyChecking=yes -o HostKeyAlgorithms=ssh-ed25519 root@<droplet-ip>

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

Cast pins the droplet SSH host key before it opens a session. On create, it generates an ed25519 host key, installs that key through DigitalOcean user-data, and writes the public key to `~/.cast/ssh/known_hosts`. Deploy, image streaming, and upgrade reuse that file with host key checking enabled. A droplet created before the pin has no recorded key, and Cast refuses the SSH session. Shut it down and deploy again, or add a line you verified from the DigitalOcean console (`<ip> ssh-ed25519 <key>`).

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

The Builder stores a model, tools, and permissions only in the documented `agent.yaml` shape: `brain.model`, `tools.builtin`, and `harness.permissions`. A flat `tools` list, a top-level `model`, a top-level `permissions` block, or a top-level `memory` block is rejected and the file is left unchanged. The Builder then says those settings were not applied. Permission levels are `always-allow`, `ask`, and `deny`. Model ids must be in the catalog, including the id `recommend_model` returns. Each undo-log entry gets its own id.

Pipe a description when stdin is not a terminal. Cast writes the scaffold without opening the TUI. A `Name: my-agent` label sets the agent name. Otherwise Cast derives one from the description. If the builder fails, `cast new` prints the builder's own error, including when the builder exits before it reads the description:

```bash
echo "Summarises incoming email and drafts replies." | cast new
```

After creation, start your agent with:
```bash
cast dev <agent-name>
```

If that name is not on disk yet, `cast dev <agent-name>` starts the same new-agent flow and creates `~/.cast/agents/<agent-name>/` from your description. `cast update`, `cast deploy`, and `cast upgrade` do not create a missing agent; they tell you to run `cast new`.

`cast dev` keeps persistent memory in `~/.cast/agents/<name>/memory/`. A message such as `remember: my favorite fruit is quince` is written to `memory/notes.md` and `memory/memory.db`. Provider keys are scrubbed before those writes, and again when bash writes `memory/notes.md`, including a background command that writes the file after the tool returns and a note such as "remember this permanently". Scrubbed values include a bare `sk-or-v1-` key, other `sk-` keys, and DigitalOcean `dop_v1_`, `doo_v1_`, and `dor_v1_` tokens. The `read` tool resolves `memory/notes.md` against that agent directory. `memory/notes.md` is in the default gitignore, and the agent git tools do not stage it. On startup, a highlight that states an old tool permission is removed when it disagrees with the current `harness.permissions`. A past `bash=deny` boundary does not keep bash disabled after `bash=always-allow`.

`cast dev` starts each MCP server listed in `tools.mcp` and keeps that process alive until the agent exits. The server's tools are registered with the agent, and a tool call is proxied to that process. Restart `cast dev` after changing an MCP config. A server file that does not parse, or a server that fails to start, is skipped. The other servers still start. Each server process receives `PATH` and the variables in its YAML `env` map. It does not inherit the rest of the Cast process environment.

Inside that wizard, `/git`, `/undo`, `/redo`, `/describe`, and `/releases` act on the agent just created. Before an agent exists, they reply `No agent is loaded.` `/undo` and `/redo` show the CLI failure reason in the chat. The CLI process does not write that text over the input line.

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
cast update my-agent --model openrouter/anthropic/claude-sonnet-4.6

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

# Manage Python runtime requirements (3.11 or 3.12)
cast update my-agent --python-version 3.12 --add-requirement requests

# Preview changes without applying
cast update my-agent --model openrouter/openai/gpt-4o --dry-run
```

Permission levels are enforced while the agent is running. `always-allow` runs the tool. `deny` returns an error and does not run it. `ask` runs it only after the TUI approves in a modal that shows the tool name, the arguments, and Approve / Deny. A headless `message/send` does not run an `ask` tool. Restart `cast dev` after a permission change so the running process reloads `agent.yaml`.

A built-in tool with no `harness.permissions` entry stays `always-allow`, except `git_push`, which defaults to `ask`. An MCP tool does not. A tool advertised by an MCP server is `deny` until its registered name is listed. `mcp` and `*` set the level for every advertised name that has no entry of its own. Startup prints the advertised names. `cast update my-agent --permission run=ask` or `cast update my-agent --permission mcp=deny` writes those keys. Restart `cast dev` after adding them.

`cast update` checks these values before it writes. A permission level other than `always-allow`, `ask`, or `deny`, an unknown model id, or a Python version other than `3.11` or `3.12` prints an error and exits non-zero. `agent.yaml` is not changed. Unknown models use the same message as `cast model`. A leading `openrouter/` prefix is still accepted, including the shipped default `openrouter/minimax/minimax-m2.5`. A provider that accepts any model id, such as `digitalocean/`, is still accepted.

In the TUI, `/update` updates that same local agent. With no arguments it opens a modal titled `Update: <agent>`. Up and down move through the fields, Enter chooses one, and a second prompt or list collects the value. Enter writes it with `cast update`. ESC closes the modal and returns focus to the input. The same flags work on the command, for example `/update --model openrouter/anthropic/claude-sonnet-4.6`. A rejected value is shown in the modal, or in the chat when you passed flags, and `agent.yaml` is left unchanged. Restart the local agent (`cast dev <agent>`) so a running session picks up the change. `/update` is available in dev and production and hidden on-host. It does not redeploy a live agent.

### Agent versioning

Cast Agent tracks an agent with three independent concepts:

- **Undo log (internal)** — automatic, sequential snapshots taken on every edit. You don't manage this directly; you interact with it through `cast undo` / `cast redo`. The log also feeds `cast release`'s auto-changelog.
- **Releases**: intentional semantic versions (1.0, 1.5, 2.0) you create when you're ready to ship. Releases are the deployment artifact. `cast release`, the TUI `/release` command, and the builder record each release in `releases.json` and in `cast.db`. `tarball_path` in `releases.json` is relative to the agent directory (`.cast/releases/<version>.tar.gz`), so a clone or a move still finds the archive. `cast release` uses the virtualenv next to the Cast Python package when `python/.venv` exists. If creation fails, the tarball, `releases.json`, and `agent.yaml` are put back, so the same version can be created again.
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

# Live deployments, including rows with no matching release
cast registry
cast registry my-agent

# Restore local files to a previous release. The tarball is the full
# agent except .castignore paths. Restore puts those files back and
# removes project files added after the release.
cast restore my-agent --release 1.0

# Sessions
cast session list
cast session new my-agent --name "auth experiment"
cast session resume <id|name>
cast session fork <id>
cast session export <id> --out backup.json
```

`cast release` rejects a version lower than the `version` in `agent.yaml` and leaves that file unchanged. A release that succeeds updates only the `version` field, keeps the rest of the file's formatting, and then packs the working tree (project files except `.castignore` paths, `.cast/`, and `.git/`) so the tarball's `agent.yaml` matches. `cast deploy` and the runtime both parse that `version` with a YAML parser and keep the scalar text, so an unquoted `1.10` stays `1.10`. A block scalar is that text with surrounding whitespace removed, so a trailing newline from `|`, `>`, or `|+` is not part of the version. A version that still contains a newline or any other whitespace is refused by `cast deploy`. Write it as one line, for example `version: "1.4.5"`. The runtime still reports the text the parser returned. Anchors, aliases, and tags such as `!!str` and `!!float` resolve to the same text. An explicit `!!null` tag is a missing version. A later duplicate `version` key wins. A missing, null, or empty `version` is `1.0` on both sides, and `cast deploy` records `1.0`. A version that is not MAJOR.MINOR or MAJOR.MINOR.PATCH, such as `true` or `yes`, is recorded and `cast deploy` prints one warning.

`cast undo` and `cast redo` copy the files stored in the undo snapshot
onto the agent and leave every other project file in place. The
snapshot records `agent.yaml`, `instructions.md`, and `mcp/` or
`tools/` when those directories have files. `skills/`, `memory/`,
`tests/`, `.gitignore`, `README.md`, a custom prompt file, and files
added under `tools/` or `mcp/` after the snapshot stay on disk.
`repository:` and `skills:` in `agent.yaml` stay when the snapshot
does not include them. A section the snapshot does include is restored
from the snapshot.

`cast undo` and `cast redo` run in the Python environment installed with
Cast. If that runtime fails, the command prints the Python error.
`Nothing to undo` means the undo log is empty, and `Nothing to redo`
means the redo stack is empty.

`cast connect` starts a new session. It does not continue the previous
conversation. Resume a saved session when you want the model to see
that transcript again. `cast session resume` opens the TUI on that
session. A dev session uses the local agent and starts it when it is
not already running. A production session connects to the agent's
deployment. An unnamed session in `cast session list` and
the `/sessions` picker shows a one-line topic from that agent's model.
The first user message remains the fallback until that summary exists.
A name you set still wins.

In the TUI, use `/undo` and `/redo` for iteration. A failure is shown in
the chat. Use `/sessions` to browse saved conversations (with a modal
picker that follows the AGENTS.md design standards), and `/release`,
`/deploy`, `/upgrade`, and `/shutdown` to manage releases and
deployments interactively.
Restore a local agent with `cast restore <agent> --release <version>`.

To upgrade an existing deployment to a new release:

```bash
# Upgrade by agent name (uses most recent deployment)
cast upgrade my-agent 1.6

# Upgrade by deployment SHA (recommended for multi-deployment agents)
cast upgrade abc123 1.6
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
| `/skills [add <github-or-folder>]` | agent | Add or remove skills on this agent. `cast skills add --github` prints each skill and exits with an error when a repo has more than one, so you can pass `--subpath` or `--skill`. Hidden in on-host. |
| `/sessions` | session | Modal picker over saved sessions. `Enter` or `R` resumes, `F` forks, `N` renames, `D` deletes. |
| `/session new [name]` | session | Start a fresh session and model context, and switch the chat to it. |
| `/session resume [id\|name]` | session | Replay a session's transcript into the chat and the model context. Opens the picker if no argument. |
| `/save [filename]` | session | Save the conversation as plain text. With no name, writes `~/.cast/transcripts/<agent>-<timestamp>.txt`. A relative name stays in that directory. An absolute path or a path starting with `~` is written there, and missing parent directories are created. |
| `/releases` | session | Shows semantic releases with `C` (Create Release) and `U` (Upgrade, if deployed) shortcuts. |
| `/release` | agent | Opens a modal to create a new semantic release. The version starts at the next patch of the current release, so 1.4.1 suggests 1.4.2 and 1.10 suggests 1.10.1. With no current release the suggestion is 0.1.0. |
| `/deploy` | agent | Release picker lists releases newest first and marks the row matching `current.version` as `(latest)`, then a provider picker, then a live deploy with the SHA shown on success. |
| `/upgrade` | agent | Operates on the current agent. Modal lists releases to upgrade to. |
| `/update [flags]` | agent | Update the current agent's local configuration. No arguments opens a field modal. Dev and production. Hidden on-host. |
| `/shutdown` | agent | Lists active deployments (every provider) and shuts one down after Y/N. Streams `cast shutdown --force`. Dev and production only. |
| `/stop` | agent | Stop the current local agent and stay in the TUI. |
| `/registry` | session | Modal table of every live deployment (agent, SHA, provider, version, time, URL). Release history stays on `/releases`. |
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

# Push the current branch to origin
cast git push my-agent

# View commit history (last 10 by default; -n must be at least 1)
cast git log my-agent

# View changes. A missing --file path is an error.
cast git diff my-agent
cast git diff my-agent --file instructions.md

# Manage remotes
cast git remote my-agent add origin https://github.com/user/repo.git
cast git remote my-agent create origin
cast git remote my-agent set-url origin https://github.com/user/repo.git
cast git remote my-agent list
cast git remote my-agent remove origin
```

In the TUI, `/git commit -m "Update instructions"` treats `-m` as the
message flag, so the stored message is `Update instructions`.
`/git commit "Update instructions"` commits the same text. `/git help`
shows `/git commit [-m] <msg>`.

`cast git init` runs `git init -b main` and writes ignore rules to
`.gitignore` and `.castignore`. Those rules leave runtime files such
as `memory/memory.db`, `memory/notes.md`, and `tools/__pycache__/` out of the repository.
They also leave the Docker deploy files `Dockerfile`,
`docker-compose.yml`, `requirements.txt`, and `.cast-runtime/` out of
the repository. `docker-compose.yml` does not contain the deployment
bearer token or provider API keys. Deploy passes those to the container
as environment variables, stores the bearer token in the keychain, and
adds the same ignore rules to an ignore file that is already there.
A Git repository that has no `.gitignore` yet receives one.
`repository.branch` is `main`, matching the checked-out branch. If Git
has no `user.name` and `user.email`, init stops before creating the
repository and tells you to set them with `git config`. `GIT_AUTHOR_NAME`,
`GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`, and
`GIT_CONFIG_GLOBAL` are used too. If init fails after creating `.git`,
that directory is removed. `cast dev`
adds the memory database rules and `memory/notes.md` to an agent that already has a Git repo, and stops tracking `memory/notes.md` when an older commit already included it. `cast git commit` leaves that file on disk and out of the new commit.
`git_push` defaults to `ask` when `harness.permissions` has no `git_push` entry. Set `git_push: always-allow` to push without a prompt.

`cast git remote <agent> create` uses `gh` to create the GitHub repository and writes `repository.url` from that repository's owner and host. It does not use the local username, and it leaves the rest of `agent.yaml` unchanged.

Removing a remote also deletes `repository.url` from `agent.yaml` when that URL belonged to the remote and no other remote still uses it.

In the TUI, `/git log` shows up to 5 commits. `/git log -n 1` shows only the newest commit. `--count` is the same option, and the count must be at least 1.

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
├── setup.sh               # Contributor setup (python/.venv; --link opts into the global command)
├── install.sh             # Full install (deps, build, config)
├── upgrade.sh             # Fast-forward to newest upstream and rebuild in place
└── README.md              # This file
```

### Contributor setup

A fresh checkout has no `python/.venv`. Build the CLI, then create that environment before `cast dev`:

```bash
npm ci
npm run build
./setup.sh
./cast dev <agent>
```

`./setup.sh` installs the Cast package plus `langchain`, `langchain-openai`, `langchain-core`, `starlette`, `uvicorn`, `pyyaml`, and `python-dotenv` into `python/.venv`. It leaves `~/.local/bin/cast` unchanged. `./setup.sh --link` points that command at this checkout and prints the previous target when it replaces one. When `uv` is on `PATH`, it uses `uv venv` and `uv pip install`. Otherwise it uses `python3 -m venv` and `pip`. On Debian and Ubuntu, `python3 -m venv` needs the `python3-venv` package. The script does not run `npm ci` or `npm run build`. Those steps come first, and the script prints them again when it finishes.

The same environment by hand, from the repository root:

```bash
cd python
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
pip install langchain langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
```

`cast dev`, `cast new`, and `cast edit` warn when `python/.venv/bin/python3` is missing and tell you to run `./setup.sh`. There is no `python/requirements.txt`. The runtime dependencies live in `python/pyproject.toml` and in the package list above.

### Building

```bash
# Build TypeScript
npm run build

# Build CLI only
npm run build:cli

# Build TUI only
npm run build:tui
```

### Linting

```bash
npm run lint
```

`npm run lint` runs ESLint on `typescript/cast-cli/src`. The flat config enables one type-aware rule, `@typescript-eslint/no-floating-promises`, as an error. `npm run lint` inside `typescript/cast-cli` is the same check (`eslint . --ext .ts`). ESLint 10 needs Node.js 20.19 or newer. The Quality Checks job already uses Node 20.

### Testing

```bash
# Run end-to-end test
./test.sh

# Run meta-builder tests
cast meta test

# Run specific scenario
cast meta test --scenario create-simple
```

`cast meta test` uses the checkout virtualenv (`python/.venv`) and the offline echo builder. Scenarios live in `~/.cast/meta/scenarios/`. They run without a live model call, including when an API key is set. Each run writes agents to a temporary directory and deletes it afterwards, so `~/.cast/agents/` is left unchanged. A scenario fails if an asserted agent file was already there before that scenario. If `python/.venv` is missing, the command falls back to `python3` and prints a warning.

### Continuous Integration

Every push to `main` and every pull request runs the **Test Coverage** workflow (`.github/workflows/test.yml`):

- **TypeScript tests with coverage** — Node 18.x and 20.x in parallel, with `nyc` instrumentation and `tsc --noEmit` type checking.
- **Python tests with coverage** — Python 3.11 and 3.12. The Python step installs the package and its test extras from `python/pyproject.toml` with `pip install -e ".[test]"`. `pyyaml` and `langchain-core` are installed earlier for the TypeScript suite. A collection error or a failing test fails the job.
- **Quality checks** — `npm run lint` (`@typescript-eslint/no-floating-promises` on `typescript/cast-cli/src`), `tsc --noEmit`, `ruff`/`flake8` linting, and `mypy` type checking on the same Python 3.11 + Node 20 runner.
- **Coverage Summary** — downloads the matrix artifacts and posts a sticky PR comment summarising per-language coverage runs. The comment is updated in place on subsequent runs (it is identified by an HTML marker, so only one coverage comment accumulates per PR).
- **Coverage Threshold Check** — enforces the `COVERAGE_THRESHOLD` env var (default 70%). Skipped on PRs by default; opt in by including `[enforce-coverage]` in the PR title or commit message, or by pushing to `main`.
- **Build Verification** — runs `npm run build` to confirm the TypeScript projects still produce their `dist/` artifacts.

## Configuration

The `cast` command at the repository root is a bash wrapper that delegates to `typescript/cast-cli/bin/run`. `./install.sh` and `./upgrade.sh` create a symlink from `~/.local/bin/cast` to this wrapper. `./setup.sh` leaves that command unchanged unless you pass `--link`.

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
export FLY_API_TOKEN="your-token"  # Fly.io only; not a Sprites token
export SPRITES_TOKEN="org-slug/org-id/token-id/token-value"  # from https://sprites.dev/account; or run: sprite login
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

`cast model <id>` writes `defaults.builder_model` from the curated list (`cast model --list`). A leading `openrouter/` on a curated id is accepted and stored as given, so the id printed by `cast model --current` can be passed back to `cast model`. The builder reads that raw value when it starts. A running builder does not hot-swap; run `cast dev <agent>` again. `digitalocean/<model-id>` still selects DigitalOcean. The default remains `openrouter/minimax/minimax-m2.5`. The runtime, the builder, and memory reflection call `get_provider(model)` instead of naming a provider class.

Another inference provider can register without editing those callers. Put a folder at `~/.cast/inference-providers/<key>/` (`provider.json` and `provider.py`), list a module path under `inferenceProviders` in `~/.cast/config.yaml`, or publish a `cast.inference` entry point. A deploy reads `brain.model` and sends that provider's API key (`envVar`, from the environment or `configKey`). Other inference keys stay on the machine running `cast deploy`. `providers.digitalocean.token` is the Droplet and MicroVM deploy token. Fly imports secrets on stdin (`flyctl secrets import --stage`) and applies them when `flyctl deploy` succeeds. Docker passes the container env file on stdin. Railway reads each variable from stdin. A droplet writes a mode 0600 env file over SSH stdin. A sprite sends the launch script on stdin. A MicroVM sends the environment in the create request body. MicroVM `doctl` receives the DigitalOcean API token as `DIGITALOCEAN_ACCESS_TOKEN` in the child environment. That token is not a `doctl` argument.

## Documentation

The full user documentation lives in `docs-site/` and is built with
[Astro](https://astro.build). The CLI command reference, TUI slash-command
reference, deployment provider pages, and changelog are **auto-extracted
from source on every build**, so the docs cannot drift from the code.

```bash
# Install + dev server (auto-extracts reference data on every reload)
npm --prefix docs-site install
npm --prefix docs-site run dev

# Production build (writes docs-site/dist/ and a Pagefind index at dist/pagefind/)
npm run docs:build

# CI check: diff the regenerated manifest against the committed baseline
# and fail on any unresolved {% ref %} targets
npm run docs:check
```

A pull request that adds, removes, or renames a CLI command, TUI slash
command, deployment provider, or known model surfaces a manifest diff as
a PR comment via `.github/workflows/docs.yml`. The `main` branch builds
and deploys the site to GitHub Pages at [castagent.dev](https://castagent.dev).

## Versioning

We use [changesets](https://github.com/changesets/changesets) for automated version management. All packages in the monorepo share a unified version.

### Workspace Packages

The monorepo is a private root `castagent` workspace. The versioned, published packages are:

- `cast-cli` — `typescript/cast-cli/`
- `cast-tui` — `typescript/cast-tui/`

Both are bumped together in lockstep (changesets `fixed: [["*"]]` config) and share a single version line.

### Making a Change

Add a changeset file in the pull request. The Release workflow on `main` reads files in `.changeset/`. It does not create them.

1. Make your changes in a feature branch
2. Run `npx changeset` to describe your change
3. Commit the changeset file along with your code
4. Open a PR with your changeset

Use the workspace package names (`cast-cli`, `cast-tui`), not the root `castagent` workspace name. The root package is private and is not a changeset target.

### Changeset Prompt Guide

When running `npx changeset`:
- **Package**: Select `*` (all packages — unified versioning)
- **Bump type**:
  - `patch` — Bug fixes (0.1.0 → 0.1.1)
  - `minor` — New features (0.1.0 → 0.2.0)
  - `major` — Breaking changes (0.1.0 → 1.0.0)
- **Summary**: Brief description of the change

### Release Process

1. PR with changeset merged to `main`
2. The Release workflow (`.github/workflows/release.yml`) on `main`:
   - Bumps version in all package.json files (`cast-cli`, `cast-tui`)
   - Updates `CHANGELOG.md` files
   - Creates a git tag (e.g., `v0.2.0`)
   - Creates a GitHub Release
3. No manual version bumping required

## License

Apache License 2.0
