# Cast Agent Versioning System PRD

## Overview

Redesign the versioning system to cleanly separate **change tracking** (automatic, internal) from **release versioning** (intentional, semantic). This provides clarity for both local development and production deployments.

---

## Problem Statement

Currently, Cast has two competing versioning concepts:
1. **Version history** (v1, v2, v3...) — automatic, sequential, shows every edit
2. **Semantic version** in `agent.yaml` (1.0, 1.1.0) — manual, but rarely updated

This creates confusion:
- `cast versions` shows v6, but `agent.yaml` shows 1.0
- Updating the YAML version doesn't create a history entry
- `cast upgrade` takes integers (history IDs) not semantic versions
- No clear path from "working on changes" to "shipping a release"

---

## Design Principles

1. **Changes are internal** — automatic, for debugging, not for production
2. **Releases are external** — intentional, semantic, for deployment
3. **Commands are self-documenting** — naming makes intent clear
4. **User is prompted at the right moments** — not buried in docs
5. **CLI and TUI are consistent** — same commands, same behavior
6. **TUI uses modals for input** — slash commands work without args, modals prompt for details
7. **Releases are the deployment artifact** — deploys are always tied to releases
8. **Single source of truth** — all data in one SQLite database

---

## New Concepts

### Changes

Automatic snapshots created whenever an agent is modified through the Builder. Each change is a sequential integer (v1, v2, v3...) stored as a tarball.

**Purpose:** Debugging, rollback during development, diff comparison

**Location:** `~/.cast/agents/<agent>/.cast/changes/`

### Releases

Intentional semantic versions (1.0, 1.1, 2.0) created when a user explicitly releases. Each release maps a semantic version to a tarball.

**Purpose:** Production deployments, external API versioning

**Location:** `~/.cast/agents/<agent>/.cast/releases/`

---

## Storage Layout

```
~/.cast/
├── config.yaml
├── cast.db                     # Main SQLite database
├── agents/
│   └── <agent>/
│       ├── agent.yaml              # version: "1.6" (current semantic version)
│       ├── instructions.md
│       ├── mcp/
│       ├── tools/
│       └── .cast/
│           ├── changes/            # Automatic snapshots
│           │   ├── changes.json    # Metadata (current, entries[])
│           │   ├── 001.tar.gz      # v1
│           │   ├── 002.tar.gz      # v2
│           │   └── 003.tar.gz      # v3
│           └── releases/           # Semantic releases
│               ├── releases.json   # Metadata (version -> tarball mapping)
│               ├── 1.0.tar.gz
│               └── 1.6.tar.gz
```

---

## CLI Commands

### `cast changes`

**Formerly:** `cast versions`

Lists the automatic change history for an agent.

```bash
cast changes demo-agent
```

**Output:**
```
Agent: demo-agent
Current change: 6

Change History:
──────────────────────────────────────────────────────────────────────────────
  v1   5/9/2026 6:26:28 PM  [CREATED]     Initial version
  v2   5/9/2026 6:26:52 PM  [BUILDER]     Updated agent configuration
  v3   5/9/2026 6:28:02 PM  [BUILDER]     Updated agent configuration
  v4   5/9/2026 6:28:12 PM  [BUILDER]     Updated instructions
  v5   5/9/2026 9:35:20 PM  [BUILDER]     Updated agent configuration
  v6   5/11/2026 8:12:05 AM [BUILDER]     Updated: model: minimax/minimax-m2.5
──────────────────────────────────────────────────────────────────────────────

Commands:
  cast diff demo-agent --change 1 --change 3   - Compare changes
  cast restore demo-agent --change 5           - Restore to change v5
```

---

### `cast versions`

Lists the semantic releases for an agent.

```bash
cast versions demo-agent
```

**Output:**
```
Agent: demo-agent
Current release: 1.6

Releases:
──────────────────────────────────────────────────────────────────────────────
  1.0   5/9/2026 6:26:28 PM  Initial release
  1.1   5/9/2026 9:35:20 PM  Added email processing
  1.6   5/11/2026 8:12:05 AM Updated model to minimax/m2.5
──────────────────────────────────────────────────────────────────────────────

Commands:
  cast release demo-agent --version 1.7        - Create release 1.7
  cast upgrade demo-agent --version 1.6        - Upgrade to 1.6
```

