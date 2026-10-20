---
"cast-cli": patch
---

`CAST_PROVIDER_HTTP_BASE` accepts only literal `127.0.0.1` and `::1`. Fly checks that value before it creates an app, and `cast connect` rewrites the stored URL only for Fly.
