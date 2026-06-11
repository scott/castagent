# cast-tui

## 1.0.0

### Major Changes

- 7e29443: First official release- Cast includes an agent builder, deployment tools and agent template

### Minor Changes

- c67581f: Rename the `versions` command to `releases` for consistency with the existing `--list-versions` flag on `email-agent upgrade` (which already documents its output as "available releases") and with the product terminology used elsewhere.

  - `cast versions` → `cast releases` (CLI)
  - `/versions` → `/releases` (TUI slash command)
  - `cast versions` remains available as a deprecated alias for one release cycle. oclif prints a deprecation warning to stderr on each invocation; the alias will be removed in the next major release.

  Bump type rationale: this is a `minor` (not `major`) change because the deprecated alias preserves full backward compatibility — existing scripts, muscle memory, and JSON pipelines all keep working. The only observable change for existing users is the addition of a stderr deprecation warning.

  In-scope:

  - User-facing command names and slash command names.
  - Help text and command descriptions.
  - README.md documentation.

  Out of scope (separate work):

  - The on-disk storage paths (`.cast/versions/versions.json` for the changes history, `.cast/releases/releases.json` for releases) are unchanged.
  - The `VersionInfo` and `ChangeInfo` TypeScript type names are unchanged.
  - The Python `versioning` module is unchanged.
  - The `cast version` (singular) command, which reports the CLI's own version, is unaffected.
  - Sibling bugs: #18 (broken TUI tests), #20 (`/restore` leaks CLI), #21 (`/release` wrong version), #24 (Python deps).
