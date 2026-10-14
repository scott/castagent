# Agent-Cast Design Standards

## Versioning

This project uses Semantic Versioning (SemVer). All version bumps are managed by the coding agent during PR review.

### Version Scope

The following packages share the same version and must be updated together:
- `package.json` (root)
- `typescript/cast-cli/package.json`
- `typescript/cast-tui/package.json`
- `python/cast/__init__.py` (`__version__` variable)

### Version Bump Types

Determine the bump type from conventional commits in the PR:

| Trigger | Bump Type | Example |
|---------|-----------|---------|
| `fix:` in commit/PR title | Patch | 0.1.0 → 0.1.1 |
| `feat:` in commit/PR title | Minor | 0.1.0 → 0.2.0 |
| `feat!:` or `BREAKING CHANGE:` | Major | 0.1.0 → 1.0.0 |

### Version Update Steps

When reviewing a PR that requires a version bump:

1. **Determine bump type** from conventional commits (fix:, feat:, feat!:, BREAKING CHANGE:)

2. **Update all package versions**:
   - `package.json`: `"version": "<new_version>"`
   - `typescript/cast-cli/package.json`: `"version": "<new_version>"`
   - `typescript/cast-tui/package.json`: `"version": "<new_version>"`
   - `python/cast/__init__.py`: `__version__ = "<new_version>"`

3. **Update CHANGELOG.md**:
   - Add new version section at top
   - Include date (YYYY-MM-DD format)
   - Group changes by type: Added, Fixed, Changed, Deprecated, Removed, Security
   - Include PR link: `([#PR_NUMBER](https://github.com/scott/castagent/pull/PR_NUMBER))`

4. **Create git tag** after merge (handled by GitHub Actions):
   - Tag format: `v<version>` (e.g., `v0.2.0`)

### CHANGELOG Format

```markdown
## [0.2.0] - 2026-06-15

### Added
- New deployment provider ([#42](https://github.com/scott/castagent/pull/42))

### Fixed
- Memory leak in agent runtime ([#43](https://github.com/scott/castagent/pull/43))
```

### Branch Protection

All changes to `main` must go through pull requests:
- Create feature branches from `main`
- Open PR against `main`
- Require at least one review before merge
- No direct pushes to `main`
- Squash and merge to keep history clean

### Branch Workflow

All new work must be conducted in a new branch. Never commit directly to `main`. Before starting any task:

1. Create a new branch: `git checkout -b feature/my-feature`
2. Make your changes and commit them
3. Push the branch: `git push -u origin feature/my-feature`
4. Open a pull request against `main`

### Documentation Updates

Always update `README.md` when notable changes are made. This includes:
- New features or commands
- Changed behavior or breaking changes
- New deployment options
- Updated requirements or dependencies

Keep documentation aligned with the code to avoid misleading users.

### Docs Site Updates

When building new features or modifying existing ones, the docs site (`docs-site/`) must be updated in the same PR to reflect the changes. This includes:
- New features, commands, or configuration options
- Changed behavior, renamed flags, or breaking changes
- New deployment providers or integration points
- Updated examples, tutorials, or conceptual explanations

A PR that changes user-facing behavior without corresponding docs-site changes is incomplete. Keep the docs site (`docs-site/content/**`) in sync with the code on every PR.

### Release Process

1. Developer creates PR with changes
2. Coding agent reviews PR and determines version bump
3. Agent updates all package versions and CHANGELOG.md
4. PR merged to `main`
5. GitHub Actions workflow triggers on push to `main`
6. Workflow creates git tag `v<version>` and GitHub Release

---

## Modal Component Requirements

All modals in the TUI must follow these standards to ensure consistency across the application.

### Visual Standards

| Property | Value | Notes |
|----------|-------|-------|
| Width | 90% of terminal | Default, can be overridden |
| Height | 80% of terminal | Default, can be overridden |
| Position | Centered | Horizontally and vertically centered by default |
| Background | Dark overlay `#1a1a1a` | Optional overlay behind modal to dim background |
| Border | White single border | `#FFFFFF`, `'single'` style |
| Background Color | `#333333` | Modal content area |

### Interaction Standards

- **Dismissal**: ESC key closes modal and returns focus to input field
- **Keyboard Navigation**: Up/Down arrows for list selection (wraps around)
- **Selection**: Enter to confirm selection

### Agent List Standards

When displaying a list of agents in a modal:

1. **Sorting**: Alphabetical (ascending, A-Z)
2. **Navigation**: Up/Down arrow keys (wraps around using modulo)
3. **Display**:
   - **No numbers** displayed for agents
   - Selection indicator: `▸` for selected, `  ` (two spaces) for unselected
   - **One-line description** from `agent.yaml` shown after agent name
4. **Description handling**:
   - Read from `~/.cast/agents/<agent-name>/agent.yaml` → `description` field
   - Truncate to 50 characters with "..." if longer

### Provider List Standards

When displaying a list of deployment providers in a modal:

1. **Numbers**: Allowed (e.g., "1. Railway")
2. **Navigation**: Up/Down arrow keys OR number keys 1 through N, where N is the list length (7 today)
3. **Display**: Show name and brief description

### Code Reference

The canonical modal component is located at:
```
typescript/cast-tui/src/components/modal.ts
```

Usage:
```typescript
import {createModal} from './components/modal.js'

const modal = createModal(renderer, previouslyFocused, {
  title: 'Modal Title',
  width: '80%',    // optional, 80% is default
  height: '80%',   // optional, 80% is default
  centered: true,  // optional, true is default
})
```

### Focus Management

The modal automatically handles focus:
- On show: Modal receives focus
- On hide (ESC or selection): Focus returns to `previouslyFocused` parameter (typically the text input)

### Future Development

When adding new modals:
1. Use `createModal` from `./components/modal.js`
2. Accept defaults (80%, centered) unless特殊情况 requires different
3. Implement up/down arrow navigation for lists
4. Show descriptions for agents
5. Ensure ESC returns focus to input