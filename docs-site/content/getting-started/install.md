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
- **git**, **tar**, and a C compiler. Linux also needs libsecret.

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
TUI, and links `cast`. Linux also gets a C compiler and libsecret, which the
native CLI dependencies need. A second run rebuilds that checkout and does not
fetch new commits. Update an existing checkout with [`./upgrade.sh`](#updating).

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

## Updating

From the checkout:

```bash
./upgrade.sh
```

`upgrade.sh` fetches the newest `master` commit (`main` when that is the only
upstream branch), fast-forwards this checkout, and rebuilds the CLI, TUI, and
Python runtime in place. Agents, config, and tokens in `~/.cast` stay where
they are. A stale pre-TypeScript binary at `~/.cast/bin/cast` is removed so it
cannot shadow the new CLI.

The script stops without rebuilding when you have uncommitted changes, or when
local commits on that upstream branch cannot fast-forward. It updates the
local Cast installation only. A deployed agent is still updated with
`cast upgrade <agent>`.

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
