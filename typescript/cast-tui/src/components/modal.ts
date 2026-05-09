import {BoxRenderable} from '@opentui/core'
import type {Renderable, KeyEvent, RenderContext} from '@opentui/core'

export interface ModalOptions {
  width?: number | string
  height?: number | string
  title?: string
  centered?: boolean
  overlay?: boolean
}

export interface ModalComponent {
  box: BoxRenderable
  overlay?: BoxRenderable | null
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
  // Default to 90% width and 80% height, centered
  const width = options.width ?? '90%'
  const height = options.height ?? '80%'
  const centered = options.centered ?? true

  let top: string
  let left: string

  if (centered) {
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

  // Create optional overlay background behind the modal
  let overlayBox: BoxRenderable | null = null
  if (options.overlay) {
    overlayBox = new BoxRenderable(ctx, {
      width: '100%',
      height: '100%',
      position: 'absolute',
      top: '0%',
      left: '0%',
      zIndex: 99,
      visible: false,
      backgroundColor: '#1a1a1a',
    })
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
    padding: 0,
    title: options.title,
    focusable: true,
  })

  let currentContent: Renderable | null = null

  function show(): void {
    if (overlayBox) {
      overlayBox.visible = true
    }
    box.visible = true
    box.focus()
  }

  function hide(): void {
    if (overlayBox) {
      overlayBox.visible = false
    }
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
    overlay: overlayBox,
    show,
    hide,
    setTitle,
    setContent,
    isVisible,
  }
}
