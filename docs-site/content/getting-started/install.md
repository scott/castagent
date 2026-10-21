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

- **Node.js 18 or newer** (the one-liner installs pinned Node.js 20.20.2).
- **Python 3.11 or newer** (the one-liner installs Python 3.12).
- **Bun 1.4.3** (the one-liner installs this pinned build). Required to render the TUI.
- **git**, **gnupg** (the `gpg` command), **tar**, **unzip**, and a C compiler. Linux also needs libsecret.

You will also need an LLM API key to actually run an agent, unless you use local Ollama. Any one of these is enough:

- an **OpenRouter** key (`OPENROUTER_API_KEY`) from [openrouter.ai](https://openrouter.ai) — the default, or
- a **DigitalOcean serverless inference** model access key (`DIGITALOCEAN_MODEL_ACCESS_KEY`), or
- an **OpenAI** key (`OPENAI_API_KEY`) from [platform.openai.com](https://platform.openai.com/api-keys), or
- a **Google Gemini** key (`GEMINI_API_KEY`) from [Google AI Studio](https://aistudio.google.com/apikey), or
- an **Anthropic** key (`ANTHROPIC_API_KEY`) from [platform.claude.com](https://platform.claude.com/settings/keys), or
- **Ollama** running on this machine (`ollama/<model>`, no key) at `http://localhost:11434`.

OpenRouter stays the default. To call DigitalOcean, set the model to
`digitalocean/<model-id>` (for example `digitalocean/llama3.3-70b-instruct`
or `digitalocean/deepseek-v3.2`). Requests go to
`https://inference.do-ai.run/v1`. That key is not the DigitalOcean deploy token.
To call OpenAI directly, set the model to `openai-api/<model-id>`
(for example `openai-api/gpt-4o`). Requests go to `https://api.openai.com/v1`.
`openai/gpt-4o` stays on OpenRouter. Cast does not read `OPENAI_BASE_URL`.
To call Gemini directly, set the model to `gemini/<model-id>` (for example
`gemini/gemini-3.8-flash`). Requests go to
`https://generativelanguage.googleapis.com/v1beta/openai`. `google/...`
stays on OpenRouter.
To call Anthropic directly, set the model to `anthropic-api/<model-id>`
(for example `anthropic-api/claude-sonnet-5-5`). Requests go to
`https://api.anthropic.com/v1` through `ChatAnthropic`. `anthropic/...`
stays on OpenRouter.
To use a local model, run Ollama and set the model to `ollama/<model-id>`
(for example `ollama/qwen3`). Requests go to `http://localhost:11434/v1`.
No API key is required. `cast provider ollama` stores a model Ollama has
pulled. When Ollama does not answer, it stores `ollama/qwen3` and prints
`ollama pull qwen3`. Embedding names are left out of the chat list.
Ollama's default context length is 4096 tokens. Raise it with
`OLLAMA_CONTEXT_LENGTH` or `num_ctx`, because the builder prompt starts
near 1.8k tokens. `OLLAMA_BASE_URL=https://ollama.com/v1` plus
`OLLAMA_API_KEY` points the builder at Ollama cloud. That URL and key stay
on this machine.

## One-liner install (recommended)

When the repository is public, the fastest path is:

```bash
curl -sL https://raw.githubusercontent.com/scott/castagent/main/install.sh | bash
```

On macOS or Linux this installs git, Node.js 20.20.2, Python 3.12, and Bun
1.4.3 when they are missing, clones the signed `main` commit into
`~/.cast/castagent`, builds the CLI and TUI, and links `cast`. Node, uv, and
Bun come from pinned archives. The digests in `install-checksums.txt` are
checked before those archives are unpacked. The one-liner then runs
`install.sh` from the checkout. It does not download `install.sh` from `main`
again. Linux also gets a C compiler, unzip, libsecret, and gnupg. macOS gets gnupg from Homebrew when `gpg` is missing. Unzip unpacks the
Bun archive. On Debian and Ubuntu the system Python does not provide
`ensurepip`, so the script installs `python3-venv` and `python3-pip` when
that Python is new enough to use. A second run rebuilds the checkout it
already has. It does not fetch new commits. Update the checkout with
[`./upgrade.sh`](#updating).

## Full install from a clone

If you prefer to see what is running, clone the repo and use the bundled
install script:

```bash
git clone https://github.com/scott/castagent.git
cd castagent
./install.sh
```

`install.sh` is idempotent. Re-run it after pulling new commits to update the
build and the symlink. To fetch and rebuild in one step, use
[`./upgrade.sh`](#updating).

## Quick setup

`./setup.sh` creates `python/.venv` for a contributor checkout, including
a pull request branch. It installs the packages `cast dev` imports: the
Cast package from `python/pyproject.toml`, plus `langchain`,
`langchain-anthropic`, `langchain-openai`, `langchain-core`, `starlette`, `uvicorn`, `pyyaml`,
and `python-dotenv`.

It does not install Node dependencies or build the CLI, and it does not
change `~/.local/bin/cast`. `./setup.sh --link` points that command at
this checkout and prints the previous target when it replaces one. When
it finishes, it prints the remaining steps: `npm ci`, `npm run build`,
and `./cast dev <agent>`.

`npm ci` and `npm run build` do not create that virtualenv. `cast dev`
then falls back to system `python3` and exits with
`ModuleNotFoundError: No module named 'langchain_core'`.

`./upgrade.sh` fast-forwards to a commit signed by the trusted key. A
pull request branch uses `./setup.sh` instead.

```bash
npm ci
npm run build
./setup.sh
./cast dev <agent>
```

The same environment by hand, from the repository root:

```bash
cd python
python3 -m venv .venv
. .venv/bin/activate
pip install -e .
pip install langchain langchain-anthropic langchain-openai langchain-core starlette uvicorn pyyaml python-dotenv
```

When `uv` is installed, `./setup.sh` creates the virtualenv with `uv venv`
and installs with `uv pip`. On Debian and Ubuntu, install `python3-venv`
before `python3 -m venv`. There is no `python/requirements.txt`.

## Manual install

```bash
npm install
cd typescript/cast-cli && npm install && cd ../..
cd typescript/cast-tui && npm install && cd ../..
npm run build
mkdir -p ~/.local/bin
ln -sf "$(pwd)/cast" ~/.local/bin/cast
export PATH="$HOME/.local/bin:$PATH"
./setup.sh
```

The last step creates `python/.venv`. The [quick setup](#quick-setup)
section lists the same packages if you want to install them by hand.

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
the CLI, TUI, and Python runtime in place. The origin commit must be signed
by the trusted key shipped in the script (`scripts/trusted-commit-key.asc`,
GitHub's web commit signing key). An unsigned commit, or a commit signed by
another key, stops the upgrade before any files move. If `gpg` is not on
`PATH`, upgrade stops and tells you to install gnupg. It does not describe
that commit as unsigned. A checkout on any
branch is switched, including local `master` that tracks `origin/master`.
`master` is used only when the remote has no `main` branch. Agents, config,
and tokens in `~/.cast` stay where they are. A stale pre-TypeScript binary
at `~/.cast/bin/cast` is removed so it cannot shadow the new CLI.

An agent that still stores its history in `.cast/versions/` (the layout from
before 1.1.0) should be updated with Cast 2.5.1 before this upgrade. The
changelog names that step. Opening the database and creating an agent do not
depend on that old command.

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
