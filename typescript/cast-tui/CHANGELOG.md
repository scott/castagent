# cast-tui

## 2.8.1

### Patch Changes

- 4b26270: Document inference providers and `cast provider`. The docs add an Inference providers page and a `cast provider` / `/provider` page. The builder-model page lists direct provider prefixes. The Known models reference is rewritten from the manifest and `getModels()`. Each model in the docs manifest records its provider.

## 2.8.0

### Minor Changes

- 3efb13e: Anthropic is a direct inference provider. `anthropic-api/<model>` uses native ChatAnthropic and `ANTHROPIC_API_KEY`. `anthropic/` stays on OpenRouter. Deploy forwards only `ANTHROPIC_API_KEY`. Claude 4.7 and later omit temperature.
- ba7e195: Google Gemini is a builder and runtime inference provider. `gemini/<model>` uses the OpenAI-compatible Gemini endpoint and `GEMINI_API_KEY`. `google/...` stays on OpenRouter. Deploy forwards only `GEMINI_API_KEY`. The builder omits temperature so Gemini 3 thinking models keep the API default of 1.0. Gemini 3 and 4 tool calls echo `extra_content.google.thought_signature` on the next request.
- 3f4d997: OpenRouter and DigitalOcean inference share one OpenAI-compatible provider class driven by the manifest. Any slash prefix that is not a registered provider and not a reserved direct prefix stays on OpenRouter, including qwen/ and z-ai/. Direct prefixes that are still reserved are not registered yet. Builder temperature comes from the provider row. OpenRouter and DigitalOcean still send 0.7, and Claude 4.7 and later omit temperature.
- eee4f00: Add Ollama as a local, keyless inference provider. Model ids use the ollama/ prefix and http://localhost:11434/v1 with no API key. OLLAMA_API_KEY is optional and stays on the builder. The chat list leaves out embedding names. When Ollama answers, the switch keeps ollama/qwen3 only if that pull is present and otherwise stores the first pulled chat model. When it does not answer, the switch stores ollama/qwen3 and prints ollama pull qwen3. Remote deploy refuses an ollama/ model before extract. Docker rewrites loopback to host.docker.internal and does not copy the key.
- 332d92d: Add OpenAI as a direct inference provider. Model ids use the openai-api/ prefix and OPENAI_API_KEY at https://api.openai.com/v1. openai/ stays on OpenRouter. Reasoning models omit temperature. Deploy forwards only the key the agent's brain.model needs.
- 9b466cf: xAI is a direct inference provider. `xai/<model>` calls https://api.x.ai/v1 with `XAI_API_KEY`. `x-ai/` still uses OpenRouter. The model list keeps chat models and drops image, video, voice, embedding, multi-agent, and latest aliases. Deploy forwards `XAI_API_KEY` only when the agent uses `xai/`.

## 2.7.0

### Minor Changes

- c2d4c8f: Add `cast provider` to switch inference providers, store model access keys outside config.yaml, and let `cast model` select an enabled provider by prefix. A custom base URL stays on the builder and is not sent to deployed agents. Fly and Railway upgrades do not rewrite remote inference secrets.

## 2.6.0

### Minor Changes

- add1fc7: Remove `cast migrate`. Agents still on a pre-1.1 layout should run `cast migrate` from 2.5.1 before upgrading.

### Patch Changes

- f44b763: TUI `/release` suggests the next patch of the current release, and `/deploy` lists releases newest first with `(latest)` on the current version.

## 2.5.1

### Patch Changes

- Inside `cast new`, `/git`, `/undo`, `/redo`, `/describe`, and `/releases` act on the agent the wizard just created. Before an agent exists they say no agent is loaded. `/undo` and `/redo` show the CLI reason in the chat, and child stderr is not painted over the input.

  - PR #169

- `cast undo` and `cast redo` run in Cast's Python environment. A Python failure is reported as an error instead of "Nothing to undo". `/undo` and `/redo` show that error in the chat.

  - PR #171