---

### `cast release`

Creates a new semantic release from the current agent state.

```bash
cast release demo-agent --version 1.7
cast release demo-agent --version 1.7 --message "Added email parsing"
```

**Behavior:**
1. Validates the semantic version format
2. Creates a tarball snapshot
3. Updates `agent.yaml` with the new version
4. Stores metadata in `.cast/releases/releases.json`
5. Records release in `releases` table in `cast.db`
6. Auto-generates changelog entry from changes since last release

---

### `cast deploy`

Deploys an agent to a hosting provider.

```bash
# Deploy latest release (default)
cast deploy demo-agent --provider railway

# Deploy specific release
cast deploy demo-agent --provider railway --version 1.6

# Deploy current working state (as "latest")
cast deploy demo-agent --provider railway --version latest
```

**Flags:**
- `--provider <provider>` — Railway, fly, digitalocean, sprites, docker, local
- `--version <semver>` — Specific release to deploy
- `--version latest` — Deploy current working state (default)

**Behavior:**
1. If `--version latest` or no version: uses current working state
2. If `--version <semver>`: extracts that release's tarball
3. Generates a unique deployment SHA
4. Performs provider-specific deployment
5. Records deployment in `deployments` table with the SHA and version
6. Displays the deployment SHA for user reference
7. If no `--provider`: prompts via modal in TUI, required in CLI

**Output:**
```
Deployed demo-agent with deployment SHA: abc123
Connect with: cast connect abc123
```

---

### `cast connect`

Connects to a deployed agent.

```bash
# Connect by SHA (recommended for multiple deployments)
cast connect abc123

# Connect by agent name (uses most recent deployment)
cast connect demo-agent

# Force connect to specific deployment by full SHA
cast connect abc123def
```

**Behavior:**
1. If 6-char SHA pattern: lookup deployment directly by SHA
2. If agent name: lookup most recent active deployment
3. If multiple deployments exist for agent name: show error with SHA options
4. Establish connection using auth_token from deployment record

**Error handling:**
- If no deployment found: `No deployment found for 'xyz123'. Use 'cast deploy' to deploy.`
- If ambiguous name: `Multiple deployments found for 'demo-agent'. Use SHA: cast connect abc123`

---

### `cast shutdown`

Shuts down a deployed agent and cleans up resources.

```bash
# Shutdown by SHA (recommended)
cast shutdown abc123

# Shutdown by agent name (uses most recent)
cast shutdown demo-agent

# Force shutdown (destroy all resources)
cast shutdown abc123 --force
```

**Behavior:**
1. If 6-char SHA pattern: lookup deployment directly by SHA
2. If agent name: lookup most recent active deployment
3. If multiple deployments exist: prompt for SHA or use `--force`
4. Calls provider-specific destroy method
5. Soft-deletes deployment record (sets `deleted_at`)

---

### `cast upgrade`

Upgrades an existing deployment to a specific release.

```bash
# Upgrade by SHA (recommended)
cast upgrade abc123 --version 1.7

# Upgrade by agent name (uses most recent deployment)
cast upgrade demo-agent --version 1.7

# Upgrade to latest (current state)
cast upgrade abc123 --version latest
```

**Flags:**
- `--version <semver>` — Target semantic version
- `--version latest` — Deploy current working state (default)

**Behavior:**
1. If 6-char SHA pattern: lookup deployment directly by SHA
2. If agent name: lookup most recent active deployment
3. If `--version latest`: uses current working state
4. If `--version <semver>`: extracts that release's tarball
5. Performs provider-specific redeploy
6. Updates `deployed_version` in database

---

### `cast restore`

Restores local files from a change or release (does not deploy).

```bash
# Restore to a specific change
cast restore demo-agent --change 5

# Restore to a specific release
cast restore demo-agent --release 1.0
```

