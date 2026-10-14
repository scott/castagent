import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import yaml from 'yaml'
import {BoxRenderable, TextRenderable, StyledText, white, dim, cyan, red, decodePasteBytes} from '@opentui/core'
import type {KeyEvent, PasteEvent} from '@opentui/core'
import clipboardy from 'clipboardy'
import {createModal} from '../components/modal.js'
import {
  applyEntryKey,
  clipFieldError,
  createTextEntry,
  insertText,
  modalContentColumns,
  previewField,
  recordFailedSubmit,
  type TextEntry,
} from '../lib/text-entry.js'
import {CAPTURED_CHILD_STDIO, childProcessFailureReason} from '../lib/subject-agent.js'
import {
  CAST_CLI_NOT_FOUND,
  UPDATE_FIELDS,
  agentYamlParseMessage,
  blankUpdateValueMessage,
  missingAgentYamlMessage,
  buildUpdateChoiceLines,
  buildUpdateFieldLines,
  buildUpdateTextLines,
  choiceNote,
  choicesForField,
  currentForField,
  emptyChoiceMessage,
  flagsForField,
  missingAgentMessage,
  normalizeFieldValue,
  permissionLevels,
  permissionValue,
  snapshotFromConfig,
  textFieldMaxLength,
  unchangedUpdateMessage,
  updateAppliedMessage,
  updateArgv,
  updateField,
  updateFocusReturnTarget,
  updateModalTitle,
  wrapUpdateIndex,
  type AgentUpdateSnapshot,
  type UpdateLine,
} from '../lib/agent-update.js'

export interface AgentUpdateHost {
  mode: 'plan' | 'build'
  renderer: any
  input: any
  messages: {addAgentMessage: (text: string, mode: 'plan' | 'build') => void}
}

type Step =
  | {kind: 'fields'}
  | {kind: 'choices'; fieldId: string; choices: string[]; phase: 'apply' | 'permission-tool'}
  | {kind: 'levels'; tool: string}
  | {kind: 'text'; fieldId: string}

interface CastUpdateResult {
  ok: boolean
  stdout: string
  reason: string
}

function readClipboard(): string {
  return clipboardy.readSync()
}

function loadSnapshot(agentName: string): {ok: true; snapshot: AgentUpdateSnapshot} | {ok: false; message: string} {
  const agentPath = path.join(os.homedir(), '.cast', 'agents', agentName)
  const yamlPath = path.join(agentPath, 'agent.yaml')
  if (!fs.existsSync(agentPath)) {
    return {ok: false, message: missingAgentMessage(agentName, agentPath)}
  }
  if (!fs.existsSync(yamlPath)) {
    return {ok: false, message: missingAgentYamlMessage(yamlPath)}
  }
  try {
    const parsed = yaml.parse(fs.readFileSync(yamlPath, 'utf8'))
    return {ok: true, snapshot: snapshotFromConfig(parsed)}
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err)
    return {ok: false, message: agentYamlParseMessage(detail)}
  }
}

function runCastUpdate(binary: string, agentName: string, flags: readonly string[]): CastUpdateResult {
  try {
    const stdout = execFileSync(binary, updateArgv(agentName, flags), {
      encoding: 'utf8',
      cwd: os.homedir(),
      stdio: CAPTURED_CHILD_STDIO,
    })
    return {ok: true, stdout: stdout ?? '', reason: ''}
  } catch (err: unknown) {
    return {ok: false, stdout: '', reason: childProcessFailureReason(err)}
  }
}

export function runAgentUpdateFromArgs(
  ctx: AgentUpdateHost,
  agentName: string,
  flags: readonly string[],
  findCastBinary: () => string | null,
): void {
  const binary = findCastBinary()
  if (!binary) {
    ctx.messages.addAgentMessage(CAST_CLI_NOT_FOUND, ctx.mode)
    return
  }
  const result = runCastUpdate(binary, agentName, flags)
  if (!result.ok) {
    ctx.messages.addAgentMessage(`Update failed: ${result.reason}`, ctx.mode)
    return
  }
  ctx.messages.addAgentMessage(updateAppliedMessage(agentName, result.stdout), ctx.mode)
}

/**
 * Open the update modal for the current agent. Defaults are 90% by 80%
 * and centered. previouslyFocused is the chat input.
 */
