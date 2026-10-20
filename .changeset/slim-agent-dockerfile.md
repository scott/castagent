---
"cast-cli": patch
---

The agent image no longer includes gcc. Docker deploys now use `python:3.11-slim-bookworm` instead of `python:3.11-slim`.
