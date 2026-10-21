---
"cast-cli": minor
"cast-tui": minor
---

Add `cast provider` to switch inference providers, store model access keys outside config.yaml, and let `cast model` select an enabled provider by prefix. A custom base URL stays on the builder and is not sent to deployed agents. Fly and Railway upgrades do not rewrite remote inference secrets.
