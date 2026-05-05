import {BoxRenderable} from '@opentui/core'
import type {Renderable, KeyEvent, RenderContext} from '@opentui/core'

export interface ModalOptions {
  width?: number | string
  height?: number | string
  title?: string
}

export interface ModalComponent {
  box: BoxRenderable
  show(): void
  hide(): void
  setTitle(title: string): void
  setContent(content: Renderable): void
  isVisible(): boolean
}

export function createModal(
  ctx: RenderContext,
  previouslyFocused: Renderable,
  options: ModalOptions = {},
): ModalComponent {
  const box = new BoxRenderable(ctx, {
    width: (options.width ?? '60%') as number | 'auto' | `${number}%`,
    height: (options.height ?? '40%') as number | 'auto' | `${number}%`,
    position: 'absolute',
    top: '30%',
    left: '20%',
    zIndex: 100,
    visible: false,
    backgroundColor: '#333333',
    border: true,
    borderColor: '#FFFFFF',
    borderStyle: 'single',
    padding: 1,
    title: options.title,
    focusable: true,
  })

  let currentContent: Renderable | null = null

  function show(): void {
    box.visible = true
    box.focus()
  }

  function hide(): void {
    box.visible = false
    box.blur()
    previouslyFocused.focus()
  }

  function setTitle(title: string): void {
    box.title = title
  }

  function setContent(content: Renderable): void {
    if (currentContent) {
      box.remove(currentContent.id)
    }
    currentContent = content
    box.add(content)
  }

  function isVisible(): boolean {
    return box.visible
  }

  box.handleKeyPress = function (key: KeyEvent): boolean {
    if (key.name === 'escape') {
      hide()
      return true
    }
    return false
  }

  return {
    box,
    show,
    hide,
    setTitle,
    setContent,
    isVisible,
  }
}
