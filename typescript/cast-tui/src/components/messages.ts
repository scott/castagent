import {ScrollBoxRenderable, TextRenderable, StyledText, stringToStyledText, blue, green, yellow, dim, red, cyan, magenta} from '@opentui/core'
import type {Mode, UiMode} from './header.js'

export type MessageType = 'text' | 'thinking' | 'tool' | 'error'

export interface AgentMessage {
  text: string
  type?: MessageType
  isError?: boolean
}

export interface StreamingMessage {
  update(text: string): void
  done(): void
}

export interface MessagesComponent {
  scrollBox: ScrollBoxRenderable
  addUserMessage(text: string): void
  addAgentMessage(content: string | AgentMessage, mode: Mode): void
  addStreamingAgentMessage(mode: Mode): StreamingMessage
  showProductionIndicator(): void
}

export function createMessages(ctx: any, uiMode: UiMode): MessagesComponent {
  const isProduction = uiMode === 'production'

  const scrollBox = new ScrollBoxRenderable(ctx, {
    width: '100%',
    flexGrow: 1,
    scrollY: true,
    stickyScroll: true,
    stickyStart: 'bottom',
    contentOptions: {
      flexDirection: 'column',
      gap: 1,
      padding: 1,
    },
  })

  function addUserMessage(text: string) {
    const prefix = blue('\u25b8 ')
    const body = stringToStyledText(text)
    const styled = new StyledText([prefix, ...body.chunks])
    const msg = new TextRenderable(ctx, {
      content: styled,
      wrapMode: 'word',
    })
    scrollBox.add(msg)
  }

  function addAgentMessage(content: string | AgentMessage, mode: Mode) {
    let messageText: string
    let messageType: MessageType = 'text'
    let isErrorMessage = false

    if (typeof content === 'string') {
      messageText = content
      if (content.startsWith('Error:')) {
        messageType = 'error'
      }
    } else {
      messageText = content.text
      messageType = content.type || 'text'
      isErrorMessage = content.isError || false
    }

    // In production, hide thinking blocks by default
    if (isProduction && messageType === 'thinking') {
      return
    }

    // In production, show tool calls only on error
    if (isProduction && messageType === 'tool' && !isErrorMessage) {
      return
    }

    let prefix
    if (messageType === 'error') {
      prefix = red('\u25b9 ')
    } else if (messageType === 'thinking') {
      prefix = dim(magenta('\u25b9 '))
    } else if (messageType === 'tool') {
      prefix = cyan('\u25b9 ')
    } else {
      prefix = mode === 'build' ? yellow('\u25b9 ') : green('\u25b9 ')
    }

    const body = stringToStyledText(messageText)
    const styled = new StyledText([prefix, ...body.chunks])
    const msg = new TextRenderable(ctx, {
      content: styled,
      wrapMode: 'word',
    })
    scrollBox.add(msg)
  }

  function addStreamingAgentMessage(mode: Mode): StreamingMessage {
    const prefix = mode === 'build' ? yellow('\u25b9 ') : green('\u25b9 ')
    let fullText = ''
    const typingIndicator = stringToStyledText('\u25cf\u25cf\u25cf')
    const styled = new StyledText([prefix, ...typingIndicator.chunks])
    const msg = new TextRenderable(ctx, {
      content: styled,
      wrapMode: 'word',
    })
    scrollBox.add(msg)

    return {
      update(text: string) {
        fullText += text
        const body = stringToStyledText(fullText)
        msg.content = new StyledText([prefix, ...body.chunks])
        msg.requestRender()
      },
      done() {
        const body = stringToStyledText(fullText || '(no response)')
        msg.content = new StyledText([prefix, ...body.chunks])
        msg.requestRender()
      },
    }
  }

  function showProductionIndicator() {
    if (!isProduction) return
    const indicator = new TextRenderable(ctx, {
      content: new StyledText([dim('Production mode - thought process hidden')]),
      wrapMode: 'word',
    })
    scrollBox.add(indicator)
  }

  return {scrollBox, addUserMessage, addAgentMessage, addStreamingAgentMessage, showProductionIndicator}
}