**Use case:** Debugging, testing old states locally

---

### `cast diff`

Compares two changes or releases.

```bash
cast diff demo-agent --change 3 --change 5
cast diff demo-agent --release 1.0 --release 1.6
```

---

### `cast describe`

Shows detailed information about an agent, including all deployments.

```bash
cast describe demo-agent
```

**Output:**
```
Agent: demo-agent

Database record:
  Created: 2026-05-09
  Updated: 2026-06-09
  Run count: 42

Local status: not running

Deployments:
  abc123  railway   https://demo-agent.up.railway.app   v1.6    2026-06-09
  def456  fly       https://demo-agent.fly.dev          v1.5    2026-06-01

Current connection: not connected
Mode: build
```

---

### `cast registry`

Lists all releases across all agents (reads from `releases` table in `cast.db`).

```bash
# All agents
cast registry

# Single agent with all deployments
cast registry demo-agent
```

**Output (all agents):**
```
Local Agent Registry
─────────────────────────────────────────────────────────────────────────────
  demo-agent    1.6   6/9/2026 10:00:00 AM  [DEPLOYED on RAILWAY, sha:abc123]
  demo-agent    1.5   6/1/2026 02:00:00 PM  [DEPLOYED on FLY, sha:def456]
  email-agent   2.0   6/8/2026 03:00:00 PM  [DEPLOYED on RAILWAY, sha:ghi789]
  email-agent   1.0   6/1/2026 10:00:00 AM
─────────────────────────────────────────────────────────────────────────────

Total: 5 release(s)
```

**Output (single agent - detailed deployments table):**
```
Local Agent Registry: demo-agent
─────────────────────────────────────────────────────────────────────────────
  SHA       PROVIDER   VERSION   DEPLOYED               URL
  abc123    railway    1.6       6/9/2026 10:00:00 AM   https://demo-agent.up.railway.app
  def456    fly        1.5       6/1/2026 02:00:00 PM   https://demo-agent.fly.dev
─────────────────────────────────────────────────────────────────────────────
```

**Purpose:** See all releases in one place, track what's deployed where. When an agent has multiple deployments, SHA is shown to distinguish them.

---

## Releases and Deploys: The Connection

This is the key relationship that ties everything together:

```
┌─────────────────────────────────────────────────────────────────────┐
│                         RELEASE LIFECYCLE                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│   1. DEVELOPER EDITS AGENT                                          │
│      │                                                              │
│      ├── Changes saved → .cast/changes/ (v1, v2, v3...)             │
│      │                                                              │
│      └── (if deployed) → Release prompt appears                     │
│                                                                     │
│   2. DEVELOPER CREATES RELEASE                                      │
│      │                                                              │
│      ├── cast release --version 1.6                                 │
│      ├── Snapshot saved → .cast/releases/1.6.tar.gz                 │
│      ├── agent.yaml updated → version: "1.6"                        │
│      ├── releases table updated → demo-agent 1.6 available           │
│      └── Changelog entry auto-generated                             │
│                                                                     │
│   3. DEVELOPER DEPLOYS RELEASE                                      │
│      │                                                              │
│      ├── cast deploy --version 1.6                                  │
│      ├── Agent deployed to Railway/Fly/etc                          │
│      └── Deployment tracked: demo-agent@1.6 on Railway              │
│                                                                     │
│   4. PRODUCTION RUNNING                                              │
│      │                                                              │
│      └── deployed_version = "1.6" in database                       │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Multi-Deployment: Deployment SHA

**Problem:** Previously, an agent could only have one active deployment at a time because `agent_name` was the primary key in the deployments table. This made it impossible to deploy the same agent to multiple providers or multiple versions simultaneously.

**Solution:** Each deployment now has a unique SHA identifier (first 6 characters of SHA-256 hash), allowing multiple deployments of the same agent.

**Benefits:**
- Deploy same agent to multiple providers (Railway + Fly simultaneously)
- Deploy multiple versions for A/B testing
- Target specific deployments for connect/upgrade/shutdown operations
- Keep deployment history (soft deletes) for audit/tracking

**SHA Format:**
- 6 characters, lowercase alphanumeric
- Generated from: `SHA256(agentName + timestamp + randomBytes)`
- Example: `abc123`, `def456`

**Lookup Priority:**
1. If input matches 6-char SHA pattern → lookup by SHA
2. If input matches agent name → return most recent deployment (backward compat)
3. If multiple deployments exist for agent name → prompt to use SHA

### The Version Flow

| Event | Version Source | Version Target | Notes |
|-------|---------------|----------------|-------|
| Edit in Builder | — | `.cast/changes/` | Auto, v1, v2, v3... |
| Create release | Current state | `.cast/releases/` | Semantic: 1.6 |
| Deploy release | `.cast/releases/` | Provider | Ties release → deploy |
| Upgrade | `.cast/releases/` or current | Provider | Replaces running agent |

---

## Database Schema

All data is stored in `~/.cast/cast.db` (single SQLite database).

```sql
-- releases table: tracks all semantic releases
CREATE TABLE releases (
  agent_name TEXT,
  version TEXT,              -- Semantic version (1.0, 1.6, etc.)
  change_number INTEGER,     -- Which change this was based on
  message TEXT,              -- Release notes
  changelog TEXT,            -- Auto-generated from changes
  created_at TIMESTAMP,
  tarball_path TEXT,
  PRIMARY KEY (agent_name, version)
);

