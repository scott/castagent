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

1. Runs `git init -b main` inside `~/.cast/agents/my-agent/`. The
   checked-out branch is `main`, even when `init.defaultBranch` is
   unset or names another branch.
2. Writes a `.castignore` and copies the same patterns into
   `.gitignore` (see below). Git reads `.gitignore`, so
   `tools/__pycache__/` and the other default patterns stay out of
   the initial commit.
3. Regenerates a `README.md` from `agent.yaml` (description, model,
   tools, runtime, version) and stages it.
4. Adds a `repository:` block to `agent.yaml` with `remote: origin`
   and `branch: main`, then makes the initial commit stamped with
   the current version (e.g. `Initial commit: my-agent v1.0`).

The agent's files are now in a Git repo on `main`, with one commit.
`repository.branch` matches that branch. `cast git push` sends the
checked-out branch.

If Git has no `user.name` and `user.email`, init stops before it
creates the repository and prints:

```bash
git config --global user.name "Your Name"
git config --global user.email "you@example.com"
```

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
`create` writes that repository to `repository.url` as an https URL
with no `.git` suffix. The owner and host come from the remote `gh`
recorded. If that remote URL is missing, the owner comes from
`gh api user` and the host is github.com. The local username is not
used. A token embedded in the remote URL is not copied into
`agent.yaml`. Comments, quotes, and list indentation in the rest of
the file stay as they are.

If that remote name is already configured, `add` stops and tells you
to run `set-url` (or `remove` the remote first). `set-url` replaces
the URL and writes it to `repository.url`, same as `add`.

Other `cast git remote` actions:

```bash
cast git remote my-agent list              # show configured remotes
cast git remote my-agent set-url origin https://github.com/you/new.git
cast git remote my-agent remove origin     # drop a remote
```

`remove` deletes that remote from the agent repo. When `repository.url`
matches the remote being removed, and no other remote still uses that
same URL, `remove` also deletes `repository.url`. A trailing slash, a
`.git` suffix, or credentials in the remote URL do not keep the stale
URL in place. `repository.remote` and `repository.branch` stay in
`agent.yaml`.

## Day-to-day

```bash
cast git status my-agent                    # modified, staged, untracked
cast git commit my-agent -m "Switched to Claude 3.7"  # stages all + commits
cast git log my-agent                       # last 10 commits
cast git log my-agent -n 20                # last 20 commits; -n must be at least 1
cast git diff my-agent                      # unstaged changes
cast git diff my-agent HEAD~1               # changes since a commit
cast git diff my-agent --staged             # staged changes
cast git diff my-agent --file instructions.md  # one file only
```

`cast git log` shows the newest commits, 10 by default. `-n` changes
how many and must be at least 1. Zero and negative values are
rejected.

`--file` limits the diff to that path. This includes `--staged` and a
commit reference. A path that is not in the agent repository is an
error, so a missing file does not fall back to the full diff.

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
| Excluded from `cast git`? | no (not in `.castignore`) | n/a | no |

Recommended pattern:

- **Undo log** for in-development iteration.
- **`cast git`** for code-level backup and sharing. Push to a remote
  you trust.
- **Releases** for the version that actually deploys. The tarball is
  the artifact `cast deploy` ships; it has a semver.

You can use any combination. The three tracks are independent.

## `.castignore`

`cast git init` writes a `.castignore` next to the agent files and
copies the same patterns into `.gitignore`. Git reads `.gitignore`.
`cast dev` adds the memory database patterns and `memory/notes.md` to an
agent that already has a Git repository, so `memory/memory.db` and
`memory/notes.md` stay out of `git status`. The agent `git_commit` and
`git_add` tools also refuse to stage `memory/notes.md`, including when
an older ignore file does not list it yet. `git_push` defaults to `ask`
unless `agent.yaml` sets `git_push: always-allow`.
`cast deploy --provider docker` adds the Docker artifact patterns below
to an ignore file that is already present, and creates `.gitignore`
when the agent is a Git repository without one, so an older repository
does not start tracking `docker-compose.yml`.

The default contents are:

```
.cast/versions/
cast.db
*.log
.env
__pycache__/
memory/memory.db
memory/memory.db-journal
memory/memory.db-wal
memory/memory.db-shm
memory/notes.md
/Dockerfile
/docker-compose.yml
/requirements.txt
/.cast-runtime/
```

| Path | Excluded because |
|---|---|
| `.cast/versions/` | legacy undo snapshot directory. The current undo log is `.cast/changes/` and is not listed here |
| `cast.db` | runtime SQLite index (deployment / session metadata) |
| `*.log` | runtime log output |
| `.env` | local environment variables may contain secrets |
| `__pycache__/` | Python bytecode |
| `memory/memory.db` | runtime SQLite memory database, plus its journal, wal, and shm files |
| `memory/notes.md` | persistent notes from explicit remember. The file stays local |
| `/Dockerfile` | generated by `cast deploy --provider docker` at the agent root and overwritten on the next deploy |
| `/docker-compose.yml` | generated compose file. It does not contain the deployment bearer token, and it stays out of `cast git` so a local deploy cannot publish one |
| `/requirements.txt` | generated dependency list written at the agent root by deploy |
| `/.cast-runtime/` | copy of the Cast runtime placed in the agent directory for the Docker build |

Releases (`.cast/releases/`) and the undo log (`.cast/changes/`,
including `changes.json` and the snapshot tarballs) are not listed
above, so `cast git` commits them. A fresh clone of a
`cast git`-backed agent includes both its releases and its undo log.
The default ignore file excludes the legacy `.cast/versions/`
directory, not `.cast/changes/`. `releases.json` stores each
`tarball_path` relative to the agent directory, so the published
manifest does not contain the author's home directory.

## TUI

In the TUI, `{% ref "slash:git" %}` dispatches to the same
subcommands. `/git init` checks out `main` and, when Git has no name
or email, prints the same `git config` hint instead of creating the
repository.

```
/git status
/git commit -m "Switched to Claude 3.7"
/git log -n 20
/git diff
/git push
```

`-m` is the commit message flag. `/git commit -m tui-commit` stores
`tui-commit`. Quotes around the message are not stored, so
`/git commit -m "Switched to Claude 3.7"` stores `Switched to Claude 3.7`.
`/git commit <msg>` commits the same text without the flag. `/git help`
shows `/git commit [-m] <msg>`.

There is no TUI-side modal picker for Git. The command prints its
result into the chat. `/git log` shows up to 5 commits. `-n` or
`--count` sets how many and must be at least 1, so `/git log -n 1`
prints only the newest commit.

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
