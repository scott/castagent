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

- **Node.js 18 or newer** (Node 20+ recommended).
- **Python 3.11 or newer** (3.12 recommended).
- **Bun** — only required to render the TUI; install with `curl -fsSL https://bun.sh/install | bash`.
- **git**, **tar**, and the usual Unix tools.

You will also need an **OpenRouter API key** to actually run any agent — get
one at [openrouter.ai](https://openrouter.ai).

## One-liner install (recommended)

When the repository is public, the fastest path is:

```bash
curl -sL https://raw.githubusercontent.com/scott/castagent/main/install.sh | bash
```

This clones the repo, installs dependencies, builds the CLI and TUI, and
creates a `cast` symlink in `~/.local/bin/`.

## Full install from a clone

If you prefer to see what is running, clone the repo and use the bundled
install script:

```bash
git clone https://github.com/scott/castagent.git
cd castagent
./install.sh
```

`install.sh` is idempotent — re-run it after pulling new commits to update the
build and the symlink.

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

```bash
cd castagent
git pull
./install.sh
```

`install.sh` is idempotent and safe to re-run at any time. As of the latest
version it will also clean up any stale binaries left over from older Cast
installs (for example the pre-TypeScript Go binary that used to live at
`~/.cast/bin/cast`) so the freshly-built CLI always wins in your `$PATH`.

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
`./install.sh` from the project root — it will remove the stale binary and
refresh the `~/.local/bin/cast` symlink.

## Uninstalling

```bash
rm -f ~/.local/bin/cast
rm -rf ~/.cast          # removes all agents, deploys, database, tokens
```
