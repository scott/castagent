import {execFileSync} from 'child_process'
import * as os from 'os'
import {BoxRenderable, TextRenderable, StyledText, white, dim, red} from '@opentui/core'
import type {KeyEvent} from '@opentui/core'
import {createModal} from '../components/modal.js'
import {
  BUILDER_MODEL_MODAL_TITLE,
  CAST_CLI_NOT_FOUND,
  builderModelApplyArgv,
  builderModelCurrentArgv,
  builderModelFocusReturnTarget,
  builderModelListArgv,
  builderModelSuccessMessage,
  formatBuilderModelRow,
  initialBuilderModelIndex,
  shouldApplyBuilderModel,
  sortBuilderModels,
  wrapBuilderModelIndex,
  type BuilderModelInfo,
} from '../lib/builder-model.js'

/**
 * Host surface the slash command passes in. Kept narrow so this file does
 * not import the slash registry (that file imports OpenTUI already).
 */
export interface BuilderModelHost {
  agentName: string
  mode: 'plan' | 'build'
  renderer: any
  input: any
  messages: {addAgentMessage: (text: string, mode: 'plan' | 'build') => void}
}

interface CastResult {
  status: number
  stdout: string
  stderr: string
}

function runCast(binary: string, args: string[]): CastResult {
  try {
    const stdout = execFileSync(binary, args, {
      encoding: 'utf8',
      cwd: os.homedir(),
      timeout: 15000,
    })
    return {status: 0, stdout: stdout ?? '', stderr: ''}
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : err?.stdout?.toString?.() ?? ''
    const stderr = typeof err?.stderr === 'string' ? err.stderr : err?.stderr?.toString?.() ?? ''
    return {
      status: typeof err?.status === 'number' ? err.status : 1,
      stdout,
      stderr: stderr || err?.message || String(err),
    }
  }
}

function failureText(result: CastResult): string {
  return (result.stderr || result.stdout || 'Failed to set the builder model.').trim()
}

function parseModelList(stdout: string): BuilderModelInfo[] {
  const parsed = JSON.parse(stdout)
  if (!Array.isArray(parsed)) {
    throw new Error('cast model --list --json did not return an array')
  }
  const models: BuilderModelInfo[] = []
  for (const item of parsed) {
    if (!item || typeof item.id !== 'string') continue
    models.push({
      id: item.id,
      provider: typeof item.provider === 'string' ? item.provider : '',
      family: typeof item.family === 'string' ? item.family : '',
    })
  }
  return sortBuilderModels(models)
}

function parseCurrentId(stdout: string): string {
  const parsed = JSON.parse(stdout)
  if (!parsed || typeof parsed.id !== 'string') {
    throw new Error('cast model --current --json did not return an id')
  }
  return parsed.id
}

/**
 * Open the Builder Model modal. `findCastBinary` is the helper in
 * slash-registry.ts. The running builder does not hot-swap.
 */
export function openBuilderModelModal(
  ctx: BuilderModelHost,
  findCastBinary: () => string | null,
): void {
  // Defaults are 90% x 80% and centered. previouslyFocused is the input.
  const modal = createModal(ctx.renderer, ctx.input, {
    title: BUILDER_MODEL_MODAL_TITLE,
    overlay: true,
  })
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  let models: BuilderModelInfo[] = []
  let currentId = ''
  let selected = 0
  let inlineError: string | null = null

  const binary = findCastBinary()
  if (!binary) {
    inlineError = CAST_CLI_NOT_FOUND
  } else {
    const listed = runCast(binary, builderModelListArgv())
    const current = runCast(binary, builderModelCurrentArgv())
    if (listed.status !== 0) {
      inlineError = failureText(listed)
    } else if (current.status !== 0) {
      inlineError = failureText(current)
    } else {
      try {
        models = parseModelList(listed.stdout)
        currentId = parseCurrentId(current.stdout)
        selected = initialBuilderModelIndex(models, currentId)
      } catch (err: any) {
        inlineError = err?.message ?? String(err)
        models = []
      }
    }
  }

  const clear = () => {
    for (const child of [...contentBox.getChildren()]) contentBox.remove(child.id)
  }

  const addLine = (text: string, tone: 'text' | 'hint' | 'error' = 'text') => {
    const color = tone === 'error' ? red : tone === 'hint' ? dim : white
    contentBox.add(new TextRenderable(ctx.renderer, {content: new StyledText([color(text)])}))
  }

  const render = () => {
    clear()
    if (inlineError && models.length === 0) {
      addLine(inlineError, 'error')
      addLine(' ')
      addLine('ESC Close', 'hint')
      ctx.renderer.requestRender?.()
      return
    }

    addLine(`Current: ${currentId || '(unset)'}`)
    addLine('────────────────────────────────────────────────────────', 'hint')
    models.forEach((model, index) => {
      addLine(formatBuilderModelRow(model.id, index === selected, model.id === currentId))
    })
    if (inlineError) {
      addLine(' ')
      addLine(inlineError, 'error')
    }
    addLine(' ')
    addLine('↑↓ Select   Enter Apply   ESC Close', 'hint')
    ctx.renderer.requestRender?.()
  }

  const close = () => {
    modal.hide()
    if (builderModelFocusReturnTarget() === 'input') ctx.input.focus()
  }

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  render()
  modal.show()

  const originalHandleKeyPress = modal.box.handleKeyPress?.bind(modal.box)
  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.name === 'escape') {
      close()
      return true
    }
    if (models.length === 0) {
      return originalHandleKeyPress ? originalHandleKeyPress(key) : false
    }
    if (key.name === 'up') {
      selected = wrapBuilderModelIndex(selected, -1, models.length)
      render()
      return true
    }
    if (key.name === 'down') {
      selected = wrapBuilderModelIndex(selected, 1, models.length)
      render()
      return true
    }
    if (key.name === 'return' || key.name === 'enter') {
      const chosen = models[selected]
      if (!chosen || !shouldApplyBuilderModel(currentId, chosen.id)) {
        return true
      }
      const castBinary = findCastBinary()
      if (!castBinary) {
        inlineError = CAST_CLI_NOT_FOUND
        render()
        return true
      }
      const result = runCast(castBinary, builderModelApplyArgv(chosen.id))
      if (result.status !== 0) {
        ctx.messages.addAgentMessage(failureText(result), ctx.mode)
        inlineError = failureText(result)
        render()
        return true
      }
      ctx.messages.addAgentMessage(builderModelSuccessMessage(chosen.id, ctx.agentName), ctx.mode)
      close()
      return true
    }
    return originalHandleKeyPress ? originalHandleKeyPress(key) : false
  }
}
