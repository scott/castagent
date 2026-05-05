import {BoxRenderable, TextRenderable, StyledText, white, dim, cyan, bold} from '@opentui/core'

export interface AutocompleteOption {
  name: string
  description: string
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
  let filteredOptions: AutocompleteOption[] = []
  let selectedIndex = 0

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
    // Clear existing children
    for (const child of box.getChildren()) {
      box.remove(child.id)
    }

    for (let i = 0; i < filteredOptions.length; i++) {
      const option = filteredOptions[i]
      const isSelected = i === selectedIndex

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
    if (!value.startsWith('/')) {
      filteredOptions = []
      hide()
      return
    }

    const query = value.slice(1).toLowerCase()
    filteredOptions = allOptions.filter((opt) =>
      opt.name.toLowerCase().startsWith(query)
    )

    if (filteredOptions.length === 0) {
      hide()
    } else {
      selectedIndex = 0
      renderOptions()
      show()
    }
  }

  function show() {
    if (filteredOptions.length > 0) {
      box.visible = true
      box.requestRender?.()
    }
  }

  function hide() {
    box.visible = false
    box.requestRender?.()
  }

  function setOptions(options: AutocompleteOption[]) {
    allOptions = [...options]
  }

  function setInputValue(value: string) {
    filterOptions(value)
  }

  function moveUp() {
    if (filteredOptions.length === 0) return
    selectedIndex =
      (selectedIndex - 1 + filteredOptions.length) % filteredOptions.length
    renderOptions()
    box.requestRender?.()
  }

  function moveDown() {
    if (filteredOptions.length === 0) return
    selectedIndex = (selectedIndex + 1) % filteredOptions.length
    renderOptions()
    box.requestRender?.()
  }

  function selectCurrent(): AutocompleteOption | null {
    if (
      filteredOptions.length === 0 ||
      selectedIndex < 0 ||
      selectedIndex >= filteredOptions.length
    ) {
      return null
    }
    const option = filteredOptions[selectedIndex]
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
