import {BoxRenderable} from '@opentui/core'
import type {Renderable, KeyEvent, RenderContext} from '@opentui/core'

export interface ModalOptions {
  width?: number | string
  height?: number | string
  title?: string
  centered?: boolean
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
  // Calculate centered position based on width/height
  // For percentage values, center = (100 - value) / 2
  const width = options.width ?? '60%'
  const height = options.height ?? '40%'

  let top: string
  let left: string

  if (options.centered) {
    // Parse percentage values and calculate centered position
    const widthNum = typeof width === 'number' ? width : parseFloat(width as string)
    const heightNum = typeof height === 'number' ? height : parseFloat(height as string)

    if (!isNaN(widthNum)) {
      left = `${(100 - widthNum) / 2}%`
    } else {
      left = '50%'
    }

    if (!isNaN(heightNum)) {
      top = `${(100 - heightNum) / 2}%`
    } else {
      top = '50%'
    }
  } else {
    top = '30%'
    left = '20%'
  }

  const box = new BoxRenderable(ctx, {
    width: width as number | 'auto' | `${number}%`,
    height: height as number | 'auto' | `${number}%`,
    position: 'absolute',
    top: top as any,
    left: left as any,
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
