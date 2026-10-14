/**
 * Ask-permission modal logic with no OpenTUI imports.
 * Tests transpile this file on its own.
 */

export interface PermissionPromptRequest {
  tool: string
  arguments: Record<string, unknown>
}

export const PERMISSION_CHOICES = ['Approve', 'Deny'] as const

/** Deny starts selected so Enter does not run the tool by accident. */
export function initialPermissionIndex(): number {
  return 1
}

export function wrapPermissionIndex(index: number, delta: number): number {
  const length = PERMISSION_CHOICES.length
  return (index + delta + length) % length
}

export function permissionChoiceApproved(index: number): boolean {
  return PERMISSION_CHOICES[index] === 'Approve'
}

export type PermissionKeyDecision =
  | {type: 'move'; selected: number}
  | {type: 'choose'; approved: boolean}
  | {type: 'deny'}
  | {type: 'ignore'}

export function permissionKeyDecision(key: string | undefined, selected: number): PermissionKeyDecision {
  if (key === 'escape') return {type: 'deny'}
  if (key === 'up') return {type: 'move', selected: wrapPermissionIndex(selected, -1)}
  if (key === 'down') return {type: 'move', selected: wrapPermissionIndex(selected, 1)}
  if (key === 'return' || key === 'enter') {
    return {type: 'choose', approved: permissionChoiceApproved(selected)}
  }
  return {type: 'ignore'}
}

export function formatPermissionValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function fitPermissionLine(text: string, columns: number): string {
  if (columns <= 0) return ''
  if (text.length <= columns) return text
  if (columns <= 3) return text.slice(0, columns)
  return text.slice(0, columns - 3) + '...'
}

export function buildPermissionLines(options: {
  tool: string
  args: Record<string, unknown>
  selected: number
  columns: number
}): Array<{text: string; tone: 'text' | 'hint'}> {
  const lines: Array<{text: string; tone: 'text' | 'hint'}> = []
  lines.push({text: fitPermissionLine(`Tool: ${options.tool}`, options.columns), tone: 'text'})
  lines.push({text: '', tone: 'text'})
  lines.push({text: 'Arguments', tone: 'text'})
  const keys = Object.keys(options.args)
  if (keys.length === 0) {
    lines.push({text: '  (none)', tone: 'hint'})
  } else {
    for (const key of keys) {
      const value = formatPermissionValue(options.args[key])
      lines.push({
        text: fitPermissionLine(`  ${key}: ${value}`, options.columns),
        tone: 'text',
      })
    }
  }
  lines.push({text: '', tone: 'text'})
  PERMISSION_CHOICES.forEach((choice, index) => {
    const marker = index === options.selected ? '▸ ' : '  '
    lines.push({text: `${marker}${choice}`, tone: 'text'})
  })
  lines.push({text: '', tone: 'text'})
  lines.push({text: 'Up/Down to move, Enter to choose, ESC to deny', tone: 'hint'})
  return lines
}
