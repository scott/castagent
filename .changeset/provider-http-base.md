---
"cast-cli": patch
---

`CAST_PROVIDER_HTTP_BASE` is a loopback-only testing override for Droplet DigitalOcean API calls and Fly agent-card checks. The path and query stay the same. The override is not stored as the deployment URL. MicroVM calls to api.digitalocean.com are unchanged. Provider CLIs stay on `PATH`.