-- deployments table: tracks active deployments
CREATE TABLE deployments (
  id TEXT PRIMARY KEY,           -- Deployment SHA (first 6 chars of SHA-256)
  agent_name TEXT NOT NULL,      -- Which agent was deployed
  provider TEXT,
  deployed_version TEXT,         -- Semantic version (1.6) or 'latest'
  deployed_change INTEGER,       -- Which change number was deployed
  deployed_at TIMESTAMP,
  deployment_url TEXT,
  auth_token_hash TEXT,
  last_connected_at TIMESTAMP,
  volume_id TEXT,
  volume_config TEXT,
  deleted_at TIMESTAMP,          -- Soft delete for history
  FOREIGN KEY (agent_name) REFERENCES agents(name)
);

CREATE INDEX idx_deployments_agent_name ON deployments(agent_name);

-- agents table: existing table for agent metadata
CREATE TABLE agents (
  name TEXT PRIMARY KEY,
  agent_yaml_path TEXT,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);
```

---

## Changelog Auto-Generation

When creating a release, Cast automatically generates a changelog entry from the changes since the last release.

### Algorithm

1. Find the previous release (e.g., 1.5)
2. Get all changes between previous release's change number and now
3. Group changes by type (model, instructions, tools, config)
4. Generate human-readable summary

### Example

**Changes since v1.5:**
```
v6 - Updated model: minimax/minimax-m2.5
v7 - Updated instructions
v8 - Added MCP server: slack
```

**Generated Changelog:**
```
## 1.6 (5/11/2026)

### Features
- Added MCP server: slack

