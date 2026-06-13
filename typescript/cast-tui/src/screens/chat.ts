import {BoxRenderable} from '@opentui/core'
import type {CliRenderer, KeyEvent} from '@opentui/core'
import {createHeader} from '../components/header.js'
import type {Mode, UiMode} from '../components/header.js'
import {createMessages} from '../components/messages.js'
import {createInput} from '../components/input.js'
import {createAutocomplete} from '../components/autocomplete.js'
import {executeSlashCommand, getSlashCommands} from '../commands/slash-registry.js'
import {getDb} from '../lib/db.js'
import {loadMotd} from '../lib/motd.js'
import {VERSION} from '../constants.js'

export async function showChatScreen(
  renderer: CliRenderer,
  initialAgentName: string,
  initialAgentUrl: string,
  authToken?: string,
  uiMode: UiMode = 'dev',
  initialWelcome?: string,
): Promise<void> {
  const {A2AClient} = await import('../../../cast-cli/dist/lib/a2a/client.js')
  
  return new Promise(async (resolve) => {
    // Remove previous screen (e.g. welcome screen)
    for (const child of renderer.root.getChildren()) {
      renderer.root.remove(child.id)
    }

    // Mutable state for /connect
    let agentName = initialAgentName
    let agentUrl = initialAgentUrl
    let client = new A2AClient(agentUrl, authToken)
    let mode: Mode = 'plan'
    let currentUiMode: UiMode = uiMode

// Message tracking for /save and /copy
    let messageHistory: Array<{role: 'user' | 'agent'; text: string}> = []
    let lastAgentMessage: string | undefined

    // Get deployed version for initial agent
    let deployedVersion: string | null = null
    const db = await getDb()
    if (db) {
      const deployment = db.getDeployment(agentName)
      if (deployment) {
        deployedVersion = deployment.deployed_version ?? null
      }
    }

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

    const header = createHeader(renderer, agentName, mode, currentUiMode, deployedVersion)
    layout.add(header.box)

    const messages = createMessages(renderer, currentUiMode)
    layout.add(messages.scrollBox)

    if (currentUiMode === 'production') {
      messages.showProductionIndicator()
    }

    // Display initial welcome message from the builder agent (e.g., edit mode summary)
    if (initialWelcome) {
      messages.addAgentMessage(initialWelcome, mode)
      messageHistory.push({role: 'agent', text: initialWelcome})
      lastAgentMessage = initialWelcome
    }

    // In on-host mode, try to load and display the Message of the Day
    if (currentUiMode === 'on-host') {
      const motd = loadMotd()
      if (motd) {
        const header = [
          `\u250C\u2500 ${agentName} ${'\u2500'.repeat(Math.max(0, 46 - agentName.length))}\u2510`,
          `\u2502  cast v${VERSION}`,
          `\u2502  Connected to ${agentUrl}`,
          `\u2514${'\u2500'.repeat(50)}\u2518`,
          '',
          motd,
          '',
          '\u2500'.repeat(52),
          'Type a message and press Enter to talk to the agent.',
          'Type /help for available commands.',
          'Press Ctrl+C to exit.',
        ].join('\n')
        messages.addAgentMessage(header, mode)
        messageHistory.push({role: 'agent', text: `[MOTD shown — ${agentName}]`})
      }
    }

    // Autocomplete dropdown — filtered by current UI mode
    const autocompleteOptions = getSlashCommands(currentUiMode).map((cmd) => ({
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
          uiMode: currentUiMode,
          renderer,
          client,
          messages,
          input: inputComp.input,
          setMode: (newMode: 'plan' | 'build') => {
            mode = newMode
            header.setMode(mode)
          },
          reinitializeChat: async (newName: string, newUrl: string, newToken?: string, newUiMode?: UiMode) => {
            agentName = newName
            agentUrl = newUrl
            client = new A2AClient(newUrl, newToken)
            messageHistory = []
            lastAgentMessage = undefined
            header.setAgentName(agentName)

            // Update deployed version for new agent
            deployedVersion = null
            if (db) {
              const deployment = db.getDeployment(agentName)
              if (deployment) {
                deployedVersion = deployment.deployed_version ?? null
              }
            }
            header.setDeployedVersion(deployedVersion)

            // Update uiMode if provided, otherwise apply current uiMode to header/messages
            if (newUiMode) {
              currentUiMode = newUiMode
            }
            header.setUiMode(currentUiMode)
            messages.setUiMode(currentUiMode)

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
        let uiAction: Record<string, unknown> | undefined

        for await (const chunk of client.sendMessageStream(text)) {
          stream.update(chunk.text)
          fullResponse += chunk.text
          if (chunk.uiAction) {
            uiAction = chunk.uiAction
          }
        }
        stream.done()
        lastAgentMessage = fullResponse
        messageHistory.push({role: 'agent', text: fullResponse})

        // Handle uiAction (e.g., open deploy modal)
        if (uiAction && uiAction.type === 'open_deploy_modal') {
          // Use provided agent_name or fall back to current agent in context
          const deployAgentName = (uiAction.agent_name as string) || agentName
          const deployProvider = uiAction.provider as string
          
          console.error('DEBUG: uiAction detected, calling handleDeployModal')
          
          // Capture renderer and messages for the async import callback
          const currentRenderer = renderer
          const currentMessages = messages
          
          try {
            // Import and call deploy handler
            const {handleDeployModal} = await import('../components/terminal.js')
            await handleDeployModal(currentRenderer, inputComp.input, deployAgentName, deployProvider, currentMessages)
            console.error('DEBUG: handleDeployModal completed')
          } catch (err: any) {
            console.error('DEBUG handleDeployModal error:', err.message)
            messages.addAgentMessage(`Deploy error: ${err.message}`, mode)
          }
        }
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

      // Check for visible modals in renderer root children
      // Modals are typically added to renderer.root with zIndex >= 100 and visible = true
      if (key.name === 'escape') {
        for (const child of renderer.root.getChildren()) {
          if (child.visible && (child as any).handleKeyPress) {
            const handled = (child as any).handleKeyPress(key)
            if (handled) {
              return
            }
          }
        }
      }

      // Tab toggles mode (disabled in on-host mode)
      if (key.name === 'tab' && currentUiMode !== 'on-host') {
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
