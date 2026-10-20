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

Each case uses a temporary `HOME`, so Python user-site packages would otherwise disappear. The runner keeps the `python3` that was on `PATH` when it started, and puts that interpreter's site packages on `PYTHONPATH`. `pip install --user` locally and `python3 -m pip install` in CI both work. CI also installs `libsecret-1-0` so the keytar module can load. With no Secret Service, Cast stores the deployment token in the temporary home.

The process writes `tests/e2e/smoke-summary.json` (or `$SMOKE_SUMMARY`) and exits non-zero when a case fails. `UPDATE_ENDINGS=1` rewrites `tests/e2e/endings/*.txt` from the current CLI tail. Ending files are `cat -A` style: `$` marks the end of each line, `^I` is a tab, and `^M` is a carriage return.

Each case also fails if a fake provider token value shows up in argv. The CLI shims and the HTTP fake compare argv with those fixed fake values, not with the runner's environment. A `/proc` sampler checks the command lines of live processes. Environment values are not scanned, so a token that stays in the environment is allowed.

The `cast` process is started with an allowlist. `HOME`, `PATH`, the fake provider tokens, and a few locale variables are set explicitly. Real values such as `GH_TOKEN`, `OPENROUTER_API_KEY`, `DIGITALOCEAN_API_TOKEN`, and `DIGITALOCEAN_API_KEY` are not copied in.

## Add a provider fake

1. Teach `tests/e2e/lib/shim.mjs` a new basename, and add that name to `SHIMS` in `tests/e2e/lib/harness.mjs`. The harness prepends the shim directory to `PATH`. Cast still resolves the CLI by name.
2. If the provider calls HTTP, route it in `tests/e2e/lib/http.mjs`. Point Cast at that server with `CAST_PROVIDER_HTTP_BASE` (already set by the harness to the fake's loopback origin). The variable accepts only `127.0.0.1`, `::1`, or `localhost`. It replaces the origin of an official provider URL and keeps the path and query. Leave it unset and the official origin is used. Fly stores `https://cast-<agent>.fly.dev` in the registry. The agent-card check and `cast connect` send that request to the override. MicroVM calls are not redirected. Provider CLIs stay on `PATH`.
3. Record every command with `recordRequest`. Return scripted stdout, stderr, and exit codes, including failures. `scenario.json` (`fx.setScenario`) is how a case asks for a fault. Do not log token values or stdin.

## Add a case

Add an entry to `cases` in `tests/e2e/lib/cases.mjs`. `id` is `provider.case`. `run(fx)` may call `fx.writeAgent`, `fx.seedRelease`, `fx.setScenario`, `fx.cast`, and `fx.liveRows`. Assert the registry row before and after the command, and call `assertEnding` for the CLI tail.

Skip a case the provider cannot perform today by setting `skip` to the reason. The summary records that reason. Do not invent a passing result for behavior the provider does not have.

Fault keys the sprite shim understands: `pip` and `yaml` as `{once: N}` or `{from: N}` (counts reset by `fx.resetCounts`), and `cliTimeout` for a pip exit 124. Fly and DigitalOcean use `flyDeployFail`, `upgradeDeployFail`, `dockerBuildFail`, and `doHealthFail`.