### Improvements
- Updated model to minimax/m2.5
- Updated instructions
```

### Custom Messages

Users can override or enhance the auto-generated changelog:

```bash
cast release --version 1.6 --message "Major update with Slack integration"
```

This replaces the auto-generated message but still records what changed.

---

## TUI Slash Commands

Slash commands live in `typescript/cast-tui/src/commands/slash-registry.ts` and are organized by category.

**Key UX Pattern:** Slash commands work without arguments. If parameters are needed, a modal prompts the user for input.

---

### `/changes`

**Category:** `session`

Shows the automatic change history for the current agent.

```
/changes
```

**Modal:** Opens a selectable list of changes with:
- Change number, timestamp, and message
- "Restore" action per item
- "Diff" action to compare two changes
- Keyboard navigation (up/down arrows, Enter to select, ESC to close)

---

### `/versions`

**Category:** `session`

Shows the semantic releases for the current agent.

```
/versions
```

**Modal:** Opens with:
- List of releases with timestamps and messages
- "Create Release" button
- "Upgrade" button (if deployed)

---

### `/release`

**Category:** `agent`

Creates a new semantic release.

```
/release              # Opens modal
/release 1.7          # Version passed, opens modal for message
/release 1.7 "Added feature"
```

**Modal fields:**
- Version (required): Text input with validation, shows current version
- Message (optional): Text area for release notes
- Suggested version: Auto-calculated based on recent changes
- Changelog preview: Shows auto-generated changelog

**If agent is deployed:** Shows upgrade confirmation option after release

**Modal:**
```
╔══════════════════════════════════════════════════════════════╗
║  Create Release                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Agent: demo-agent                                           ║
║                                                              ║
║  Current version: 1.5                                        ║
║  Suggested: 1.5.1 (patch) or 1.6.0 (minor)                  ║
║                                                              ║
║  Version: [1.5.1________________]                            ║
║                                                              ║
║  Message (optional):                                         ║
║  ┌────────────────────────────────────────────────────────┐  ║
║  │ Updated model to minimax/m2.5                          │  ║
║  └────────────────────────────────────────────────────────┘  ║
║                                                              ║
║  Auto-generated changelog:                                   ║
║  ┌────────────────────────────────────────────────────────┐  ║
║  │ • Updated model to minimax/m2.5                        │  ║
║  │ • Updated instructions                                  │  ║
║  │ • Added MCP server: slack                              │  ║
║  └────────────────────────────────────────────────────────┘  ║
║                                                              ║
║  [Create Release]  [Cancel]                                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

### `/deploy`

**Category:** `agent`

Deploys a release to a hosting provider.

```
/deploy                     # Opens modal with provider picker
/deploy railway             # Provider passed, deploys latest release
/deploy railway --version 1.6
```

**Modal:**
```
╔══════════════════════════════════════════════════════════════╗
║  Deploy: demo-agent                                          ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Select release to deploy:                                   ║
║                                                              ║
║  (•) 1.6  - Latest release (current state)                   ║
║  ( ) 1.5  - Previous release                                  ║
║  ( ) Other: [____________]                                    ║
║                                                              ║
║  Select provider:                                            ║
║  ┌────────────────────────────────────────────────────────┐  ║
║  │ ○ Railway    ○ Fly.io    ○ DigitalOcean                │  ║
║  │ ○ Docker     ○ Sprites   ○ Local                       │  ║
║  └────────────────────────────────────────────────────────┘  ║
║                                                              ║
║  [Deploy]  [Cancel]                                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

**After successful deployment:**
```
╔══════════════════════════════════════════════════════════════╗
║  Deployment Successful!                                      ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Agent: demo-agent                                           ║
║  Provider: Railway                                           ║
║  URL: https://demo-agent.up.railway.app                      ║
║  Deployment SHA: abc123                                     ║
║                                                              ║
║  Connect with: /connect abc123                               ║
║                                                              ║
║  [Close]                                                      ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

### `/upgrade`

**Category:** `agent`

Upgrades the deployed agent.

```
/upgrade                    # Opens modal with version picker
/upgrade --version 1.6      # Version passed, confirm and deploy
/upgrade --version latest   # Deploy current state
```

**If not deployed:**
```
Agent "demo-agent" is not currently deployed.
Use /deploy to deploy first.
```

**Modal (if no version provided):**
```
╔══════════════════════════════════════════════════════════════╗
║  Upgrade Agent                                               ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Agent: demo-agent (sha: abc123)                            ║
║  Provider: Railway                                           ║
║  Current: 1.5                                                ║
║                                                              ║
║  Target version:                                             ║
║                                                              ║
║  ( ) 1.6  - Latest release                                   ║
║  (•) latest - Current working state                          ║
║  ( ) Other: [____________]                                    ║
║                                                              ║
║  [Upgrade]  [Cancel]                                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

### `/restore`

**Category:** `agent`

Restores local files to a previous state.

```
/restore                    # Opens modal to choose source
/restore --change 5         # From change history
/restore --release 1.0      # From a release
```

**Modal:**
```
╔══════════════════════════════════════════════════════════════╗
║  Restore Agent                                               ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Agent: demo-agent                                           ║
║  Current: v6                                                 ║
║                                                              ║
║  Restore from:                                               ║
║                                                              ║
║  (•) Changes                                                 ║
║      v5 - 5/9/2026 9:35 PM                                   ║
║      v4 - 5/9/2026 6:28 PM                                   ║
║      v3 - 5/9/2026 6:26 PM                                   ║
║                                                              ║
║  ( ) Releases                                                ║
║      1.5 - 5/9/2026 9:35 PM                                  ║
║      1.0 - 5/9/2026 6:26 PM                                  ║
║                                                              ║
║  ⚠ This will replace your current files with the selected    ║
║    version. Your current changes will be preserved in the    ║
║    change history.                                           ║
║                                                              ║
║  [Restore]  [Cancel]                                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

