---
title: Versioning with Git
section: building-agents
group: versioning
order: 3
description: Optional Git-based history for an agent — separate from the undo log and from releases.
ref: ['cli:git-init', 'cli:git-status', 'cli:git-commit', 'cli:git-log', 'cli:git-diff', 'cli:git-push', 'cli:git-remote', 'slash:git']
---

# Versioning with Git

`cast git` is an opt-in, plain-Git history layered on top of an
agent. The repo lives at `~/.cast/agents/<name>/.git/`. It is
**not required to use Cast** — every Cast command works without it.

The two version tracks (`cast git` and the [undo log](building-agents/versioning/overview)) are
deliberately independent. See the [Versioning overview](building-agents/versioning/overview)
for the comparison table.

## Initialize a repo

```bash
cast git init my-agent
```

This does four things:

1. Runs `git init` inside `~/.cast/agents/my-agent/`.
2. Writes a `.castignore` (see below) so undo snapshots and other
   internal state stay out of the repo.
3. Regenerates a `README.md` from `agent.yaml` (description, model,
   tools, runtime, version) and stages it.
4. Adds a `repository:` block to `agent.yaml` with `remote: origin`
   and `branch: main`, then makes the initial commit stamped with
   the current version (e.g. `Initial commit: my-agent v1.0`).

The agent's files are now in a Git repo on `main`, with one commit.

## Add a remote

Two paths, depending on whether the repo already exists somewhere:

```bash
# Add an existing remote
cast git remote my-agent add origin https://github.com/you/my-agent.git

# Or: create a new GitHub repo and push (requires `gh auth login`)
cast git remote my-agent create origin
cast git remote my-agent create origin --visibility public
```

The `add` path stores the URL in `agent.yaml`'s `repository.url` so
`cast clone` can find the agent later. The `create` path shells out
to the GitHub CLI (`gh repo create`) to provision the repo on
GitHub, then adds it as `origin` and pushes the initial commit.

Other `cast git remote` actions:

```bash
cast git remote my-agent list              # show configured remotes
cast git remote my-agent remove origin     # drop a remote
```

## Day-to-day

```bash
cast git status my-agent                    # modified, staged, untracked
cast git commit my-agent -m "Switched to Claude 3.7"  # stages all + commits
cast git log my-agent                       # last 10 commits
cast git log my-agent -n 20                # last 20 commits
cast git diff my-agent                      # unstaged changes
cast git diff my-agent HEAD~1               # changes since a commit
cast git diff my-agent --staged             # staged changes
cast git diff my-agent --file instructions.md  # one file only
```

`cast git commit` regenerates the `README.md` from `agent.yaml`
before staging, so a `cast update` that changed the description or
model will produce a clean diff in the commit.

## Push

```bash
cast git push my-agent
cast git push my-agent --branch main
cast git push my-agent --remote upstream --branch feature/x
```

With no `--branch`, the push sends the branch that is currently checked
out. A repo whose current branch is `master` is pushed to `origin/master`.
`repository.branch` in `agent.yaml` is not used as the push target.
Pass `--branch` to publish a different branch, and `--remote` to use a
remote other than `origin`.

The success line prints the short hash that landed on the remote. Pushing
the same commit again reports that the remote is already up to date.

Auth is whatever the underlying Git client is configured for — SSH
keys, a `gh` token via the credential helper, or whatever your
provider supports. The CLI prints a hint if it detects
`AuthenticationFailed` or `Permission denied`.

## How `cast git` relates to undo and releases

| | Undo log | `cast git` | Releases |
|---|---|---|---|
| Trigger | automatic on save | manual `cast git commit` | manual `cast release` |
| Storage | `.cast/changes/` | `.git/` | `.cast/releases/<ver>.tar.gz` |
| Shipping | never | never (push is separate) | yes — `cast deploy` ships it |
| Survives agent delete? | no (cascade) | no (it's inside the agent dir) | no (same) |
| Survives machine loss? | no | yes, if pushed | yes, tarball is in the agent dir but you can back it up |
| Excluded from `cast git`? | yes (`.castignore`) | — | no |

Recommended pattern:

- **Undo log** for in-development iteration.
- **`cast git`** for code-level backup and sharing. Push to a remote
  you trust.
- **Releases** for the version that actually deploys. The tarball is
  the artifact `cast deploy` ships; it has a semver.

You can use any combination. The three tracks are independent.

## `.castignore`

`cast git init` writes a `.castignore` next to the agent files. The
default contents are:

```
.cast/versions/
cast.db
*.log
.env
__pycache__/
```

| Path | Excluded because |
|---|---|
| `.cast/versions/` | undo log snapshots (internal state, not source) |
| `cast.db` | runtime SQLite index (deployment / session metadata) |
| `*.log` | runtime log output |
| `.env` | local environment variables may contain secrets |
| `__pycache__/` | Python bytecode |

Releases (`.cast/releases/`) and the undo log manifest (`.cast/changes/`)
**are** included. A fresh clone of a `cast git`-backed agent comes
with its releases but not with the undo log.

## TUI

In the TUI, `{% ref "slash:git" %}` dispatches to the same
subcommands:

```
/git status
/git commit -m "Switched to Claude 3.7"
/git log -n 20
/git diff
/git push
```

There is no TUI-side modal picker for Git — it shells out to the
CLI and prints the output into the chat.

Inside `cast new`, `/git` acts on the agent the wizard just created.
Before that agent exists, it replies `No agent is loaded.` In
`cast dev` and `cast edit`, `/git` acts on the agent open in the session.

## When NOT to use it

If you only ever deploy via `cast release` on a single machine and
don't share the agent, you don't need `cast git`. The undo log
covers iteration; the release tarball is already durable on disk
and inside the agent dir.

`cast git` becomes worth the setup when you want any of:
- A second machine to have the same agent.
- A remote backup in case the laptop dies.
- A code-review-style history of what changed and when.
- A way to share an agent with another developer.
