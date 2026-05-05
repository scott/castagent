import {BoxRenderable} from '@opentui/core'
import type {CliRenderer, KeyEvent} from '@opentui/core'
import {createHeader} from '../components/header.js'
import type {Mode, UiMode} from '../components/header.js'
import {createMessages} from '../components/messages.js'
import {createInput} from '../components/input.js'
import {createAutocomplete} from '../components/autocomplete.js'
import {executeSlashCommand, slashCommands} from '../commands/slash-registry.js'
const {A2AClient} = await import('../../../cast-cli/dist/lib/a2a/client.js')

export async function showChatScreen(
  renderer: CliRenderer,
  initialAgentName: string,
  initialAgentUrl: string,
  authToken?: string,
  uiMode: UiMode = 'dev',
  initialWelcome?: string,
): Promise<void> {
  return new Promise((resolve) => {
    // Remove previous screen (e.g. welcome screen)
    for (const child of renderer.root.getChildren()) {
      renderer.root.remove(child.id)
    }

    // Mutable state for /connect
    let agentName = initialAgentName
    let agentUrl = initialAgentUrl
    let client = new A2AClient(agentUrl, authToken)
    let mode: Mode = 'plan'

    // Message tracking for /save and /copy
    let messageHistory: Array<{role: 'user' | 'agent'; text: string}> = []
    let lastAgentMessage: string | undefined

    // Track if autocomplete just set the value (to avoid re-showing dropdown)
    let autocompleteJustSelected = false

    function cleanupLayout(layout: BoxRenderable) {
      for (const child of renderer.root.getChildren()) {
        renderer.root.remove(child.id)
      }
    }

    // Build the layout
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

    // Display initial welcome message from the builder agent (e.g., edit mode summary)
    if (initialWelcome) {
      messages.addAgentMessage(initialWelcome, mode)
      messageHistory.push({role: 'agent', text: initialWelcome})
      lastAgentMessage = initialWelcome
    }

    // Autocomplete dropdown
    const autocompleteOptions = slashCommands.map((cmd) => ({
      name: cmd.name,
      description: cmd.description,
    }))

    const autocomplete = createAutocomplete(renderer, autocompleteOptions, (option) => {
      autocompleteJustSelected = true
      inputComp.input.setText(`/${option.name} `)
      inputComp.input.focus()
      // Brief timeout so the input event handler sees the flag
      setTimeout(() => {
        autocompleteJustSelected = false
      }, 50)
    })

    const inputComp = createInput(renderer, async (text) => {
      const trimmed = text.trim()
      if (!trimmed) return

      // Hide autocomplete on submit
      autocomplete.hide()

      // Parse slash commands
      if (trimmed.startsWith('/')) {
        const parts = trimmed.slice(1).split(' ')
        const cmdName = parts[0]
        const args = parts.slice(1).filter(Boolean)

        const ctx = {
          agentName,
          agentUrl,
          authToken,
          mode,
          renderer,
          client,
          messages,
          input: inputComp.input,
          setMode: (newMode: 'plan' | 'build') => {
            mode = newMode
            header.setMode(mode)
          },
          reinitializeChat: async (newName: string, newUrl: string, newToken?: string) => {
            agentName = newName
            agentUrl = newUrl
            client = new A2AClient(newUrl, newToken)
            messageHistory = []
            lastAgentMessage = undefined
            header.setAgentName(agentName)

            // Clear messages
            for (const child of messages.scrollBox.getChildren()) {
              messages.scrollBox.remove(child.id)
            }

            messages.addAgentMessage(`Connected to ${agentName} at ${agentUrl}`, mode)
          },
          exitTui: () => {
            resolve()
          },
          messageHistory,
          lastAgentMessage,
        }

        const found = await executeSlashCommand(cmdName, args, ctx)
        if (!found) {
          messages.addAgentMessage(
            `Unknown command: /${cmdName}. Type /help for available commands.`,
            mode,
          )
        }
        return
      }

      // Regular user message
      messages.addUserMessage(text)
      messageHistory.push({role: 'user', text})

      try {
        const stream = messages.addStreamingAgentMessage(mode)
        let fullResponse = ''
        for await (const chunk of client.sendMessageStream(text)) {
          stream.update(chunk)
          fullResponse += chunk
        }
        stream.done()
        lastAgentMessage = fullResponse
        messageHistory.push({role: 'agent', text: fullResponse})
      } catch (err) {
        const errorMsg = `Error: ${err instanceof Error ? err.message : String(err)}`
        messages.addAgentMessage(errorMsg, mode)
      }
    })
    layout.add(inputComp.box)

    // Add autocomplete floating box to root (not layout) so it overlays properly
    renderer.root.add(autocomplete.box)

    renderer.root.add(layout)
    inputComp.input.focus()

    // Keyboard handler
    const onKey = (key: KeyEvent) => {
      // Global exit shortcut
      if (key.ctrl && key.name === 'c') {
        resolve()
        return
      }

      // Autocomplete navigation
      if (autocomplete.isVisible()) {
        if (key.name === 'up') {
          autocomplete.moveUp()
          return
        }
        if (key.name === 'down') {
          autocomplete.moveDown()
          return
        }
        if (key.name === 'return' || key.name === 'enter') {
          autocomplete.selectCurrent()
          return
        }
        if (key.name === 'escape') {
          autocomplete.hide()
          return
        }
      }

      // Tab toggles mode
      if (key.name === 'tab') {
        mode = mode === 'plan' ? 'build' : 'plan'
        header.setMode(mode)
        return
      }
    }

    renderer.keyInput.on('keypress', onKey)

    // Listen to input changes for autocomplete
    inputComp.input.onContentChange = () => {
      if (autocompleteJustSelected) {
        return
      }
      autocomplete.setInputValue(inputComp.input.plainText)
    }
  })
}
