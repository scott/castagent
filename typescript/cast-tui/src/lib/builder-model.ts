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

export function initialBuilderModelIndex(models: readonly {id: string}[], currentId: string): number {
  const index = models.findIndex(model => model.id === currentId)
  return index >= 0 ? index : 0
}

export function wrapBuilderModelIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const next = (index + delta) % length
  return next < 0 ? next + length : next
}

/** Enter on the current row does not call the CLI. */
export function shouldApplyBuilderModel(currentId: string, selectedId: string): boolean {
  return selectedId !== currentId
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

/** ESC returns focus to the chat input passed to createModal. */
export function builderModelFocusReturnTarget(): 'input' {
  return 'input'
}

export function builderModelSuccessMessage(id: string, agentName: string): string {
  return `Builder model changed to ${id}.\nRestart the builder to apply: cast dev ${agentName}`
}
