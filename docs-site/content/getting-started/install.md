---
title: Install
section: getting-started
order: 1
description: How to install the Cast CLI and TUI on macOS, Linux, and Windows.
ref: ['']
---

# Install

Cast is shipped as a single `cast` command that wraps a TypeScript CLI and a
terminal UI. The CLI and the TUI always share the same version.

## Prerequisites

The one-liner installs these on macOS and Linux when they are missing. Install
them yourself when you clone the repo and run `./install.sh` from that checkout.

- **Node.js 18 or newer** (the one-liner installs Node.js 20).
- **Python 3.11 or newer** (the one-liner installs Python 3.12).
- **Bun** — required to render the TUI.
- **git**, **tar**, **unzip**, and a C compiler. Linux also needs libsecret.

You will also need an LLM API key to actually run an agent. Either is enough:

- an **OpenRouter** key (`OPENROUTER_API_KEY`) from [openrouter.ai](https://openrouter.ai) — the default, or
- a **DigitalOcean serverless inference** model access key (`DIGITALOCEAN_MODEL_ACCESS_KEY`).

OpenRouter stays the default. To call DigitalOcean, set the model to
`digitalocean/<model-id>` (for example `digitalocean/llama3.3-70b-instruct`
or `digitalocean/deepseek-v3.2`). Requests go to
`https://inference.do-ai.run/v1`. That key is not the DigitalOcean deploy token.

## One-liner install (recommended)

When the repository is public, the fastest path is:

```bash
curl -sL https://raw.githubusercontent.com/scott/castagent/main/install.sh | bash
```

On macOS or Linux this installs git, Node.js 20, Python 3.12, and Bun when
they are missing, clones the repo into `~/.cast/castagent`, builds the CLI and
TUI, and links `cast`. Linux also gets a C compiler, unzip, and libsecret.
Unzip is required by the Bun installer. On Debian and Ubuntu the system Python
does not provide `ensurepip`, so the script installs `python3-venv` and
`python3-pip` when that Python is new enough to use. A second run updates
`install.sh` in that checkout and rebuilds it. It does not fetch new commits.
Update the checkout with [`./upgrade.sh`](#updating).

## Full install from a clone

If you prefer to see what is running, clone the repo and use the bundled
install script:

```bash
git clone https://github.com/scott/castagent.git
cd castagent
./install.sh
```

`install.sh` is idempotent — re-run it after pulling new commits to update the
build and the symlink. To fetch and rebuild in one step, use
[`./upgrade.sh`](#updating).

## Quick setup

If dependencies are already installed (e.g. inside a developer checkout):

```bash
./setup.sh
export PATH="$HOME/.local/bin:$PATH"
cast --version
```

## Manual install

```bash
npm install
cd typescript/cast-cli && npm install && cd ../..
cd typescript/cast-tui && npm install && cd ../..
npm run build
mkdir -p ~/.local/bin
ln -sf "$(pwd)/cast" ~/.local/bin/cast
export PATH="$HOME/.local/bin:$PATH"
```

## Verify the install

```bash
cast --version
cast list       # No agents yet — that's expected
```

If you see the version banner and an empty list, you're ready for the
[quick start](getting-started/quickstart).

The installer prints `cast new` to create an agent and `cast dev <agent>` to
run it. Further reading is at [castagent.dev](https://castagent.dev).

## Updating

From the checkout:

```bash
./upgrade.sh
```

`upgrade.sh` moves this checkout onto the newest `main` commit and rebuilds
the CLI, TUI, and Python runtime in place. A checkout on any branch is
switched, including local `master` that tracks `origin/master`. `master` is
used only when the remote has no `main` branch. Agents, config, and tokens
in `~/.cast` stay where they are. A stale pre-TypeScript binary at
`~/.cast/bin/cast` is removed so it cannot shadow the new CLI.

Tracked TypeScript build info (`typescript/cast-cli/tsconfig.tsbuildinfo` and
`typescript/cast-tui/tsconfig.tsbuildinfo`) is reset. A build rewrites those
files, and checkouts from before they were removed from git still track them.
Any other uncommitted change stops the upgrade before it rebuilds. The script
also stops when local commits on that upstream branch cannot fast-forward.
Commits that exist only on the branch you were on stay on that branch. It
updates the local Cast installation only. A deployed agent is still updated
with `cast upgrade <agent>`.

A checkout created before the default branch was `main` can still contain the
older `upgrade.sh`, which follows `origin/master` and reports that it is
already current. Run the current script instead. It finds the checkout through
`~/.local/bin/cast` or the `cast` command on `PATH`:

```bash
curl -fsSL https://raw.githubusercontent.com/scott/castagent/main/upgrade.sh | bash
```

`./install.sh` still rebuilds the checkout you already have, without fetching.
Use `./upgrade.sh` to move to the newest version and rebuild.

## Troubleshooting

**`cast` runs but reports "No agents found" even though `~/.cast/agents/` is populated.**

This typically means an older `cast` binary is shadowing the new one in your
`$PATH`. The most common culprit is a leftover binary at `~/.cast/bin/cast`
from a pre-TypeScript version of Cast. Check with:

```bash
which cast
file "$(which cast)"
```

If the result is a `Mach-O`/`ELF` executable (not a `bash` script), run
`./upgrade.sh` from the project root — it will remove the stale binary and
refresh the `~/.local/bin/cast` symlink.

## Uninstalling

```bash
rm -f ~/.local/bin/cast
rm -rf ~/.cast          # removes all agents, deploys, database, tokens
```
