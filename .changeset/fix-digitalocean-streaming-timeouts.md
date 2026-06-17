---
"cast-cli": patch
"cast-tui": patch
---

fix(deploy): mitigate DigitalOcean image streaming timeouts

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