export function openAgentUpdateModal(
  ctx: AgentUpdateHost,
  agentName: string,
  findCastBinary: () => string | null,
): void {
  const loaded = loadSnapshot(agentName)
  if (!loaded.ok) {
    ctx.messages.addAgentMessage(loaded.message, ctx.mode)
    return
  }

  const modal = createModal(ctx.renderer, ctx.input, {
    title: updateModalTitle(agentName),
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

  const snapshot = loaded.snapshot
  const stack: Step[] = [{kind: 'fields'}]
  let selected = 0
  let error = ''
  let draft: TextEntry = createTextEntry()

  const current = (): Step => stack[stack.length - 1]

  function termHeight(): number {
    return typeof ctx.renderer?.height === 'number' ? ctx.renderer.height : 24
  }

  function contentColumns(): number {
    const width = typeof ctx.renderer?.width === 'number' ? ctx.renderer.width : 0
    return modalContentColumns(width)
  }

  function clear(): void {
    for (const child of [...contentBox.getChildren()]) contentBox.remove(child.id)
  }

  function addLine(line: UpdateLine): void {
    const color = line.tone === 'error' ? red : line.tone === 'hint' ? dim : line.selected ? cyan : white
    contentBox.add(new TextRenderable(ctx.renderer, {
      content: new StyledText([color(line.text)]),
      width: '100%',
      height: 1,
      wrapMode: 'none',
      flexShrink: 0,
    }))
  }

  function paint(lines: UpdateLine[]): void {
    clear()
    for (const line of lines) addLine(line)
    ctx.renderer.requestRender?.()
  }

  function closeAll(): void {
    modal.hide()
    if (updateFocusReturnTarget() === 'input') ctx.input.focus()
  }

  function announce(stdout: string): void {
    closeAll()
    ctx.messages.addAgentMessage(updateAppliedMessage(agentName, stdout), ctx.mode)
  }

  function push(step: Step): void {
    stack.push(step)
    selected = 0
    error = ''
    draft = createTextEntry()
    render()
  }

  function back(): void {
    if (stack.length <= 1) {
      closeAll()
      return
    }
    stack.pop()
    selected = 0
    error = ''
    draft = createTextEntry()
    render()
  }

  function failDraft(message: string): void {
    const failed = recordFailedSubmit(draft, message)
    draft = failed.entry
    error = failed.error
    render()
  }

  function applyFlags(fieldId: string, value: string): void {
    const same = unchangedUpdateMessage(fieldId, value, snapshot)
    if (same) {
      error = same
      render()
      return
    }
    const binary = findCastBinary()
    if (!binary) {
      error = CAST_CLI_NOT_FOUND
      render()
      return
    }
    const result = runCastUpdate(binary, agentName, flagsForField(fieldId, value))
    if (!result.ok) {
      error = result.reason || 'Update failed.'
      render()
      return
    }
    announce(result.stdout)
  }

  function render(): void {
    const step = current()
    const field = step.kind === 'fields' ? undefined : updateField(step.kind === 'levels' ? 'permission' : step.fieldId)
    modal.setTitle(updateModalTitle(agentName, field?.label))
    const columns = contentColumns()
    const clipped = error ? clipFieldError(error, columns, 4) : null
    if (step.kind === 'fields') {
      paint(buildUpdateFieldLines({
        fields: UPDATE_FIELDS,
        currents: UPDATE_FIELDS.map((item) => currentForField(item.id, snapshot)),
        selected,
        termHeight: termHeight(),
        columns,
        error: clipped,
      }))
      return
    }
    if (step.kind === 'text') {
      const active = updateField(step.fieldId)
      paint(buildUpdateTextLines({
        hint: active?.hint ?? '',
        preview: previewField(draft, {multiline: false, columns, showCursor: true}),
        columns,
        error: clipped,
      }))
      return
    }
    if (step.kind === 'levels') {
      const levels = permissionLevels()
      paint(buildUpdateChoiceLines({
        choices: levels,
        notes: levels.map((level) => choiceNote('permission', level, snapshot, step.tool)),
        selected,
        termHeight: termHeight(),
        columns,
        error: clipped,
        footer: '↑↓ Select   Enter Apply   ESC Back',
      }))
      return
    }
    const notes = step.choices.map((choice) => choiceNote(step.fieldId, choice, snapshot))
    const footer = step.phase === 'permission-tool'
      ? '↑↓ Select   Enter Next   ESC Back'
      : '↑↓ Select   Enter Apply   ESC Back'
    paint(buildUpdateChoiceLines({
      choices: step.choices,
      notes,
      selected,
      termHeight: termHeight(),
      columns,
      error: clipped,
      footer,
    }))
  }

  function openField(index: number): void {
    const field = UPDATE_FIELDS[index]
    if (!field) return
    if (field.kind === 'text') {
      push({kind: 'text', fieldId: field.id})
      return
    }
    if (field.kind === 'permission') {
      push({kind: 'choices', fieldId: field.id, choices: choicesForField(field.id, snapshot), phase: 'permission-tool'})
      return
    }
    const choices = choicesForField(field.id, snapshot)
    if (choices.length === 0) {
      error = emptyChoiceMessage(field.id)
      render()
      return
    }
    push({kind: 'choices', fieldId: field.id, choices, phase: 'apply'})
  }

  function onFieldsKey(key: KeyEvent): void {
    if (key.name === 'up') {
      selected = wrapUpdateIndex(selected, -1, UPDATE_FIELDS.length)
      error = ''
      render()
      return
    }
    if (key.name === 'down') {
      selected = wrapUpdateIndex(selected, 1, UPDATE_FIELDS.length)
      error = ''
      render()
      return
    }
    if (key.name === 'return' || key.name === 'enter') openField(selected)
  }

  function onChoicesKey(key: KeyEvent, step: Extract<Step, {kind: 'choices'}>): void {
    if (key.name === 'up') {
      selected = wrapUpdateIndex(selected, -1, step.choices.length)
      error = ''
      render()
      return
    }
    if (key.name === 'down') {
      selected = wrapUpdateIndex(selected, 1, step.choices.length)
      error = ''
      render()
      return
    }
    if (key.name !== 'return' && key.name !== 'enter') return
    const choice = step.choices[selected]
    if (!choice) return
    if (step.phase === 'permission-tool') {
      push({kind: 'levels', tool: choice})
      return
    }
    applyFlags(step.fieldId, choice)
  }

  function onLevelsKey(key: KeyEvent, step: Extract<Step, {kind: 'levels'}>): void {
    const levels = permissionLevels()
    if (key.name === 'up') {
      selected = wrapUpdateIndex(selected, -1, levels.length)
      error = ''
      render()
      return
    }
    if (key.name === 'down') {
      selected = wrapUpdateIndex(selected, 1, levels.length)
      error = ''
      render()
      return
    }
    if (key.name !== 'return' && key.name !== 'enter') return
    const level = levels[selected]
    if (!level) return
    applyFlags('permission', permissionValue(step.tool, level))
  }

  function onTextKey(key: KeyEvent, step: Extract<Step, {kind: 'text'}>): void {
    if (key.name === 'return' || key.name === 'enter') {
      const value = normalizeFieldValue(step.fieldId, draft.text, os.homedir())
      if (!value) {
        failDraft(blankUpdateValueMessage())
        return
      }
      applyFlags(step.fieldId, value)
      return
    }
    const next = applyEntryKey(
      draft,
      key,
      {kind: 'single', maxLength: textFieldMaxLength(step.fieldId)},
      readClipboard,
    )
    if (!next.handled) return
    if (next.entry.text !== draft.text) error = ''
    draft = next.entry
    render()
  }

  function pasteIntoText(raw: string): void {
    const step = current()
    if (step.kind !== 'text') return
    const next = insertText(draft, raw, 'single', textFieldMaxLength(step.fieldId))
    if (next.text !== draft.text) error = ''
    draft = next
    render()
  }

  render()
  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()

  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.eventType === 'release') return true
    if (key.name === 'escape') {
      back()
      return true
    }
    const step = current()
    if (step.kind === 'fields') onFieldsKey(key)
    else if (step.kind === 'choices') onChoicesKey(key, step)
    else if (step.kind === 'levels') onLevelsKey(key, step)
    else onTextKey(key, step)
    return true
  }

  modal.box.handlePaste = (event: PasteEvent): void => {
    if (current().kind !== 'text') return
    event.preventDefault()
    pasteIntoText(decodePasteBytes(event.bytes))
  }
}
