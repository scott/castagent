// Stub of @opentui/core that returns no-op renderable classes.
// The real package depends on Bun and tree-sitter; we only need
// the symbols that slash-registry touches at module-load time.
class BoxRenderable {
  add() {} remove() {} getChildren() { return [] } focus() {} blur() {}
  get id() { return 1 }
  set handleKeyPress(fn) {} get handleKeyPress() { return () => false }
}
class TextRenderable {
  constructor(_renderer, opts) { this.content = opts?.content; this._opts = opts }
  add() {}
}
class TextTableRenderable { add() {} }
class StyledText { constructor(c) { this.chunks = c } }
const white = (s) => s, dim = (s) => s, green = (s) => s, yellow = (s) => s, red = (s) => s, cyan = (s) => s
export { BoxRenderable, TextRenderable, TextTableRenderable, StyledText, white, dim, green, yellow, red, cyan }