## 2.5.0

### Minor Changes

- The docs site searches with Pagefind. A box in the header and a `/search` page filter prose, CLI, slash-command, and provider pages as you type.

  - PR #111

- `/` and `/help` list the commands for the current UI mode, grouped by category and alphabetized.

  - PR #110

- An unnamed session shows a one-line topic from that agent's model in the sessions picker and in `cast session list`. The first user message remains the fallback until a topic is stored.

  - PR #114

- `cast registry` and `/registry` list every live deployment. Release history stays on `cast releases`.

  - PR #109

### Patch Changes

- The docs version picker button shows only the version, so the Cast Agent wordmark stays on one line. The open menu still marks the current release as Latest.

  - PR #108

- Add-skill fields accept a cursor and paste, and a failed install keeps the error inside the modal.

  - PR #113

- A release from the CLI, the TUI, or the builder writes the SQLite `releases` row as well as `releases.json`. JSON releases missing from SQLite are inserted and existing rows are left as they are.

  - PR #112

## 2.4.0

### Minor Changes

- The docs site shows a version picker beside the logo. Each published release that contains the docs is frozen at `/vX.Y.Z/`. The current release stays at the site root.

  - PR #92

- `/import` and `cast clone` copy a Cast agent from GitHub or a local directory into `~/.cast/agents/`.

  - PR #88

- `/shutdown` lists deployments and runs `cast shutdown` for the selected one.

  - PR #85

- `cast model` and `/model` write `defaults.builder_model`. The builder reads that value when it starts.

  - PR #89

- Connecting to an agent starts a new session. Resuming a previous session stays an explicit action.

  - PR #90

- Inference providers register by model prefix. Deployed agents receive the API keys that registry declares.

  - PR #91

- Deployment providers register by key. Built-ins stay railway, fly, digitalocean, microvm, sprites, docker, and local.

  - PR #93

### Patch Changes

- Chat streams send an SSE keepalive every 5 seconds so a quiet tool step survives the MicroVM edge timeout.

  - PR #83

- Folded and literal YAML skill descriptions load as one line.

  - PR #86

- Skill install accepts `SKILL.md` or `skill.md`, an empty body, and optional license and metadata fields.

  - PR #87

## 2.3.0

### Minor Changes

- `/builder-skills` and `cast builder-skills` install skills the builder reads from `~/.cast/builder/skills/` when creating or editing an agent.

  - PR #76

- DigitalOcean serverless inference is a peer LLM provider. A `digitalocean/<model-id>` model uses `DIGITALOCEAN_MODEL_ACCESS_KEY` and `https://inference.do-ai.run/v1`. OpenRouter stays the default. Deploy paths forward the inference key when it is set.

  - PR #74

- `/skills` and `cast skills` install a skill directory on the user agent open in the TUI. The runtime appends each `SKILL.md` to that agent's prompt and AgentCard. Scripts in the skill are copied and not run.

  - PR #75

## 2.2.0

### Minor Changes

- Highlighting text in the TUI copies that selection to the clipboard on mouse-up, in dev, production, and on-host. On-host uses OSC 52. Local sessions also write the OS clipboard.

  - PR #69

- The chat cursor stays in the input after send, slash commands, modal close, and mouse-up. Pressing `/` jumps there when focus is elsewhere.

  - PR #72

- The TUI shows an animated Working indicator, with elapsed seconds after one second, until the first token of a reply arrives.

  - PR #71

- The TUI opens on the chat screen. The startup splash, keypress gate, and two-second wait are gone. A `--welcome` message is still the first chat message when one is passed.

  - PR #70

### Patch Changes

