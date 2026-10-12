export interface SkillListItem {
  name: string
  description: string
  subpath?: string
}

export const ADD_SOURCE_LABELS = [
  'GitHub repository',
  'Folder on this machine',
  'Enter a skill in this modal',
] as const

export function sortSkillsByName<T extends {name: string; subpath?: string}>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const byName = a.name.localeCompare(b.name)
    if (byName !== 0) return byName
    return (a.subpath ?? '').localeCompare(b.subpath ?? '')
  })
}

/** Truncate to `max` characters, using `...` when the text is longer. */
export function truncateDescription(description: string, max = 50): string {
  const oneLine = (description ?? '').replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  if (max <= 3) return oneLine.slice(0, max)
  return oneLine.slice(0, max - 3) + '...'
}

export function skillRowPrefix(selected: boolean): string {
  return selected ? '▸ ' : '  '
}

export function formatSkillRow(skill: SkillListItem, selected: boolean): string {
  const description = truncateDescription(skill.description)
  const line = `${skillRowPrefix(selected)}${skill.name}  ${description}`
  return description ? line : line.trimEnd()
}

export function formatNumberedRow(index: number, label: string, selected: boolean): string {
  return `${skillRowPrefix(selected)}${index + 1}. ${label}`
}

export function wrapIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return ((index + delta) % length + length) % length
}

/** Map a number key to a zero-based index. 1 selects the first row. */
export function numberKeyIndex(keyName: string | undefined, count: number): number | null {
  if (!keyName || !/^[0-9]+$/.test(keyName)) return null
  const num = parseInt(keyName, 10)
  if (num < 1 || num > count) return null
  return num - 1
}
