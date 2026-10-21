import {execFileSync} from 'child_process'
import * as os from 'os'
import {BoxRenderable, TextRenderable, StyledText, white, dim, red} from '@opentui/core'
import type {KeyEvent} from '@opentui/core'
import {createModal} from '../components/modal.js'
import {
  INFERENCE_PROVIDER_MODAL_TITLE,
  formatProviderRow,
  maskSecret,
  parseInferenceUrl,
  parseProviderList,
  providerEnableArgv,
  providerEnterAction,
  providerListArgv,
  providerSuccessMessage,
  providerSwitchArgv,
  wrapProviderIndex,
  type InferenceProviderRow,
  type ProviderField,
} from '../lib/inference-provider.js'

export interface InferenceProviderHost {
  renderer: any
  input: any
  messages: {addAgentMessage: (text: string, mode: 'plan' | 'build') => void}
  mode: 'plan' | 'build'
}

interface CastResult {
  status: number
  stdout: string
  stderr: string
}

function runCast(binary: string, args: string[], input?: string): CastResult {
  try {
    const stdout = execFileSync(binary, args, {
      encoding: 'utf8',
      cwd: os.homedir(),
      timeout: 15000,
      input,
    })
    return {status: 0, stdout: stdout ?? '', stderr: ''}
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : err?.stdout?.toString?.() ?? ''
    const stderr = typeof err?.stderr === 'string' ? err.stderr : err?.stderr?.toString?.() ?? ''
    return {status: typeof err?.status === 'number' ? err.status : 1, stdout, stderr}
  }
}

function failureText(result: CastResult): string {
  const text = `${result.stderr}\n${result.stdout}`.trim()
  return text || 'cast provider failed.'
}

export function openInferenceProviderModal(
  ctx: InferenceProviderHost,
  findCastBinary: () => string | null,
): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: INFERENCE_PROVIDER_MODAL_TITLE,
    overlay: true,
  })
  modal.box.overflow = 'hidden'
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
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

  let rows: InferenceProviderRow[] = []
  let selected = 0
  let field: ProviderField = 'list'
  let token = ''
  let url = ''
  let inlineError: string | null = null

  const reload = (binary: string | null) => {
    if (!binary) {
      inlineError = 'cast CLI not found in PATH.'
      rows = []
      return
    }
    const listed = runCast(binary, providerListArgv())
    if (listed.status !== 0) {
      inlineError = failureText(listed)
      return
    }
    try {
      rows = parseProviderList(listed.stdout)
      const current = rows.findIndex(row => row.current)
      if (current >= 0) selected = current
      inlineError = null
    } catch (err: any) {
      inlineError = err?.message ?? String(err)
      rows = []
    }
  }

  reload(findCastBinary())

  const clear = () => {
    for (const child of [...contentBox.getChildren()]) contentBox.remove(child.id)
  }

  const addLine = (text: string, tone: 'text' | 'hint' | 'error' = 'text') => {
    const color = tone === 'error' ? red : tone === 'hint' ? dim : white
    contentBox.add(new TextRenderable(ctx.renderer, {
      content: new StyledText([color(text)]),
      width: '100%',
      height: 1,
      wrapMode: 'none',
      flexShrink: 0,
    }))
  }

  const render = () => {
    clear()
    if (field === 'list') {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index]
        addLine(formatProviderRow(row, index === selected))
        addLine(`    ${row.baseUrl}`, 'hint')
      }
      if (rows.length === 0 && !inlineError) addLine('No inference providers are registered.')
    } else if (field === 'token') {
      const row = rows[selected]
      addLine(row ? `Token for ${row.displayName}` : 'Token')
      addLine(token.length === 0 ? '_' : maskSecret(token))
      addLine('Enter continues to the URL. The token is not shown.', 'hint')
    } else {
      const row = rows[selected]
      addLine(row ? `URL for ${row.displayName}` : 'URL')
      addLine(url.length === 0 ? '_' : url)
    }
    if (inlineError) {
      addLine(' ')
      addLine(inlineError, 'error')
    }
    addLine(' ')
    addLine(
      field === 'list'
        ? '↑↓ Select   Enter Apply   e Edit token/URL   ESC Close'
        : 'Type a value   Enter Continue   ESC Back',
      'hint',
    )
    ctx.renderer.requestRender?.()
  }

  const close = () => {
    modal.hide()
    ctx.input.focus()
  }

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  render()
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.eventType === 'release') return true
    if (field === 'list') {
      if (key.name === 'escape') {
        close()
        return true
      }
      if (rows.length === 0) return originalHandleKeyPress ? originalHandleKeyPress(key) : false
      if (key.name === 'up') {
        selected = wrapProviderIndex(selected, -1, rows.length)
        render()
        return true
      }
      if (key.name === 'down') {
        selected = wrapProviderIndex(selected, 1, rows.length)
        render()
        return true
      }
      if (key.name === 'e') {
        const row = rows[selected]
        token = ''
        url = row?.baseUrl || row?.defaultBaseUrl || ''
        field = 'token'
        inlineError = null
        render()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        const row = rows[selected]
        const action = providerEnterAction(row)
        if (action === 'enable') {
          token = ''
          url = row?.baseUrl || row?.defaultBaseUrl || ''
          field = 'token'
          inlineError = null
          render()
          return true
        }
        if (action !== 'switch' || !row) return true
        const binary = findCastBinary()
        if (!binary) {
          inlineError = 'cast CLI not found in PATH.'
          render()
          return true
        }
        const result = runCast(binary, providerSwitchArgv(row.key))
        if (result.status !== 0) {
          inlineError = failureText(result)
          render()
          return true
        }
        ctx.messages.addAgentMessage(providerSuccessMessage(row.displayName, ''), ctx.mode)
        close()
        return true
      }
      return originalHandleKeyPress ? originalHandleKeyPress(key) : false
    }

    if (key.name === 'escape') {
      field = 'list'
      token = ''
      inlineError = null
      render()
      return true
    }
    if (key.name === 'backspace') {
      if (field === 'token') token = token.slice(0, -1)
      else url = url.slice(0, -1)
      render()
      return true
    }
    if (key.name === 'return' || key.name === 'enter') {
      const row = rows[selected]
      if (!row) return true
      if (field === 'token') {
        if (!token.trim()) {
          inlineError = 'Enter a model access key.'
          render()
          return true
        }
        field = 'url'
        inlineError = null
        render()
        return true
      }
      const parsed = parseInferenceUrl(url)
      if (!parsed) {
        inlineError = 'Enter an http(s) URL with a host and no userinfo or query.'
        render()
        return true
      }
      const binary = findCastBinary()
      if (!binary) {
        inlineError = 'cast CLI not found in PATH.'
        render()
        return true
      }
      const result = runCast(
        binary,
        providerEnableArgv(row.key, parsed, row.defaultBaseUrl),
        `${token}\n`,
      )
      token = ''
      if (result.status !== 0) {
        inlineError = failureText(result)
        field = 'token'
        render()
        return true
      }
      field = 'list'
      reload(binary)
      render()
      return true
    }
    if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
      if (field === 'token') token += key.sequence
      else url += key.sequence
      render()
      return true
    }
    return true
  }
}
