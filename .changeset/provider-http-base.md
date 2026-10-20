---
"cast-cli": patch
---

`CAST_PROVIDER_HTTP_BASE` is a loopback-only testing override for Droplet DigitalOcean API calls and Fly agent-card checks. The value is literal `127.0.0.1` or `::1`. The path and query stay the same. The override is not stored as the deployment URL. MicroVM calls to api.digitalocean.com are unchanged. Provider CLIs stay on `PATH`.
