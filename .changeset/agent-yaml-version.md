---
"cast-cli": patch
---

`cast deploy` records `1.0` when agent.yaml has no version. A version that contains whitespace is refused. A version that is not MAJOR.MINOR or MAJOR.MINOR.PATCH is recorded with one warning.
