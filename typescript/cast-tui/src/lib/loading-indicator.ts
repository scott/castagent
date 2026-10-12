const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

/** Braille frame plus a dim "Working" label. Color is applied by the caller. */
export function loadingFrame(tick: number, elapsedMs: number, mode: 'plan' | 'build'): string {
  void mode
  const count = FRAMES.length
  const index = ((tick % count) + count) % count
  let text = `${FRAMES[index]} Working`
  if (elapsedMs >= 1000) {
    text += `  ${Math.floor(elapsedMs / 1000)}s`
  }
  return text
}

/** Run clear once. A second call does not throw and does not clear again. */
export function stopLoading(state: {stopped: boolean}, clear: () => void): void {
  if (state.stopped) return
  state.stopped = true
  clear()
}
