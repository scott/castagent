import {BoxRenderable, TextRenderable, StyledText, white, dim} from '@opentui/core'
import type {KeyEvent} from '@opentui/core'
import {createModal} from '../components/modal.js'
import {modalContentColumns} from '../lib/text-entry.js'
import {
  buildPermissionLines,
  initialPermissionIndex,
  permissionKeyDecision,
  type PermissionPromptRequest,
} from '../lib/permission-prompt.js'

/**
 * Ask the user before a tool runs. ESC denies and returns focus to the input.
 * Approve and Deny are a list: up and down wrap, Enter confirms.
 */
export function promptToolPermission(
  renderer: any,
  previouslyFocused: any,
  request: PermissionPromptRequest,
): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = createModal(renderer, previouslyFocused, {
      title: `Allow ${request.tool}`,
      overlay: true,
    })
    modal.box.overflow = 'hidden'
    if (modal.overlay) renderer.root.add(modal.overlay)

    const contentBox = new BoxRenderable(renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      gap: 0,
      paddingTop: 2,
      paddingLeft: 2,
      paddingRight: 2,
      overflow: 'hidden',
      backgroundColor: '#333333',
    })

    let selected = initialPermissionIndex()
    let settled = false

    const clear = () => {
      for (const child of [...contentBox.getChildren()]) contentBox.remove(child.id)
    }

    const addLine = (text: string, tone: 'text' | 'hint') => {
      const color = tone === 'hint' ? dim : white
      contentBox.add(new TextRenderable(renderer, {
        content: new StyledText([color(text)]),
        width: '100%',
        height: 1,
        wrapMode: 'none',
        flexShrink: 0,
      }))
    }

    const render = () => {
      clear()
      const width = typeof renderer?.width === 'number' ? renderer.width : 80
      const lines = buildPermissionLines({
        tool: request.tool,
        args: request.arguments || {},
        selected,
        columns: modalContentColumns(width),
      })
      for (const line of lines) addLine(line.text, line.tone)
      renderer.requestRender?.()
    }

    const finish = (approved: boolean) => {
      if (settled) return
      settled = true
      modal.hide()
      renderer.root.remove(modal.box.id)
      if (modal.overlay) renderer.root.remove(modal.overlay.id)
      resolve(approved)
    }

    modal.setContent(contentBox)
    renderer.root.add(modal.box)
    render()
    modal.show()

    modal.box.handleKeyPress = (key: KeyEvent): boolean => {
      if (key.eventType === 'release') return true
      const action = permissionKeyDecision(key.name, selected)
      if (action.type === 'move') {
        selected = action.selected
        render()
        return true
      }
      if (action.type === 'choose') {
        finish(action.approved)
        return true
      }
      if (action.type === 'deny') {
        finish(false)
        return true
      }
      return true
    }
  })
}
