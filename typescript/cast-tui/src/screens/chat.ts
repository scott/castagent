import {BoxRenderable} from '@opentui/core'
import type {CliRenderer, KeyEvent} from '@opentui/core'
import {createHeader} from '../components/header.js'
import type {Mode, UiMode} from '../components/header.js'
import {createMessages} from '../components/messages.js'
import {createInput} from '../components/input.js'

export async function showChatScreen(
  renderer: CliRenderer,
  agentName: string,
  agentUrl: string,
  authToken?: string,
  uiMode: UiMode = 'dev',
): Promise<void> {
  const {A2AClient} = await import('../../../cast-cli/dist/lib/a2a/client.js')

  return new Promise((resolve) => {
    for (const child of renderer.root.getChildren()) {
      renderer.root.remove(child.id)
    }

    let mode: Mode = 'plan'

    const client = new A2AClient(agentUrl, authToken)

    const layout = new BoxRenderable(renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
    })

    const header = createHeader(renderer, agentName, mode, uiMode)
    layout.add(header.box)

    const messages = createMessages(renderer, uiMode)
    layout.add(messages.scrollBox)

    if (uiMode === 'production') {
      messages.showProductionIndicator()
    }

    const inputComp = createInput(renderer, async (text) => {
      messages.addUserMessage(text)
      try {
        const stream = messages.addStreamingAgentMessage(mode)
        for await (const chunk of client.sendMessageStream(text)) {
          stream.update(chunk)
        }
        stream.done()
      } catch (err) {
        messages.addAgentMessage(`Error: ${err instanceof Error ? err.message : String(err)}`, mode)
      }
    })
    layout.add(inputComp.box)

    renderer.root.add(layout)
    inputComp.input.focus()

    const onKey = (key: KeyEvent) => {
      // Debug: log all keys (remove in production)
      // console.error('[TUI KEY]', key.name, key.ctrl, key.shift, key.meta)

      // Global shortcuts only - don't interfere with focused input
      if (key.ctrl && key.name === 'c') {
        renderer.destroy()
        resolve()
        return
      }

      if (key.name === 'tab') {
        mode = mode === 'plan' ? 'build' : 'plan'
        header.setMode(mode)
        return
      }

      // Let all other keys (including Enter/Return) propagate to focused InputRenderable
    }

    renderer.keyInput.on('keypress', onKey)
  })
}
