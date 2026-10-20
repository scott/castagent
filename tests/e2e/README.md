# Provider smoke tests

These cases run the real `cast` CLI against fake Sprites, Fly, and DigitalOcean boundaries. Nothing in this directory calls a real provider API. Tokens in the harness are fixed fake values.

The runner is `node tests/e2e/run.mjs`, not mocha. `scripts/run-tests.sh` collects `tests/**/*.test.ts`. A `*.test.ts` file here would run inside the unit suite without the fakes.

## Run locally

Build the CLI first. The runner executes `typescript/cast-cli/bin/run`.

```bash
npm install
cd typescript && npm install && cd ..
npm run build:cli
python3 -m pip install --user 'langchain-openai>=1.7.2' 'langchain-core>=1.6.12' pyyaml
node tests/e2e/run.mjs
```

Run one provider or one case:

```bash
node tests/e2e/run.mjs --provider fly
node tests/e2e/run.mjs --case fly.deploy
node tests/e2e/run.mjs sprites.rollback digitalocean.upgrade-failure
node tests/e2e/run.mjs --provider fly --case fly.deploy,fly.connect
```

`--provider` takes a comma-separated list. `--case` takes case ids (`provider.case`). A positional argument with a dot is a case id. A positional argument without a dot is a provider name. An unknown name exits 2. When both a provider and a case are given, a case runs only if it matches both (AND). `--list` prints the ids that would run.

Each case uses a temporary `HOME`, so Python user-site packages would otherwise disappear. The runner keeps the `python3` that was on `PATH` when it started, and puts that interpreter's site packages on `PYTHONPATH`. `pip install --user` locally and `python3 -m pip install` in CI both work. CI also installs `libsecret-1-0` so the keytar module can load. With no Secret Service, Cast stores the deployment token in the temporary home.

The process writes `tests/e2e/smoke-summary.json` (or `$SMOKE_SUMMARY`) and exits non-zero when a case fails.

## CLI endings

Each case compares the CLI tail with `tests/e2e/endings/<id>.txt`. Ending files are `cat -A` style: `$` marks the end of each line, `^I` is a tab, and `^M` is a carriage return. Paths, ports, deployment SHAs, tar sizes, and key fingerprints are normalized before the comparison. While a case runs, the harness renames `typescript/cast-tui/dist/index.js` out of the way and puts it back afterwards. Connect then always prints the missing-OpenTUI warning, whether or not the TUI was built.

Rewriting those files is explicit and local:

```bash
UPDATE_ENDINGS=1 node tests/e2e/run.mjs
```

`UPDATE_SNAPSHOTS=1` is the same switch. CI refuses both. A green run never rewrites an ending.

Fly and DigitalOcean do not roll back by deploying the previous release. Their cases are `fly.upgrade-failure` and `digitalocean.upgrade-failure`: the upgrade fails and the CLI prints a manual rollback hint. Sprites `rollback` is a second deploy that restores `1.0.0`.

## Add a provider

Add one module, `tests/e2e/providers/<name>.mjs`. The runner loads every `*.mjs` file in that directory. Do not edit the runner, the shim dispatcher, or the HTTP server.

The module exports:

- `shims`: CLI basenames to place on `PATH` (`['flyctl']`). Each name is a symlink to `tests/e2e/lib/shim.mjs`.
- `tokens`: fake env values for this provider, `{FLY_API_TOKEN: 'fly-secret-...'}`. The name is the env var. Discovery merges every module's `tokens`. The harness puts them in the `cast` environment, the HTTP fake accepts any of them as a bearer, and the argv sampler scans the merged values. Do not add the token to a shared list.
- `cases`: objects `{id, provider, name, run(fx), skip?}`. `id` is `provider.case`.
- `handleShim(api)`: optional. Return `false` when `api.bin` is not yours. Call `api.finish(code, stdout, stderr)` to record the command and exit. Return `true` to keep the process alive (an SSH tunnel). `api.envFlags()` reports which merged token env vars were set.
- `handleHttp(ctx)`: optional. Return `true` after `ctx.send(...)` when the request is yours.

Keep this provider's assertions in the module. `assert.mjs` is generic helpers (`assertOk`, `assertEnding`, registry rows). A check that a droplet was named `cast-smoke`, or that SSH keys are add-only, lives next to the cases that need it.

Shared helpers live in `tests/e2e/lib/` (`assert.mjs`, `harness.mjs`, `state.mjs`). `gzip` and `bun` are built-in stand-ins in `lib/builtin-shims.mjs`, not part of a provider.

`CAST_PROVIDER_HTTP_BASE` is set by the harness to the fake's loopback origin. The value accepts only literal `127.0.0.1` and `::1`. It replaces the origin of an official provider URL and keeps the path and query. Leave it unset and the official origin is used. Fly stores `https://cast-<agent>.fly.dev` in the registry and checks the override before creating an app. `cast connect` rewrites the stored URL only for Fly. MicroVM calls are not redirected. Provider CLIs stay on `PATH`.

Record every command with the shim's `finish` (it calls `recordRequest`). Return scripted stdout, stderr, and exit codes, including failures. `scenario.json` (`fx.setScenario`) is how a case asks for a fault. Do not log token values or stdin.

`run(fx)` may call `fx.writeAgent`, `fx.writeAgentYaml`, `fx.seedRelease`, `fx.setScenario`, `fx.cast`, and `fx.liveRows`. Assert the registry row before and after the command, and call `assertEnding` for the CLI tail.

Skip a case the provider cannot perform today by setting `skip` to the reason. The summary records that reason. Do not invent a passing result for behavior the provider does not have.

Fault keys the sprite shim understands: `pip` and `yaml` as `{once: N}` or `{from: N}` (counts reset by `fx.resetCounts`), and `cliTimeout` for a pip exit 124. Fly and DigitalOcean use `flyDeployFail`, `upgradeDeployFail`, `dockerBuildFail`, and `doHealthFail`.

Each case also fails if a fake provider token value shows up in argv. The CLI shims and the HTTP fake compare argv with those fixed fake values, not with the runner's environment. A `/proc` sampler checks the command lines of live processes. Environment values are not scanned, so a token that stays in the environment is allowed.

The `cast` process is started with an allowlist. `HOME`, `PATH`, the fake provider tokens, and a few locale variables are set explicitly. Real values such as `GH_TOKEN`, `OPENROUTER_API_KEY`, `DIGITALOCEAN_API_TOKEN`, and `DIGITALOCEAN_API_KEY` are not copied in.

## CLI output snapshots

Version edge cases and the remaining slash-command text live in `tests/cli-snapshots/`. See that runner's header. Deploy, upgrade, and upgrade-failure wording is the ending files above.
