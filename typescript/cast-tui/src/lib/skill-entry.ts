import {
  applyEntryKey,
  clipFieldError,
  createTextEntry,
  insertText,
  previewField,
  type EntryKey,
  type TextEntry,
} from './text-entry.js'

export type SkillEntryField = 'name' | 'description' | 'body' | 'save'

export const SKILL_ENTRY_FIELDS: readonly SkillEntryField[] = ['name', 'description', 'body', 'save']

export const SKILL_ENTRY_NAME_MAX = 64
export const SKILL_ENTRY_DESCRIPTION_MAX = 200
export const SKILL_ENTRY_BODY_MAX = 200000
export const SKILL_ENTRY_BODY_MAX_ROWS = 8

const ENTRY_ERROR_ROWS = 2
const ENTRY_CHROME_ROWS = 9

export interface SkillEntryDraft {
  name: TextEntry
  description: TextEntry
  body: TextEntry
  field: SkillEntryField
  error: string
}

export interface SkillEntryKey extends EntryKey {
  shift?: boolean
}

export type SkillEntryEffect =
  | {type: 'draft'; draft: SkillEntryDraft}
  | {type: 'submit'; draft: SkillEntryDraft}
  | {type: 'ignore'}

export type SkillEntryLineTone = 'label' | 'value' | 'save' | 'error' | 'hint'

export interface SkillEntryLine {
  text: string
  tone: SkillEntryLineTone
  active: boolean
}

export function createSkillEntryDraft(): SkillEntryDraft {
  return {
    name: createTextEntry(),
    description: createTextEntry(),
    body: createTextEntry(),
    field: 'name',
    error: '',
  }
}

export function nextEntryField(field: SkillEntryField): SkillEntryField {
  if (field === 'name') return 'description'
  if (field === 'description') return 'body'
  if (field === 'body') return 'save'
  return 'name'
}

/** Shift+Tab walks back toward Name and stops there. */
export function previousEntryField(field: SkillEntryField): SkillEntryField {
  if (field === 'save') return 'body'
  if (field === 'body') return 'description'
  if (field === 'description') return 'name'
  return 'name'
}

export function applySkillEntryKey(
  draft: SkillEntryDraft,
  key: SkillEntryKey,
  readClipboard: () => string,
): SkillEntryEffect {
  const name = key.name ?? ''
  if (key.ctrl && (name === 's' || name === 'S') && !key.meta && !key.option && !key.super) {
    return {type: 'submit', draft}
  }
  if (name === 'tab' && !key.ctrl && !key.meta && !key.option && !key.super) {
    const field = key.shift ? previousEntryField(draft.field) : nextEntryField(draft.field)
    return {type: 'draft', draft: {...draft, field}}
  }
  if (name === 'return' || name === 'enter') {
    if (draft.field === 'save') return {type: 'submit', draft}
    if (draft.field === 'body') {
      const body = insertText(draft.body, '\n', 'body', SKILL_ENTRY_BODY_MAX)
      const error = body.text !== draft.body.text ? '' : draft.error
      return {type: 'draft', draft: {...draft, body, error}}
    }
    const field: SkillEntryField = draft.field === 'name' ? 'description' : 'body'
    return {type: 'draft', draft: {...draft, field}}
  }
  if (draft.field === 'save') return {type: 'ignore'}

  const current = activeEntry(draft)
  const kind = draft.field === 'body' ? 'body' : 'single'
  const maxLength = draft.field === 'name'
    ? SKILL_ENTRY_NAME_MAX
    : draft.field === 'description'
      ? SKILL_ENTRY_DESCRIPTION_MAX
      : SKILL_ENTRY_BODY_MAX
  const next = applyEntryKey(current, key, {kind, maxLength}, readClipboard)
  if (!next.handled) return {type: 'ignore'}
  const error = next.entry.text !== current.text ? '' : draft.error
  return {type: 'draft', draft: writeActive(draft, next.entry, error)}
}

export function insertSkillEntryText(draft: SkillEntryDraft, raw: string): SkillEntryDraft {
  if (draft.field === 'save') return draft
  const current = activeEntry(draft)
  const kind = draft.field === 'body' ? 'body' : 'single'
  const maxLength = draft.field === 'name'
    ? SKILL_ENTRY_NAME_MAX
    : draft.field === 'description'
      ? SKILL_ENTRY_DESCRIPTION_MAX
      : SKILL_ENTRY_BODY_MAX
  const next = insertText(current, raw, kind, maxLength)
  const error = next.text !== current.text ? '' : draft.error
  return writeActive(draft, next, error)
}

