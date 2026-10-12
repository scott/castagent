import {BoxRenderable} from '@opentui/core'
import type {CliRenderer, KeyEvent} from '@opentui/core'
import {createHeader} from '../components/header.js'
import type {Mode, UiMode} from '../components/header.js'
import {createMessages} from '../components/messages.js'
import {createInput} from '../components/input.js'
import {createAutocomplete} from '../components/autocomplete.js'
import {executeSlashCommand, getSlashCommands} from '../commands/slash-registry.js'
import {getDb} from '../lib/db.js'
import {
  createSession as createSessionStore,
  getSession,
  appendMessage as appendSessionMessage,
  endSession,
  type Session,
} from '../lib/sessions.js'
import type {A2AClient} from '../../../cast-cli/dist/lib/a2a/client.js'

/**
 * Fetch the agent's card via A2A and display a natural-language
 * introduction as the first chat message. Falls back to a simple
 * welcome if the card is unavailable.
 */
async function showAgentIntro(
  client: A2AClient,
  agentName: string,
  messages: any,
  mode: 'plan' | 'build',
  messageHistory: Array<{role: 'user' | 'agent'; text: string}>,
  setLastMessage: (text: string) => void,
): Promise<void> {
  try {
    const card = await client.getAgentCard()
    const lines: string[] = []
    lines.push(`Hello!  I'm **${card.name}**.`)
    if (card.description) {
      lines.push('')
      lines.push(card.description)
    }
    if (card.skills && card.skills.length > 0) {
      lines.push('')
      lines.push('I can help you with:')
      for (const skill of card.skills) {
        if (skill.name && skill.description) {
          lines.push(`  - **${skill.name}**: ${skill.description}`)
        } else if (skill.name) {
          lines.push(`  - ${skill.name}`)
        }
      }
    }
    lines.push('')
    lines.push('How can I help you today?')
    const intro = lines.join('\n')
    messages.addAgentMessage(intro, mode)
    messageHistory.push({role: 'agent', text: intro})
    setLastMessage(intro)
  } catch {
    const fallback = `Hello!  I'm **${agentName}**.  Type a message and press Enter to chat with me.\n\nType /help for available commands or press Ctrl+C to exit.`
    messages.addAgentMessage(fallback, mode)
    messageHistory.push({role: 'agent', text: fallback})
    setLastMessage(fallback)
  }
}

export async function showChatScreen(
  renderer: CliRenderer,
  initialAgentName: string,
  initialAgentUrl: string,
  authToken?: string,
  uiMode: UiMode = 'dev',
  initialWelcome?: string,
  initialSessionId?: string,
  edgeToken?: string,
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
    let client = new A2AClient(agentUrl, authToken, edgeToken)
    let mode: Mode = 'plan'
    let currentUiMode: UiMode = uiMode

// Message tracking for /save and /copy
    let messageHistory: Array<{role: 'user' | 'agent'; text: string}> = []
    let lastAgentMessage: string | undefined
    // Bound to an active session id once /session new or the first chat
    // message creates one. Slash commands can swap this out.
    let currentSessionId: string | null = initialSessionId ?? null

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

    // In on-host mode, show a natural-language introduction from the
    // agent itself (fetched via A2A agent/card) instead of repeating
    // the technical banner that's already in the SSH MOTD.
    if (currentUiMode === 'on-host') {
      showAgentIntro(client, agentName, messages, mode, messageHistory, (msg) => { lastAgentMessage = msg })
    }

    // If launched with --session <id>, load the transcript before the
    // user sees the empty chat. We replay the messages into the chat
    // and bind the session id so future turns get appended to it.
    if (initialSessionId) {
      try {
        const sess: Session | null = await getSession(initialSessionId)
        if (sess) {
          for (const m of sess.messages) {
            if (m.role === 'user') {
              messages.addUserMessage(m.text)
            } else {
              messages.addAgentMessage(m.text, mode)
            }
            messageHistory.push({role: m.role, text: m.text})
            if (m.role === 'agent') {
              lastAgentMessage = m.text
            }
          }
          currentSessionId = sess.id
        }
      } catch {
        // ignore — start a fresh session on first message
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
            const nextEdge = newUrl.includes('.microvm.ondigitalocean.com') ? edgeToken : undefined
            client = new A2AClient(newUrl, newToken, nextEdge)
            messageHistory = []
            lastAgentMessage = undefined
            if (currentSessionId) {
              void endSession(currentSessionId)
              currentSessionId = null
            }
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
          get currentSessionId() {
            return currentSessionId
          },
          set currentSessionId(v: string | null) {
            currentSessionId = v
          },
          loadSession: async (sessionId: string) => {
            const sess: Session | null = await getSession(sessionId)
            if (!sess) {
              throw new Error(`Session not found: ${sessionId}`)
            }
            // Clear current chat
            for (const child of messages.scrollBox.getChildren()) {
              messages.scrollBox.remove(child.id)
            }
            messageHistory = []
            lastAgentMessage = undefined
            // Replay transcript
            for (const m of sess.messages) {
              if (m.role === 'user') {
                messages.addUserMessage(m.text)
              } else {
                messages.addAgentMessage(m.text, mode)
              }
              messageHistory.push({role: m.role, text: m.text})
              lastAgentMessage = m.role === 'agent' ? m.text : lastAgentMessage
            }
            currentSessionId = sess.id
          },
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

      // Lazily create a session for this conversation. Best-effort: a
      // failure to create or append must not break the chat.
      if (!currentSessionId) {
        try {
          const sess = await createSessionStore({
            agentName: agentName,
            mode: mode,
            uiMode: currentUiMode,
          })
          currentSessionId = sess.id
        } catch {
          // ignore — chat continues without session persistence
        }
      }
      if (currentSessionId) {
        void appendSessionMessage(currentSessionId, 'user', text)
      }

      let stream: ReturnType<typeof messages.addStreamingAgentMessage> | undefined
      try {
        stream = messages.addStreamingAgentMessage(mode)
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

        if (currentSessionId) {
          void appendSessionMessage(currentSessionId, 'agent', fullResponse, uiAction)
        }

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
        stream?.cancel()
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
        if (currentSessionId) {
          void endSession(currentSessionId)
          currentSessionId = null
        }
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
