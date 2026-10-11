import {ScrollBoxRenderable, TextRenderable, BoxRenderable, StyledText, stringToStyledText, blue, green, yellow, dim, red, cyan, magenta, TextAttributes} from '@opentui/core'
import {markdownToStyledText} from '../lib/markdown.js'
import {loadingFrame, stopLoading} from '../lib/loading-indicator.js'
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
  cancel(): void
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
  let isProduction = uiMode === 'production' || uiMode === 'on-host'

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
    const spinnerColor = mode === 'build' ? yellow : green
    let fullText = ''
    let indicator = true
    const startedAt = Date.now()
    let tick = 0
    const stopState = {stopped: false}

    function frameStyled(frameTick: number): StyledText {
      const text = loadingFrame(frameTick, Date.now() - startedAt, mode)
      return new StyledText([spinnerColor(text.slice(0, 1)), dim(text.slice(1))])
    }

    const row = new BoxRenderable(ctx, {
      width: '100%',
      flexDirection: 'row',
    })
    const prefix = new TextRenderable(ctx, {
      content: new StyledText([prefixStyled]),
    })
    const body = new TextRenderable(ctx, {
      content: frameStyled(0),
      wrapMode: 'word',
      flexGrow: 1,
    })
    row.add(prefix)
    row.add(body)
    scrollBox.add(row)

    let timer: ReturnType<typeof setInterval> | undefined

    function clearTimer() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }

    function halt() {
      stopLoading(stopState, clearTimer)
    }

    timer = setInterval(() => {
      // /clear and session reloads drop the row without calling cancel.
      if (!indicator || !row.parent || !scrollBox.getChildren().includes(row)) {
        indicator = false
        halt()
        return
      }
      tick += 1
      body.content = frameStyled(tick)
      body.requestRender()
    }, 80)

    return {
      update(text: string) {
        // A blank chunk must not dismiss the indicator before real text arrives.
        if (!text) return
        indicator = false
        halt()
        fullText += text
        body.content = markdownToStyledText(fullText)
        body.attributes = TextAttributes.DIM
        body.requestRender()
      },
      done() {
        indicator = false
        halt()
        body.content = markdownToStyledText(fullText || '(no response)')
        body.attributes = TextAttributes.NONE
        body.requestRender()
      },
      cancel() {
        const removeIndicator = indicator
        indicator = false
        halt()
        if (removeIndicator) {
          scrollBox.remove(row.id)
        }
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
    isProduction = newUiMode === 'production' || newUiMode === 'on-host'
    if (isProduction) {
      showProductionIndicator()
    }
  }

  return {scrollBox, addUserMessage, addAgentMessage, addStreamingAgentMessage, showProductionIndicator, setUiMode}
}
