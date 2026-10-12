---
title: Skills
section: configuration
order: 4
description: Install an Agent Skills directory onto the agent open in the TUI.
ref: ['slash:skills', 'cli:skills']
---

# Skills

A skill is an Agent Skills directory. Cast copies that directory onto the
**user agent** you have open (`~/.cast/agents/<name>/skills/<skill>/`) and
records it in `agent.yaml`. The running prompt does not change until you
restart the agent.

This is separate from the Builder Agent. Skills are not read from or written
to `~/.cast/builder/`.

See [Agent anatomy](building-agents/anatomy) for where the files live.

## Install

`{% ref "slash:skills" %}` opens a modal on the current agent. It is available
in dev and production, and absent from on-host help.

| Source | What you give | What is recorded |
|---|---|---|
| GitHub repository | `owner/repo`, `owner/repo@ref`, or a `github.com` URL | `source.type: github`, plus `repo`, `ref`, and `subpath` when set |
| Folder on this machine | an absolute path or a path starting with `~` | `source.type: folder` and `source.from` (the absolute path that was copied) |
| Enter a skill in the modal | name, description, and markdown body | `source.type: modal` |

`{% ref "cli:skills" %}` is the writer. The TUI shells out to it and does not
edit `agent.yaml` itself.

```bash
cast skills email-agent
cast skills add email-agent --github owner/repo
cast skills add email-agent --github owner/repo --ref main --subpath skills/triage
cast skills add email-agent --folder ~/skills/triage
cast skills add email-agent --name triage --description "Sort incoming mail into buckets" --body "# Triage"
cast skills remove email-agent triage
```

GitHub installs shallow-clone the repo. If `SKILL.md` or `skill.md` is at the
repo root or at `--subpath`, that directory is the skill. If the repo contains
more than one skill and you did not pass `--subpath`, the TUI asks you to pick
one. The copy includes `scripts/` and omits `.git`. Cast does not run those
scripts.

A folder or GitHub source is valid when it is an Agent Skills directory:
`SKILL.md` or `skill.md`, YAML frontmatter with `name` and `description`, and
an optional markdown body. A frontmatter-only file is enough. Optional fields
such as `license` and `metadata` are copied with the file. Cast does not
rewrite it down to `name` and `description`.

```markdown
---
name: skill-name
description: A description of what this skill does and when to use it.
---
```

A description may be wrapped with `>` or `|`. Cast stores and loads the full
text as one line, with whitespace collapsed:

```markdown
---
name: triage
description: >
  Sort incoming mail into buckets.
  Use this when new mail arrives.
---

# Triage

Sort the mail.
```

That description is recorded as `Sort incoming mail into buckets. Use this when new mail arrives.`

`name` matches `[a-z0-9][a-z0-9-]*`. Cast stores `description` as one line.
A folded (`>`) or literal (`|`) description is joined into that line. A missing
or blank description is rejected. The modal still asks for one line of typed
text. Installing the same name again does not overwrite; remove it with
`{% ref "slash:skills" %}` first. A path whose real location is already inside
that agent's `skills/` directory is rejected.

`agent.yaml` then looks like:

```yaml
skills:
  - name: triage
    description: Sort incoming mail into buckets
    path: skills/triage
    source:
      type: github
      repo: owner/repo
      ref: main
      subpath: skills/triage
```

Removing the last skill writes `skills: []`.

## What the runtime loads

On startup the runtime reads each `skills[].path` under the agent directory,
in the order written in `agent.yaml`. A listed skill whose directory or
`SKILL.md` / `skill.md` is missing is skipped. When at least one skill loads,
the prompt is `instructions.md` followed by:

```markdown
## Skills

### triage
Sort incoming mail into buckets. Use this when new mail arrives.

<SKILL.md body>
```

The description in the prompt and on the agent card is the full frontmatter
description on one line. An empty body is omitted. The agent card publishes
those skills (`id` and `name` from frontmatter `name`, `description` from
frontmatter). An agent with no loaded skill keeps the single synthetic skill
named after the agent.
