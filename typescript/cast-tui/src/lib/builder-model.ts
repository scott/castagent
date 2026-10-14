/**
 * Builder-model picker logic with no OpenTUI imports.
 * slash-registry cannot be loaded under Node, so tests transpile this file.
 */

export interface BuilderModelInfo {
  id: string
  provider: string
  family: string
}

export const BUILDER_MODEL_MODAL_TITLE = 'Builder Model'

export const CAST_CLI_NOT_FOUND = 'cast CLI not found in PATH.'

/** `/model` is registered with modes: ['dev'] only. */
export function isBuilderModelCommandVisible(mode: 'dev' | 'production' | 'on-host'): boolean {
  return mode === 'dev'
}

export function sortBuilderModels<T extends {id: string}>(models: readonly T[]): T[] {
  return [...models].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/**
 * Catalog ids have no provider prefix. The default config stores
 * `openrouter/minimax/minimax-m2.5`, which is the same catalog row.
 */
export function builderModelCatalogId(id: string): string {
  const prefix = 'openrouter/'
  return id.startsWith(prefix) ? id.slice(prefix.length) : id
}

export function isSameBuilderModel(currentId: string, selectedId: string): boolean {
  return builderModelCatalogId(currentId) === builderModelCatalogId(selectedId)
}

export function initialBuilderModelIndex(models: readonly {id: string}[], currentId: string): number {
  const index = models.findIndex(model => isSameBuilderModel(model.id, currentId))
  return index >= 0 ? index : 0
}

export function wrapBuilderModelIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const next = (index + delta) % length
  return next < 0 ? next + length : next
}

/**
 * Slice of the catalog that keeps `selected` on screen. The modal is
 * shorter than the catalog, so rendering every row hides the cursor.
 */
export function builderModelWindow(
  length: number,
  selected: number,
  maxRows: number,
): {start: number; end: number} {
  if (length <= 0 || maxRows <= 0) return {start: 0, end: 0}
  const size = Math.min(maxRows, length)
  let start = Math.max(0, selected - Math.floor((size - 1) / 2))
  if (start + size > length) start = Math.max(0, length - size)
  return {start, end: start + size}
}

/** Modal width and height match createModal's 90% by 80% defaults. */
export const BUILDER_MODEL_MODAL_WIDTH_RATIO = 0.9
export const BUILDER_MODEL_MODAL_HEIGHT_RATIO = 0.8

/**
 * Outer modal rows. `floor` is the smallest height OpenTUI resolves for
 * this percentage, so the list never plans on a taller box than it gets.
 */
export function builderModelModalOuterRows(termHeight: number): number {
  const height = Number.isFinite(termHeight) && termHeight > 0 ? Math.floor(termHeight) : 24
  return Math.floor(height * BUILDER_MODEL_MODAL_HEIGHT_RATIO)
}

/**
 * Rows available to the lines inside the border and the content paddingTop.
 * The border is one row on top and one on the bottom. The content box uses
 * paddingTop 2 and no paddingBottom.
 */
export function builderModelModalInnerRows(termHeight: number): number {
  return Math.max(0, builderModelModalOuterRows(termHeight) - 4)
}

/** Columns inside the 90% modal after the border and horizontal padding. */
export function builderModelContentColumns(termWidth: number): number {
  if (!Number.isFinite(termWidth) || termWidth <= 0) return 60
  return Math.max(16, Math.floor(termWidth * BUILDER_MODEL_MODAL_WIDTH_RATIO) - 6)
}

const BUILDER_MODEL_FIXED_CHROME = 4
const BUILDER_MODEL_ELLIPSIS_ROWS = 2
const BUILDER_MODEL_ERROR_ROWS = 2

/**
 * Catalog rows that fit without flex-shrink.
 *
 * The current id, the rule, a blank line, and the footer are always
 * drawn. Both ellipses are reserved too, so the count does not change
 * as the window scrolls. An inline error adds a blank line and the
 * message.
 *
 * Asking for more rows than this makes the column shrink each text
 * node onto the next one. A shorter id then paints over a longer one
 * and leaves the tail (`instructnstruct`), and the highlight sits on
 * a different row than the selection.
 */
