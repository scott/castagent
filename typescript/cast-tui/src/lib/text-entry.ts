export interface TextEntry {
  text: string
  cursor: number
}

export type TextFieldKind = 'single' | 'body'

export interface EntryKey {
  name?: string
  ctrl?: boolean
  meta?: boolean
  super?: boolean
  option?: boolean
  sequence?: string
}

export type EntryEdit =
  | {type: 'edit'; entry: TextEntry}
  | {type: 'paste'}
  | {type: 'ignore'}

const CURSOR = '_'

export function createTextEntry(text = ''): TextEntry {
  return {text, cursor: text.length}
}

export function normalizeInserted(raw: string, kind: TextFieldKind): string {
  if (kind === 'single') return raw.replace(/[\r\n]/g, '')
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

export function insertText(
  entry: TextEntry,
  raw: string,
  kind: TextFieldKind,
  maxLength?: number,
): TextEntry {
  const chunk = normalizeInserted(raw, kind)
  const text = entry.text
  const cursor = clampCursor(text, entry.cursor)
  if (!chunk) return cursor === entry.cursor ? entry : {text, cursor}
  const room = maxLength === undefined ? chunk.length : Math.max(0, maxLength - text.length)
  if (room <= 0) return cursor === entry.cursor ? entry : {text, cursor}
  const clipped = chunk.length > room ? chunk.slice(0, room) : chunk
  return {
    text: text.slice(0, cursor) + clipped + text.slice(cursor),
    cursor: cursor + clipped.length,
  }
}

export function moveCursor(entry: TextEntry, where: 'left' | 'right' | 'home' | 'end'): TextEntry {
  const text = entry.text
  const cursor = clampCursor(text, entry.cursor)
  let next = cursor
  if (where === 'left') next = stepCursor(text, cursor, -1)
  else if (where === 'right') next = stepCursor(text, cursor, 1)
  else if (where === 'home') next = lineStart(text, cursor)
  else next = lineEnd(text, cursor)
  if (next === entry.cursor && cursor === entry.cursor) return entry
  return {text, cursor: next}
}

export function deleteBackward(entry: TextEntry): TextEntry {
  const text = entry.text
  const cursor = clampCursor(text, entry.cursor)
  const next = stepCursor(text, cursor, -1)
  if (next === cursor) return cursor === entry.cursor ? entry : {text, cursor}
  return {text: text.slice(0, next) + text.slice(cursor), cursor: next}
}

export function deleteForward(entry: TextEntry): TextEntry {
  const text = entry.text
  const cursor = clampCursor(text, entry.cursor)
  const next = stepCursor(text, cursor, 1)
  if (next === cursor) return cursor === entry.cursor ? entry : {text, cursor}
  return {text: text.slice(0, cursor) + text.slice(next), cursor}
}

export function editEntry(
  entry: TextEntry,
  key: EntryKey,
  options: {kind: TextFieldKind; maxLength?: number},
): EntryEdit {
  if (isPasteChord(key)) return {type: 'paste'}
  const name = (key.name ?? '').toLowerCase()
  if (key.ctrl || key.meta || key.super || key.option) {
    if (key.ctrl && name === 'h' && !key.meta && !key.option && !key.super) {
      return {type: 'edit', entry: deleteBackward(entry)}
    }
    return {type: 'ignore'}
  }
  if (name === 'left') return {type: 'edit', entry: moveCursor(entry, 'left')}
  if (name === 'right') return {type: 'edit', entry: moveCursor(entry, 'right')}
  if (name === 'home') return {type: 'edit', entry: moveCursor(entry, 'home')}
  if (name === 'end') return {type: 'edit', entry: moveCursor(entry, 'end')}
  if (name === 'backspace') return {type: 'edit', entry: deleteBackward(entry)}
  if (name === 'delete' || name === 'del') return {type: 'edit', entry: deleteForward(entry)}
  const ch = printableChar(key)
  if (!ch) return {type: 'ignore'}
  return {type: 'edit', entry: insertText(entry, ch, options.kind, options.maxLength)}
}

export function pasteFromClipboard(
  entry: TextEntry,
  read: () => string,
  kind: TextFieldKind,
  maxLength?: number,
): TextEntry {
  let raw = ''
  try {
    raw = read()
  } catch {
    return entry
  }
  if (typeof raw !== 'string' || raw.length === 0) return entry
  return insertText(entry, raw, kind, maxLength)
}

export function applyEntryKey(
  entry: TextEntry,
  key: EntryKey,
  options: {kind: TextFieldKind; maxLength?: number},
  readClipboard: () => string,
): {entry: TextEntry; handled: boolean} {
  const effect = editEntry(entry, key, options)
  if (effect.type === 'ignore') return {entry, handled: false}
  if (effect.type === 'paste') {
    return {
      entry: pasteFromClipboard(entry, readClipboard, options.kind, options.maxLength),
      handled: true,
    }
  }
  return {entry: effect.entry, handled: true}
}

// Same entry object: a failed install must not move the cursor or rebuild the text.
export function recordFailedSubmit(entry: TextEntry, error: string): {entry: TextEntry; error: string} {
  return {entry, error}
}

export function modalContentColumns(termWidth: number): number {
  if (!Number.isFinite(termWidth) || termWidth <= 0) return 60
  return Math.max(16, Math.floor(termWidth * 0.9) - 6)
}

export function previewField(entry: TextEntry, options: {
  multiline: boolean
  columns: number
  maxLines?: number
  showCursor?: boolean
}): string {
  const columns = Math.max(1, options.columns)
  const showCursor = options.showCursor !== false
  const text = entry.text
  const cursor = clampCursor(text, entry.cursor)
  if (!options.multiline) {
    if (!showCursor) return text.length <= columns ? text : text.slice(0, columns)
    const marked = text.slice(0, cursor) + CURSOR + text.slice(cursor)
    if (marked.length <= columns) return marked
    let start = Math.max(0, cursor - (columns - 1))
    if (start + columns > marked.length) start = Math.max(0, marked.length - columns)
    return marked.slice(start, start + columns)
  }
  const maxLines = Math.max(1, options.maxLines ?? 8)
  const logical = text.split('\n')
  if (!showCursor) {
    const tail = logical.slice(Math.max(0, logical.length - maxLines))
    const wrapped = tail.flatMap((line) => wrapLine(line, columns))
    const view = wrapped.length <= maxLines ? wrapped : wrapped.slice(wrapped.length - maxLines)
    return view.join('\n')
  }
  const lineIndex = text.slice(0, cursor).split('\n').length - 1
  const col = cursor - lineStart(text, cursor)
  const start = Math.max(0, lineIndex - (maxLines - 1))
  const slice = logical.slice(start, start + maxLines)
  const wrapped: string[] = []
  let caretVisual = 0
  for (let i = 0; i < slice.length; i++) {
    const line = slice[i] ?? ''
    const marked = start + i === lineIndex ? line.slice(0, col) + CURSOR + line.slice(col) : line
    const parts = wrapLine(marked, columns)
    if (start + i === lineIndex) caretVisual = wrapped.length + Math.floor(col / columns)
    wrapped.push(...parts)
  }
  if (wrapped.length <= maxLines) return wrapped.join('\n')
  let viewStart = Math.max(0, caretVisual - (maxLines - 1))
  if (viewStart + maxLines > wrapped.length) viewStart = Math.max(0, wrapped.length - maxLines)
  return wrapped.slice(viewStart, viewStart + maxLines).join('\n')
}

export function clipFieldError(error: string, columns: number, maxLines = 6): string {
  const width = Math.max(1, columns)
  const lines = Math.max(1, maxLines)
  const normalized = error.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const wrapped = normalized.split('\n').flatMap((line) => wrapLine(line, width))
  if (wrapped.length <= lines) return wrapped.join('\n')
  const kept = wrapped.slice(0, lines)
  kept[lines - 1] = trimWithEllipsis(kept[lines - 1] ?? '', width)
  return kept.join('\n')
}

function trimWithEllipsis(line: string, columns: number): string {
  const mark = '...'
  if (columns <= mark.length) return mark.slice(0, columns)
  if (line.length + mark.length <= columns) return line + mark
  return line.slice(0, columns - mark.length) + mark
}

function wrapLine(line: string, columns: number): string[] {
  const width = Math.max(1, columns)
  if (line.length === 0) return ['']
  if (line.length <= width) return [line]
  const parts: string[] = []
  for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width))
  return parts
}