**Note:** Restore does NOT deploy. It only updates local files.

---

### `/diff`

**Category:** `agent`

Compares two changes or releases.

```
/diff                       # Opens modal to select two versions
/diff --change 3 --change 5 # Shows diff inline
/diff --release 1.0 --release 1.6
```

**Modal:**
```
╔══════════════════════════════════════════════════════════════╗
║  Diff: demo-agent                                            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Select two versions to compare:                             ║
║                                                              ║
║  First:  [v3 ▼]                                              ║
║  Second: [v5 ▼]                                              ║
║                                                              ║
║  [Compare]  [Cancel]                                         ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

### `/registry`

**Category:** `session`

Shows all releases across all agents (reads from `releases` table).

```
/registry
```

**Modal:** Opens with:
- List of all releases with agent name, version, date
- Deployment status indicator (from `deployments` table join)
- "Deploy" action per release

---

### `/connect`

**Category:** `session`

Connects to a deployed agent by SHA or agent name.

```
/connect                    # Opens modal with agent/deployment selector
/connect abc123             # Connect by deployment SHA
/connect demo-agent         # Connect to most recent deployment
```

**Modal (when no args):**
```
╔══════════════════════════════════════════════════════════════╗
║  Connect to Agent                                            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Recent deployments:                                         ║
║                                                              ║
║  (•) demo-agent [abc123] - Railway - v1.6                    ║
║  ( ) demo-agent [def456] - Fly - v1.5                        ║
║  ( ) email-agent [ghi789] - Railway - v2.0                   ║
║                                                              ║
║  Or enter SHA: [__________]                                   ║
║                                                              ║
║  [Connect]  [Cancel]                                          ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
```

---

## TUI Slash Commands Summary

| Command | Category | Works Without Args | Modal Prompts For |
|---------|----------|-------------------|-------------------|
| `/changes` | session | ✅ | Nothing (shows list) |
| `/versions` | session | ✅ | Nothing (shows list) |
| `/release` | agent | ✅ | Version, message |
| `/deploy` | agent | ✅ | Release, provider, shows SHA after |
| `/upgrade` | agent | ✅ | Target version (shows SHA in selector) |
| `/restore` | agent | ✅ | Source (change/release) |
| `/diff` | agent | ✅ | Two versions to compare |
| `/registry` | session | ✅ | Nothing (shows list) |
| `/connect` | session | ✅ | Agent/deployment selector |

---

## Builder Release Prompt

When a user makes changes in the Builder to a **deployed** agent, show a prompt after saving:

```
╔══════════════════════════════════════════════════════════════╗
║  Agent "demo-agent" is deployed on Railway                   ║
║                                                              ║
║  Changes detected (v5 → v6):                                ║
║    • Updated model to minimax/m2.5                           ║
║                                                              ║
║  Would you like to create a release?                         ║
║                                                              ║
║  Current: 1.5   Suggested: 1.5.1                             ║
║                                                              ║
║  [1] Create release 1.5.1 (recommended)                      ║
║  [2] Create custom version                                   ║
║  [3] Skip - changes saved locally only                       ║
║                                                              ║
║  Note: Run /upgrade to deploy without releasing             ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Version Suggestion Logic

When prompting for a release, suggest the next version based on what changed:

