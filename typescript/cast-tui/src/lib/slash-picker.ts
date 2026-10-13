// Pure slash-picker grouping. Do not import OpenTUI; Mocha loads this file directly.

export type SlashUiMode = 'dev' | 'production' | 'on-host'

export type SlashPickerCategory = 'chat' | 'agent' | 'session' | 'git'

export const SLASH_CATEGORY_ORDER: readonly SlashPickerCategory[] = ['chat', 'agent', 'session', 'git']

export const SLASH_CATEGORY_LABELS: Record<SlashPickerCategory, string> = {
  chat: 'Chat',
  agent: 'Agent',
  session: 'Session',
  git: 'Git',
}

export interface SlashPickerCommand {
  name: string
  description: string
  category: SlashPickerCategory
  args?: string
  modes?: readonly SlashUiMode[]
}

export type SlashPickerRow<T extends SlashPickerCommand = SlashPickerCommand> =
  | {kind: 'header'; category: SlashPickerCategory; label: string}
  | {kind: 'command'; command: T}

/** Unset `modes` means every UI mode. An empty list is visible nowhere. */
export function commandVisibleInMode(
  command: {modes?: readonly SlashUiMode[] | undefined},
  mode: SlashUiMode,
): boolean {
  if (!command.modes) return true
  return command.modes.includes(mode)
}

/**
 * Group already mode-filtered commands. `query` is the text after `/`
 * (case-insensitive name prefix). Empty categories are omitted.
 */
export function groupSlashCommands<T extends SlashPickerCommand>(
  commands: readonly T[],
  query = '',
): SlashPickerRow<T>[] {
  const prefix = query.toLowerCase()
  const rows: SlashPickerRow<T>[] = []
  for (const category of SLASH_CATEGORY_ORDER) {
    const matches = commands
      .filter((command) => command.category === category && command.name.toLowerCase().startsWith(prefix))
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
    if (matches.length === 0) continue
    rows.push({kind: 'header', category, label: SLASH_CATEGORY_LABELS[category]})
    for (const command of matches) {
      rows.push({kind: 'command', command})
    }
  }
  return rows
}

/** Move among command rows only. `delta` is -1 or 1; the index wraps. */
export function moveSlashSelection(commandCount: number, index: number, delta: number): number {
  if (commandCount <= 0) return 0
  const next = (index + delta) % commandCount
  return next < 0 ? next + commandCount : next
}

/** Same category order and alphabetical names as the picker. */
export function formatSlashHelp(commands: readonly SlashPickerCommand[]): string {
  const lines: string[] = ['Available commands:', '']
  const rows = groupSlashCommands(commands)
  let started = false
  for (const row of rows) {
    if (row.kind === 'header') {
      if (started) lines.push('')
      started = true
      lines.push(`${row.label}:`)
      continue
    }
    const args = row.command.args ? ` ${row.command.args}` : ''
    lines.push(`  /${row.command.name}${args} - ${row.command.description}`)
  }
  if (started) lines.push('')
  return lines.join('\n')
}