export function builderModelMaxRows(termHeight: number, hasError = false): number {
  const reserved = BUILDER_MODEL_FIXED_CHROME
    + BUILDER_MODEL_ELLIPSIS_ROWS
    + (hasError ? BUILDER_MODEL_ERROR_ROWS : 0)
  const room = builderModelModalInnerRows(termHeight) - reserved
  return room >= 1 ? room : 1
}

export type BuilderModelLineTone = 'text' | 'hint' | 'error'

export interface BuilderModelLine {
  text: string
  tone: BuilderModelLineTone
}

/**
 * One screen row. Newlines are flattened so an error cannot wrap into
 * the next id. Shorter text is padded so it covers the previous id.
 */
export function fitBuilderModelLine(text: string, columns: number): string {
  const single = text.replace(/[\r\n]+/g, ' ')
  const shown = single.length > 0 ? single : ' '
  if (!Number.isFinite(columns) || columns <= 0) return shown
  if (shown.length > columns) return shown.slice(0, columns)
  return shown.padEnd(columns, ' ')
}

/** Enter on the current row does not call the CLI. */
export function shouldApplyBuilderModel(currentId: string, selectedId: string): boolean {
  return !isSameBuilderModel(currentId, selectedId)
}

export function builderModelListArgv(): string[] {
  return ['model', '--list', '--json']
}

export function builderModelCurrentArgv(): string[] {
  return ['model', '--current', '--json']
}

export function builderModelApplyArgv(id: string): string[] {
  return ['model', id]
}

/** Selected row starts with `▸ `; other rows start with two spaces. */
export function formatBuilderModelRow(id: string, selected: boolean, current: boolean): string {
  const prefix = selected ? '▸ ' : '  '
  return current ? `${prefix}${id}  (current)` : `${prefix}${id}`
}

const BUILDER_MODEL_RULE = '─'.repeat(56)

/**
 * Lines for one frame of the picker. Every catalog id in the window is
 * its own row, the selected id is the only row that starts with `▸`,
 * and the line count fits in the modal.
 */
export function buildBuilderModelLines(options: {
  models: readonly {id: string}[]
  selected: number
  currentId: string
  termHeight: number
  columns: number
  error?: string | null
}): BuilderModelLine[] {
  const columns = options.columns
  const error = options.error && options.error.trim() ? options.error : null
  const push = (text: string, tone: BuilderModelLineTone, lines: BuilderModelLine[]) => {
    lines.push({text: fitBuilderModelLine(text, columns), tone})
  }

  if (options.models.length === 0 && error) {
    const lines: BuilderModelLine[] = []
    push(error, 'error', lines)
    push(' ', 'text', lines)
    push('ESC Close', 'hint', lines)
    return lines
  }

  const selected = options.models.length === 0
    ? 0
    : Math.min(Math.max(options.selected, 0), options.models.length - 1)
  const span = builderModelWindow(
    options.models.length,
    selected,
    builderModelMaxRows(options.termHeight, error !== null),
  )
  const lines: BuilderModelLine[] = []
  push(`Current: ${options.currentId || '(unset)'}`, 'text', lines)
  push(BUILDER_MODEL_RULE, 'hint', lines)
  if (span.start > 0) push('  …', 'hint', lines)
  for (let index = span.start; index < span.end; index++) {
    const model = options.models[index]
    push(formatBuilderModelRow(
      model.id,
      index === selected,
      isSameBuilderModel(model.id, options.currentId),
    ), 'text', lines)
  }
  if (span.end < options.models.length) push('  …', 'hint', lines)
  if (error) {
    push(' ', 'text', lines)
    push(error, 'error', lines)
  }
  push(' ', 'text', lines)
  push('↑↓ Select   Enter Apply   ESC Close', 'hint', lines)
  return lines
}

/** ESC returns focus to the chat input passed to createModal. */
export function builderModelFocusReturnTarget(): 'input' {
  return 'input'
}

export function builderModelSuccessMessage(id: string, agentName: string): string {
  return `Builder model changed to ${id}.\nRestart the builder to apply: cast dev ${agentName}`
}
