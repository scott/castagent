export type SlashKeyAction = 'insert' | 'passthrough' | 'ignore'

export function slashKeyAction(opts: {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  inputFocused: boolean
  modalOpen: boolean
}): SlashKeyAction {
  if (opts.key !== '/' || opts.ctrl || opts.meta || opts.alt) {
    return 'passthrough'
  }
  if (opts.modalOpen) {
    return 'ignore'
  }
  if (opts.inputFocused) {
    return 'passthrough'
  }
  return 'insert'
}
