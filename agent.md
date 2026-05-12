# Agent-Cast Design Standards

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
2. **Navigation**: Up/Down arrow keys OR number keys 1-6
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