| Change Type | Example | Suggestion | Bump Type |
|-------------|---------|------------|-----------|
| Model only | Changed LLM | 1.5.0 → 1.5.1 | Patch |
| Instructions only | Updated prompt | 1.5.0 → 1.6.0 | Minor |
| Tools/MCP added | New capability | 1.5.0 → 1.6.0 | Minor |
| Config change | Permissions, runtime | 1.5.0 → 1.5.1 | Patch |
| Breaking change | Removed required tool | 1.5.0 → 2.0.0 | Major (requires confirmation) |

---

## Breaking Changes

Breaking changes require explicit confirmation:

```
╔══════════════════════════════════════════════════════════════╗
║  WARNING: This appears to be a breaking change               ║
║                                                              ║
║  Changes detected:                                          ║
║    • Removed tool: bash                                      ║
║    • Changed permissions significantly                       ║
║                                                              ║
║  This will bump the major version.                           ║
║                                                              ║
║  [1] Continue with 2.0.0                                     ║
║  [2] Downgrade to 1.6.0 (not recommended)                   ║
║  [3] Cancel                                                  ║
╚══════════════════════════════════════════════════════════════╝
```

---

## Migration Plan

### Phase 1: Rename files/directories
- `.cast/versions/` → `.cast/changes/`
- `versions.json` → `changes.json`

### Phase 2: Update CLI commands
- Rename `cast versions` → `cast changes` (keep alias for backward compat)
- Update `cast deploy` to use `--version` flag, default to latest release
- Update `cast upgrade` to use `--version` flag
- Add `cast release` command
- Add `cast restore` command
- Add `cast registry` command

### Phase 3: Update TUI slash commands
- Rename `/versions` → `/changes` (current behavior)
- Update `/versions` to show releases instead of changes
- Add `/release` with modal
- Add `/deploy` version picker
- Update `/upgrade` with modal
- Add `/restore` with modal
- Update `/diff` with modal
- Add `/registry`

### Phase 4: Add release functionality
- Create `.cast/releases/` directory
- Add `releases` table to `cast.db`
- Add release prompt to Builder
- Implement version suggestion logic
- Implement changelog auto-generation

### Phase 5: Database migration
- Add `releases` table
- Migrate `deployed_version` format

### Phase 6: Multi-deployment support
- Update `deployments` table schema (add `id` as SHA, `agent_name`, `deleted_at`)
- Generate SHA on each deployment
- Update deploy/connect/shutdown/upgrade to accept SHA
- Add `listDeployments(agentName)` method
- Update `/list` and `/describe` to show all deployments
- Add resolution logic for ambiguous names

---

## Backward Compatibility

- `cast versions` command alias → `cast changes`
- `/versions` slash command shows releases (new behavior)
- `/changes` slash command shows change history (formerly `/versions`)
- Old tarball format (`001.tar.gz`) remains compatible
- Existing deployments continue to work

---

## Summary

| Old Concept | New Concept | CLI | TUI |
|-------------|-------------|-----|-----|
| Version history (v1, v2, v3) | Changes | `cast changes` | `/changes` |
| agent.yaml version | Releases | `cast versions`, `cast release` | `/versions`, `/release` |
| `cast versions` | `cast changes` | Rename command | Rename command |
| `cast deploy` | Deploys release | `--version` flag, default latest, shows SHA | Modal with version picker, shows SHA |
| `cast upgrade <int>` | `cast upgrade --version <semver>` | Update flag, accepts SHA | Update command with modal |
| Single deployment | Multi-deployment | SHA-based targeting | Show all deployments in selector |
| N/A | `cast release` | New command | New command with modal |
| N/A | `cast restore` | New command | New command with modal |
| N/A | `cast registry` | Shows releases + SHA; `<agent>` for single agent | Shows releases + SHA |
| N/A | `cast connect` | New command with SHA support | New command with modal |
| N/A | `cast shutdown` | New command with SHA support | New command with modal |
| N/A | `cast describe` | Shows all deployments | Shows all deployments |
| N/A | Release prompt | N/A | New UX in Builder |
| N/A | Changelog | Auto-generated | Preview in modal |
