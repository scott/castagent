---
title: Persistent memory
section: configuration
order: 3
description: How agents remember things across deploys and upgrades.
ref: ['cli:deploy', 'cli:upgrade', 'cli:shutdown']
---

# Persistent memory

Every Cast agent has a **persistent memory volume** that's mounted into
the container at `/app/agent/memory/`. The agent can read and write
files there; the volume survives deploys, upgrades, and restarts.

## What's in the volume

By convention, agents use the volume to store:

- Long-term notes about the user ("prefers short replies", "works in
  UTC", etc.).
- Per-conversation summaries that the agent can pull into context.
- Cached responses to expensive lookups.
- Anything else the agent wants to remember.

The volume is a regular filesystem mount, so the agent can use plain
file I/O. There's no special API.

## How it's mounted

| Provider | Mount target | Notes |
|---|---|---|
| Docker (local) | `cast-<name>` named volume | managed by `docker volume` |
| Railway | persistent volume attached to the service | provisioned on first deploy |
| Fly | volume attached to the app | provisioned on first deploy |
| DigitalOcean | directory inside the droplet's host filesystem | mounted into the container |
| DigitalOcean MicroVM | MicroVM disk at `/app/agent/memory` | survives pause and resume. Upgrade copies it to the replacement MicroVM when it is 8 MiB or smaller |
| Sprites | persistent directory inside the sprite | managed by Sprites |

The volume is **keyed by the agent name**, not the deployment SHA. So
when you `cast upgrade <sha> 1.7`, the new container
reattaches the same volume and the agent's memories are intact.

A Docker deploy mounts `cast-<name>`. The next deploy reuses that volume
instead of creating another one. If the registry still points at an older
`cast-<name>-<deployment-id>-memory` volume, Cast copies its files into
`cast-<name>` and mounts that. The log says `Creating memory volume` only
when a volume is created, and `Reusing memory volume` when it is not.

## The volume_config field

Cast records the volume configuration in the `deployments` table
(`volume_id`, `volume_config` columns) so it can be re-attached on
upgrade.

`cast shutdown` does not take a volume flag. The only flag is `--force`,
which skips the confirmation prompt. Shutdown runs that provider's
destroy handler:

- Docker removes the container and the `cast-<name>:latest` image, then
  removes the `cast-<name>` memory volume. Older volumes named
  `cast-<name>-<deployment-id>-memory` are removed as well. Cast reports
  a volume as removed only when Docker deletes it, and reports the image
  as removed only when Docker deletes it.
- Railway runs `railway down` and leaves the Railway volume in place.
- Fly destroys the app and then attempts to delete its memory volume.
- DigitalOcean Droplet shutdown deletes the droplet and then attempts
  to delete the memory volume.
- DigitalOcean MicroVM shutdown deletes that MicroVM, including its disk.
- Sprites shutdown destroys the sprite, which holds its persistent
  directory.

## How the runtime exposes the volume

Inside the container, the volume is mounted at `/app/agent/memory/`.
The runtime Python module reads `CAST_AGENT_PATH` to know where the
agent lives and joins `memory/` to that path.

`cast dev` sets `CAST_AGENT_PATH` to `~/.cast/agents/<name>` before it
starts the runtime. The runtime also sets that variable from
`--agent-path`. The `read`, `glob`, and `bash` tools resolve relative
paths against that directory, so `memory/notes.md` is the notes file
in the agent directory.

A user message that starts with `remember:` or `remember that` is
saved before the model replies. The fact is appended to
`memory/notes.md` and inserted into `memory/memory.db` as a
preference. Before either write, the privacy filter scrubs provider
keys, including a bare OpenRouter key (`sk-or-v1-...`), other `sk-`
keys, and DigitalOcean tokens (`dop_v1_`, `doo_v1_`, `dor_v1_`). The
next session includes recent rows from that database
in the prompt. The system prompt tells the agent this store exists.

If the agent wants to use the memory from a custom tool:

```python
from pathlib import Path
import os

MEMORY = Path(os.environ['CAST_AGENT_PATH']) / 'memory'

@tool
def remember_about_user(key: str, value: str) -> str:
    """Save a fact about the user to long-term memory."""
    MEMORY.mkdir(parents=True, exist_ok=True)
    (MEMORY / 'user.md').write_text(f"- {key}: {value}\n", append=True)
    return "saved"
```

## Inspecting the memory locally

```bash
# While a cast dev is running, the memory lives at:
ls ~/.cast/agents/<name>/memory/

# In a deployed container (Docker):
docker exec cast-<name> ls /app/agent/memory/

# In a deployed container (DigitalOcean, on-host):
docker exec -it cast-agent ls /app/agent/memory/
```

`memory/memory.db` is the runtime SQLite database. `cast git` excludes
it from the agent repository. `memory/notes.md` is excluded too, and
the agent git tools do not stage that file.

## Backing up

Treat the volume like a database:

- `cast git init` + `cast git push` for code-level state.
- `cast release` for versioned snapshots.
- For the memory volume itself, snapshot it with your provider's
  tooling (`docker volume create`, `fly volumes snapshots create`, etc.)
  on whatever schedule makes sense for your agent.

## Resetting memory

```bash
cast shutdown <name>
cast deploy <name> --provider <provider>
```

Docker shutdown removes the memory volume, so the next deploy starts
without those files. On Railway the volume remains after `railway down`.
Delete it with Railway's own tools before the next deploy if you want
an empty volume.
