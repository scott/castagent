import {BoxRenderable, TextRenderable, StyledText, white, dim, cyan, bold} from '@opentui/core'
import {groupSlashCommands, moveSlashSelection, type SlashPickerCategory, type SlashPickerRow} from '../lib/slash-picker.js'

export interface AutocompleteOption {
  name: string
  description: string
  category: SlashPickerCategory
}

export interface AutocompleteComponent {
  box: BoxRenderable
  show(): void
  hide(): void
  setOptions(options: AutocompleteOption[]): void
  setInputValue(value: string): void
  moveUp(): void
  moveDown(): void
  selectCurrent(): AutocompleteOption | null
  isVisible(): boolean
}

export function createAutocomplete(
  ctx: any,
  options: AutocompleteOption[],
  onSelect: (option: AutocompleteOption) => void
): AutocompleteComponent {
  let allOptions: AutocompleteOption[] = [...options]
  let rows: SlashPickerRow<AutocompleteOption>[] = []
  let selectable: AutocompleteOption[] = []
  let selectedIndex = 0
  let lastValue = ''

  const box = new BoxRenderable(ctx, {
    position: 'absolute',
    bottom: 4,
    left: 1,
    right: 1,
    zIndex: 50,
    visible: false,
    backgroundColor: '#1a1a1a',
    border: true,
    borderColor: '#666666',
    padding: 1,
    flexDirection: 'column',
  })

  function renderOptions() {
    for (const child of box.getChildren()) {
      box.remove(child.id)
    }

    let commandOrdinal = 0
    for (const row of rows) {
      if (row.kind === 'header') {
        const text = new TextRenderable(ctx, {
          content: new StyledText([dim(`  ${row.label}`)]),
        })
        box.add(text)
        continue
      }

      const option = row.command
      const isSelected = commandOrdinal === selectedIndex
      commandOrdinal++

      const prefix = isSelected ? cyan('▸ ') : white('  ')
      const nameStyle = isSelected
        ? cyan(bold(`/${option.name}`))
        : white(bold(`/${option.name}`))
      const descStyle = dim(` — ${option.description}`)

      const content = new StyledText([prefix, nameStyle, descStyle])
      const text = new TextRenderable(ctx, {
        content,
      })
      box.add(text)
    }
  }

  function filterOptions(value: string) {
    lastValue = value
    if (!value.startsWith('/')) {
      rows = []
      selectable = []
      hide()
      return
    }

    rows = groupSlashCommands(allOptions, value.slice(1))
    selectable = []
    for (const row of rows) {
      if (row.kind === 'command') selectable.push(row.command)
    }

    if (selectable.length === 0) {
      hide()
      return
    }

    selectedIndex = 0
    renderOptions()
    show()
  }

  function show() {
    if (selectable.length > 0) {
      box.visible = true
      box.requestRender?.()
    }
  }

  function hide() {
    box.visible = false
    box.requestRender?.()
  }

  function setOptions(next: AutocompleteOption[]) {
    allOptions = [...next]
    if (box.visible) filterOptions(lastValue)
  }

  function setInputValue(value: string) {
    filterOptions(value)
  }

  function moveUp() {
    if (selectable.length === 0) return
    selectedIndex = moveSlashSelection(selectable.length, selectedIndex, -1)
    renderOptions()
    box.requestRender?.()
  }

  function moveDown() {
    if (selectable.length === 0) return
    selectedIndex = moveSlashSelection(selectable.length, selectedIndex, 1)
    renderOptions()
    box.requestRender?.()
  }

  function selectCurrent(): AutocompleteOption | null {
    if (selectable.length === 0 || selectedIndex < 0 || selectedIndex >= selectable.length) {
      return null
    }
    const option = selectable[selectedIndex]
    hide()
    onSelect(option)
    return option
  }

  function isVisible(): boolean {
    return box.visible
  }

  return {
    box,
    show,
    hide,
    setOptions,
    setInputValue,
    moveUp,
    moveDown,
    selectCurrent,
    isVisible,
  }
}