function printableChar(key: EntryKey): string | null {
  if (key.ctrl || key.meta || key.super || key.option) return null
  const name = key.name ?? ''
  if (name === 'space' || name === ' ') return ' '
  if (key.sequence && isOnePrintable(key.sequence)) return key.sequence
  if (name.length === 1 && isOnePrintable(name)) return name
  return null
}

function isOnePrintable(value: string): boolean {
  if (value.length === 0) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 32 || code === 127) return false
  }
  return [...value].length === 1
}

function isPasteChord(key: EntryKey): boolean {
  if (key.option) return false
  if (!key.ctrl && !key.meta && !key.super) return false
  return (key.name ?? '').toLowerCase() === 'v'
}

function clampCursor(text: string, cursor: number): number {
  if (!Number.isFinite(cursor) || cursor <= 0) return 0
  if (cursor >= text.length) return text.length
  return cursor
}

function lineStart(text: string, cursor: number): number {
  if (cursor <= 0) return 0
  return text.lastIndexOf('\n', cursor - 1) + 1
}

function lineEnd(text: string, cursor: number): number {
  const next = text.indexOf('\n', cursor)
  return next === -1 ? text.length : next
}

function stepCursor(text: string, cursor: number, dir: -1 | 1): number {
  if (dir < 0) {
    if (cursor <= 0) return 0
    const code = text.charCodeAt(cursor - 1)
    if (code >= 0xDC00 && code <= 0xDFFF && cursor >= 2) {
      const prev = text.charCodeAt(cursor - 2)
      if (prev >= 0xD800 && prev <= 0xDBFF) return cursor - 2
    }
    return cursor - 1
  }
  if (cursor >= text.length) return text.length
  const code = text.charCodeAt(cursor)
  if (code >= 0xD800 && code <= 0xDBFF && cursor + 1 < text.length) {
    const next = text.charCodeAt(cursor + 1)
    if (next >= 0xDC00 && next <= 0xDFFF) return cursor + 2
  }
  return cursor + 1
}
