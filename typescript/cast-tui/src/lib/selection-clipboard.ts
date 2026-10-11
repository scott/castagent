export function copyHighlightedText(text: string, clipboard: {
  osc52(text: string): void
  write(text: string): Promise<unknown>
}): void {
  // Empty clicks are not a selection. Whitespace-only text is.
  if (!text) return
  try {
    clipboard.osc52(text)
  } catch {
    // OSC 52 can throw. The local write still runs.
  }
  try {
    clipboard.write(text).catch(() => {})
  } catch {
    // clipboardy can throw before it returns a promise.
  }
}