/** Rows inside the 90% by 80% modal after the border and paddingTop. */
export function skillEntryInnerRows(termHeight: number): number {
  const height = Number.isFinite(termHeight) && termHeight > 0 ? Math.floor(termHeight) : 24
  return Math.max(0, Math.floor(height * 0.8) - 4)
}

export function skillEntryBodyRows(termHeight: number, hasError: boolean): number {
  const reserved = ENTRY_CHROME_ROWS + (hasError ? ENTRY_ERROR_ROWS : 0)
  const room = skillEntryInnerRows(termHeight) - reserved
  if (room < 1) return 1
  return Math.min(SKILL_ENTRY_BODY_MAX_ROWS, room)
}

/**
 * One screen row. Shorter text is padded so it covers the tail of a
 * longer line that used to occupy the same cells.
 */
export function fitSkillEntryLine(text: string, columns: number): string {
  const single = text.replace(/[\r\n]+/g, '')
  const shown = single.length > 0 ? single : ' '
  const width = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : shown.length
  if (width <= 0) return shown
  if (shown.length > width) return shown.slice(0, width)
  return shown.padEnd(width, ' ')
}

export function buildSkillEntryLines(options: {
  draft: SkillEntryDraft
  columns: number
  termHeight: number
}): SkillEntryLine[] {
  const columns = options.columns
  const draft = options.draft
  const hasError = draft.error.trim().length > 0
  const bodyRows = skillEntryBodyRows(options.termHeight, hasError)
  const lines: SkillEntryLine[] = []

  pushLabel(lines, 'Name', columns)
  pushValue(lines, previewSingle(draft.name, columns, draft.field === 'name'), columns, draft.field === 'name')
  if (draft.field === 'name') pushError(lines, draft.error, columns)

  pushLabel(lines, 'Description', columns)
  pushValue(lines, previewSingle(draft.description, columns, draft.field === 'description'), columns, draft.field === 'description')
  if (draft.field === 'description') pushError(lines, draft.error, columns)

  pushLabel(lines, 'Body', columns)
  const bodyPreview = previewField(draft.body, {
    multiline: true,
    columns: Math.max(1, columns),
    maxLines: bodyRows,
    showCursor: draft.field === 'body',
  })
  const bodyLines = bodyPreview.split('\n')
  for (let i = 0; i < bodyRows; i++) {
    pushValue(lines, bodyLines[i] ?? '', columns, draft.field === 'body')
  }
  if (draft.field === 'body') pushError(lines, draft.error, columns)

  pushHint(lines, ' ', columns)
  lines.push({
    text: fitSkillEntryLine(draft.field === 'save' ? '▸ Save' : '  Save', columns),
    tone: 'save',
    active: draft.field === 'save',
  })
  if (draft.field === 'save') pushError(lines, draft.error, columns)
  pushHint(lines, ' ', columns)
  pushHint(lines, 'Ctrl+S Save   Tab Next   Shift+Tab Back   ESC Cancel', columns)
  return lines
}

function previewSingle(entry: TextEntry, columns: number, active: boolean): string {
  return previewField(entry, {
    multiline: false,
    columns: Math.max(1, columns),
    showCursor: active,
  })
}

function pushLabel(lines: SkillEntryLine[], text: string, columns: number): void {
  lines.push({text: fitSkillEntryLine(text, columns), tone: 'label', active: false})
}

function pushValue(lines: SkillEntryLine[], text: string, columns: number, active: boolean): void {
  lines.push({text: fitSkillEntryLine(text, columns), tone: 'value', active})
}

function pushHint(lines: SkillEntryLine[], text: string, columns: number): void {
  lines.push({text: fitSkillEntryLine(text, columns), tone: 'hint', active: false})
}

function pushError(lines: SkillEntryLine[], error: string, columns: number): void {
  if (!error.trim()) return
  const width = Math.max(1, Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 1)
  const clipped = clipFieldError(error, width, ENTRY_ERROR_ROWS)
  for (const line of clipped.split('\n')) {
    lines.push({text: fitSkillEntryLine(line, columns), tone: 'error', active: false})
  }
}

function activeEntry(draft: SkillEntryDraft): TextEntry {
  if (draft.field === 'description') return draft.description
  if (draft.field === 'body') return draft.body
  return draft.name
}

function writeActive(draft: SkillEntryDraft, entry: TextEntry, error: string): SkillEntryDraft {
  if (draft.field === 'description') return {...draft, description: entry, error}
  if (draft.field === 'body') return {...draft, body: entry, error}
  return {...draft, name: entry, error}
}
