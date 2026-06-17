---
"cast-cli": patch
"cast-tui": patch
---

fix(deploy): reliably wait for Docker on fresh DigitalOcean droplets

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
  .git, archives, __pycache__, logs, .env files, and other non-runtime artifacts
- Fix DigitalOcean fresh deploys by adding missing .cast-runtime/ directory
  creation before docker build
- Switch to multi-stage Docker build to exclude gcc/git toolchain from final
  image (~250-300 MB saved)
- Use python:3.11-slim-bookworm base image for better compression (~50-70 MB saved)