- aa16024: fix(deploy): mitigate DigitalOcean image streaming timeouts

  DigitalOcean deploys could time out during the `docker save | ssh docker
load` step on a `s-1vcpu-1gb` droplet when the agent image grew large
  (typically once the on-host TUI bundle was added). Three changes:

  - **Compress the stream.** The streaming pipeline now runs
    `docker save | gzip -6 | ssh ... 'gunzip | docker load'`. This
    cuts network payload to roughly ⅓ and shifts layer decompression
    from the 1-vCPU droplet to the build host. A typical deploy
    streams in 1-2 minutes instead of timing out at 10.
  - **Make the on-host TUI opt-in.** The on-host `cast-tui` command
    bundles ~100MB of Node deps + bun runtime into every image. It is
    no longer added by default. The `--with-tui` flag is now available
    on both `cast deploy <agent>` (top-level) and `cast deploy <agent>
--provider digitalocean`. Users who downgrade from `--with-tui`
    to the default will have the TUI block stripped from their
    Dockerfile on the next deploy.
  - **Bump default droplet size to `s-2vcpu-2gb`.** Doubles CPU and
    RAM for `docker load`, halving decompression time even before
    gzip is applied. The size is configurable via `--size <slug>` and
    only affects new droplets; existing droplets keep their original
    size.

  The streaming wall-clock timeout was also raised from 10 to 15
  minutes to give first-deploy (cold overlay2 cache) headroom.

  Additionally, the SSH login MOTD and post-deploy help text now
  omit references to `cast-tui` when the on-host TUI is not bundled
  in the image — they would otherwise tell users to run a command
  that doesn't exist in the container. The MOTD builder uses a new
  `onHostTui` field on its context; the deploy flow passes it from
  the `--with-tui` flag, and the upgrade flow detects it from the
  running container (`docker exec cast-agent test -e
/usr/local/bin/cast-tui`).

- c79b6cd: fix(deploy): reliably wait for Docker on fresh DigitalOcean droplets

  Two related issues could break the first deploy to a fresh DigitalOcean
  droplet:

  1. Cloud-init's `runcmd` (which installs Docker) runs asynchronously and
     the SSH server comes up before the install finishes. The deploy flow
     only waited for SSH, so the first `docker load` over SSH could fail
     with `bash: line 1: docker: command not found` (exit 127) on slow
     droplets.

  2. The cloud-init `curl | sh` had no retries, so a single network blip
     during install would hang cloud-init forever with no way for the
     client to tell whether install was in progress or had failed.

  Changes:

  - New `waitForDocker` step in the DigitalOcean deploy flow that polls
    `docker info` (and a sentinel file written at the end of cloud-init)
    until both the CLI and the daemon are responsive.
  - Sentinel file `/var/lib/cast/docker-ready` written as the last step of
    cloud-init's runcmd, so install completion is detectable instantly
    rather than after a long `docker info` timeout.
  - `curl --retry 5 --retry-delay 10 --retry-connrefused --retry-max-time 300`
    on the install, so transient network failures don't brick cloud-init.
  - On timeout, the error now includes the droplet's own `cloud-init status`
    and `docker info` output so users can diagnose without an extra SSH.
  - 10-minute wait budget (up from 5) to accommodate slow installs.
  - Fix DigitalOcean deploys hanging indefinitely during image streaming by
    adding SSH keepalive and a wall-clock timeout to the
    `docker save | ssh docker load` transfer
  - Reduce Docker image size by adding comprehensive .dockerignore that excludes
    .git, archives, **pycache**, logs, .env files, and other non-runtime artifacts
  - Fix DigitalOcean fresh deploys by adding missing .cast-runtime/ directory
    creation before docker build
  - Switch to multi-stage Docker build to exclude gcc/git toolchain from final
    image (~250-300 MB saved)
  - Use python:3.11-slim-bookworm base image for better compression (~50-70 MB saved)

