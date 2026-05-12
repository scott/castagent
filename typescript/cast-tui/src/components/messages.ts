import {ScrollBoxRenderable, TextRenderable, BoxRenderable, StyledText, stringToStyledText, blue, green, yellow, dim, red, cyan, magenta, TextAttributes} from '@opentui/core'
import {markdownToStyledText} from '../lib/markdown.js'
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
  setUiMode(mode: UiMode): void
}

export function createMessages(ctx: any, uiMode: UiMode): MessagesComponent {
  let isProduction = uiMode === 'production'

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
    const row = new BoxRenderable(ctx, {
      width: '100%',
      flexDirection: 'row',
    })
    const prefix = new TextRenderable(ctx, {
      content: new StyledText([blue('\u25b8 ')]),
    })
    const body = new TextRenderable(ctx, {
      content: stringToStyledText(text),
      wrapMode: 'word',
      flexGrow: 1,
    })
    row.add(prefix)
    row.add(body)
    scrollBox.add(row)
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

    let prefixStyled
    if (messageType === 'error') {
      prefixStyled = red('\u25b9 ')
    } else if (messageType === 'thinking') {
      prefixStyled = dim(magenta('\u25b9 '))
    } else if (messageType === 'tool') {
      prefixStyled = cyan('\u25b9 ')
    } else {
      prefixStyled = mode === 'build' ? yellow('\u25b9 ') : green('\u25b9 ')
    }

    const row = new BoxRenderable(ctx, {
      width: '100%',
      flexDirection: 'row',
    })
    const prefix = new TextRenderable(ctx, {
      content: new StyledText([prefixStyled]),
    })
    const body = new TextRenderable(ctx, {
      content: markdownToStyledText(messageText),
      wrapMode: 'word',
      flexGrow: 1,
    })
    if (messageType === 'thinking') {
      body.attributes = TextAttributes.DIM
    }
    row.add(prefix)
    row.add(body)
    scrollBox.add(row)
  }

  function addStreamingAgentMessage(mode: Mode): StreamingMessage {
    const prefixStyled = mode === 'build' ? yellow('\u25b9 ') : green('\u25b9 ')
    let fullText = ''

    const row = new BoxRenderable(ctx, {
      width: '100%',
      flexDirection: 'row',
    })
    const prefix = new TextRenderable(ctx, {
      content: new StyledText([prefixStyled]),
    })
    const body = new TextRenderable(ctx, {
      content: stringToStyledText('\u25cf\u25cf\u25cf'),
      wrapMode: 'word',
      flexGrow: 1,
    })
    body.attributes = TextAttributes.DIM
    row.add(prefix)
    row.add(body)
    scrollBox.add(row)

    return {
      update(text: string) {
        fullText += text
        body.content = markdownToStyledText(fullText)
        body.attributes = TextAttributes.DIM
        body.requestRender()
      },
      done() {
        body.content = markdownToStyledText(fullText || '(no response)')
        body.attributes = TextAttributes.NONE
        body.requestRender()
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

  function setUiMode(newUiMode: UiMode) {
    isProduction = newUiMode === 'production'
    if (isProduction) {
      showProductionIndicator()
    }
  }

  return {scrollBox, addUserMessage, addAgentMessage, addStreamingAgentMessage, showProductionIndicator, setUiMode}
}
