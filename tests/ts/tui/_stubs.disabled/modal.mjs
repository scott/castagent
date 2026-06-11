// Configurable stub for the modal component.
//
// Each call to `createModal` returns a fresh modal object that records
// its `setContent`, `setTitle`, `show`, `hide` calls on the global
// `__testConfig.modals` array. Tests inspect this array to assert that
// a handler opened the right modal with the right content.
//
// The returned `box` is a no-op stub: it accepts children, supports
// `handleKeyPress` (a getter that returns false by default), and has
// a stable `id` for tests that want to compare references.

if (!globalThis.__testConfig) globalThis.__testConfig = {}
if (!globalThis.__testConfig.modals) globalThis.__testConfig.modals = []

let nextBoxId = 1

export function createModal(renderer, _previouslyFocused, options = {}) {
  const boxId = nextBoxId++
  const box = {
    id: `box-${boxId}`,
    add() {},
    remove() {},
    getChildren() { return [] },
    focus() {},
    blur() {},
    title: options.title ?? '',
    _handleKeyPress: null,
    set handleKeyPress(fn) { this._handleKeyPress = fn },
    get handleKeyPress() { return this._handleKeyPress || (() => false) },
  }

  const modal = {
    box,
    overlay: null,
    title: options.title,
    options,
    _setContent(content) { this._content = content },
    setContent(content) { this._setContent(content) },
    setTitle(title) { this._title = title; box.title = title },
    show() { this._shown = true },
    hide() { this._hidden = true; this._shown = false },
    isVisible() { return !!this._shown },
    _shown: false,
    _hidden: false,
    _content: null,
  }

  globalThis.__testConfig.modals.push(modal)
  return modal
}

export function __resetTestModals() {
  globalThis.__testConfig.modals = []
}

export default {createModal, __resetTestModals}