- 52fce32: fix(docs): site renders at the GitHub Pages project URL with working links

  The static documentation site at `https://<owner>.github.io/<repo>/` was
  deploying with `base: '/'`, so every URL Astro produced (CSS, sidebar
  nav, card links, in-content cross-links) pointed at the _host_ root
  instead of `/<repo>/`. The result on the live site: unstyled content,
  CSS 404s, and broken navigation.

  What changed:

  - **Base path now flows into the build.** The `docs` workflow sets
    `PUBLIC_SITE_BASE=/${{ github.event.repository.name }}/` and
    `PUBLIC_SITE_URL=https://${{ github.repository_owner }}.github.io/${{ github.event.repository.name }}`
    from the GitHub context, so renames don't require code changes. Astro's
    `base` config picks them up via the existing `process.env` defaults in
    `astro.config.mjs`.
  - **`<base>` tag in the layout.** `src/layouts/Docs.astro` emits
    `<base href={import.meta.env.BASE_URL}>`, so authors can write
    `href="getting-started/install"` (base-relative) and the browser
    rewrites it against the configured base. Absolute paths in HTML,
    external links, and anchors are unaffected.
  - **All internal links are now base-relative.** The sidebar, the home
    page, the 404 page, the CLI reference page, the `ManifestBadge`
    component, the `{% ref %}` resolver in `src/lib/links.ts`, and all
    cross-links in `content/**/*.md` (21 hand-written links) drop the
    leading slash. The sidebar's `isCurrent` check is base-aware.
  - **Docs README updated** with a "Deploying to a sub-path" section
    explaining `PUBLIC_SITE_BASE` / `PUBLIC_SITE_URL` and the `<base>`
    convention, so future contributors don't reintroduce absolute paths.

  Verified locally with a static server mimicking the `/<repo>/` URL
  prefix: all 12 representative pages return 200, the active sidebar item
  highlights correctly on every page, and 404s are returned for pages
  that don't exist.

- 66b1df1: fix(install): remove stale Go binary from pre-TypeScript installs

  Older (pre-TypeScript-rewrite) versions of Cast installed a Go binary
  at `~/.cast/bin/cast`. If `~/.cast/bin` appeared in `$PATH` before
  `~/.local/bin`, that binary silently shadowed the new TypeScript CLI
  even after `install.sh` set up the correct symlinks. The shadowed
  binary looked for agents at `~/cast-agents` (a path that no longer
  exists) instead of `~/.cast/agents/`, so users would see "No agents
  found" and the wrong version banner.

  `install.sh` now removes `~/.cast/bin/cast` on every run, so the
  freshly-built TypeScript CLI always wins in `$PATH`. Re-running
  `./install.sh` from the project root is a safe, idempotent way to
  clear the conflict if a user hits it.

  Docs: added a Troubleshooting section to
  `docs-site/content/getting-started/install.md` documenting the
  symptom and fix.

## 1.0.0

### Major Changes

- 7e29443: First official release- Cast includes an agent builder, deployment tools and agent template

### Minor Changes

- c67581f: Rename the `versions` command to `releases` for consistency with the existing `--list-versions` flag on `email-agent upgrade` (which already documents its output as "available releases") and with the product terminology used elsewhere.

  - `cast versions` → `cast releases` (CLI)
  - `/versions` → `/releases` (TUI slash command)
  - `cast versions` remains available as a deprecated alias for one release cycle. oclif prints a deprecation warning to stderr on each invocation; the alias will be removed in the next major release.

  Bump type rationale: this is a `minor` (not `major`) change because the deprecated alias preserves full backward compatibility — existing scripts, muscle memory, and JSON pipelines all keep working. The only observable change for existing users is the addition of a stderr deprecation warning.

  In-scope:

  - User-facing command names and slash command names.
  - Help text and command descriptions.
  - README.md documentation.

  Out of scope (separate work):

  - The on-disk storage paths (`.cast/versions/versions.json` for the changes history, `.cast/releases/releases.json` for releases) are unchanged.
  - The `VersionInfo` and `ChangeInfo` TypeScript type names are unchanged.
  - The Python `versioning` module is unchanged.
  - The `cast version` (singular) command, which reports the CLI's own version, is unaffected.
  - Sibling bugs: #18 (broken TUI tests), #20 (`/restore` leaks CLI), #21 (`/release` wrong version), #24 (Python deps).
