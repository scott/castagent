import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execFileSync} from 'child_process'
import {BoxRenderable, TextRenderable, StyledText, white, dim, cyan, red, decodePasteBytes} from '@opentui/core'
import type {KeyEvent, PasteEvent} from '@opentui/core'
import clipboardy from 'clipboardy'
import {createModal} from '../components/modal.js'
import {
  ADD_SOURCE_LABELS,
  formatNumberedRow,
  formatSkillRow,
  numberKeyIndex,
  sortSkillsByName,
  type SkillListItem,
  wrapIndex,
} from '../lib/skill-list.js'
import {
  applyEntryKey,
  clipFieldError,
  createTextEntry,
  insertText,
  modalContentColumns,
  previewField,
  recordFailedSubmit,
  type TextEntry,
  type TextFieldKind,
} from '../lib/text-entry.js'

const RESTART_LINE = 'Restart the agent so the running prompt picks it up.'

export interface SkillsModalContext {
  agentName: string
  mode: 'plan' | 'build'
  renderer: any
  messages: {addAgentMessage: (text: string, mode: 'plan' | 'build') => void}
  input: any
}

export interface SkillChoiceRow extends SkillListItem {
  subpath?: string
  ref?: string
}

export type SkillsStep =
  | {kind: 'list'}
  | {kind: 'source'}
  | {kind: 'github'}
  | {kind: 'folder'}
  | {kind: 'entry'}
  | {kind: 'confirm'}
  | {kind: 'picker'; github: string; choices: SkillChoiceRow[]}

type EntryField = 'name' | 'description' | 'body' | 'save'

interface CastResult {
  ok: boolean
  status: number
  stdout: string
  stderr: string
}

function findCastBinary(): string | null {
  const candidates = [
    'cast',
    path.resolve(__dirname, '../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../cast-cli/bin/run'),
    path.resolve(__dirname, '../../../../cast-cli/bin/run'),
  ]
  for (const candidate of candidates) {
    try {
      if (candidate === 'cast') {
        const castPath = execFileSync('which', ['cast'], {encoding: 'utf8', timeout: 5000}).trim()
        if (castPath && fs.existsSync(castPath)) return castPath
      } else if (fs.existsSync(candidate)) {
        return candidate
      }
    } catch {
      // try next
    }
  }
  return null
}

function runCastSkills(args: string[], input?: string): CastResult {
  const binary = findCastBinary() ?? 'cast'
  const options: {encoding: 'utf8'; cwd: string; input?: string} = {
    encoding: 'utf8',
    cwd: os.homedir(),
  }
  if (input !== undefined) options.input = input
  try {
    const stdout = execFileSync(binary, ['skills', ...args], options)
    return {ok: true, status: 0, stdout: stdout ?? '', stderr: ''}
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : err?.stdout?.toString?.() ?? ''
    const stderr = typeof err?.stderr === 'string' ? err.stderr : err?.stderr?.toString?.() ?? ''
    const status = typeof err?.status === 'number' ? err.status : 1
    return {ok: false, status, stdout, stderr}
  }
}

function castErrorText(stderr: string, stdout: string): string {
  const raw = `${stderr}\n${stdout}`.trim()
  if (!raw) return 'unknown error'
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean)
  const useful = lines.filter((line) => !line.startsWith('at ') && !line.includes('node_modules'))
  const line = useful[useful.length - 1] || lines[lines.length - 1]
  return line.replace(/^[›»]\s*/, '').replace(/^(Error|CLIError):\s*/, '').trim()
}

function successLine(stdout: string): string {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines.find((line) => line.startsWith('Added skill ') || line.startsWith('Removed skill '))
    ?? lines[lines.length - 1]
    ?? 'Done.'
}

function parseJsonArray(stdout: string): any[] | null {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end < start) return null
  try {
    const parsed = JSON.parse(stdout.slice(start, end + 1))
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function parseInstalled(stdout: string): SkillListItem[] | null {
  const parsed = parseJsonArray(stdout)
  if (!parsed) return null
  return parsed
    .map((item) => ({
      name: String(item?.name ?? ''),
      description: String(item?.description ?? ''),
    }))
    .filter((item) => item.name)
}

function parseChoices(stdout: string): SkillChoiceRow[] | null {
  const parsed = parseJsonArray(stdout)
  if (!parsed) return null
  return parsed
    .map((item) => ({
      name: String(item?.name ?? ''),
      description: String(item?.description ?? ''),
      subpath: item?.subpath ? String(item.subpath) : undefined,
      ref: item?.ref ? String(item.ref) : undefined,
    }))
    .filter((item) => item.name)
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2))
  return input
}

function isDirectory(input: string): boolean {
  try {
    return fs.existsSync(input) && fs.statSync(input).isDirectory()
  } catch {
    return false
  }
}

function letterKey(key: KeyEvent): string {
  if (key.ctrl || key.meta || key.option) return ''
  const name = key.name || ''
  return name.length === 1 && /[a-z]/i.test(name) ? name.toLowerCase() : ''
}

function nextField(field: EntryField): EntryField {
  if (field === 'name') return 'description'
  if (field === 'description') return 'body'
  if (field === 'body') return 'save'
  return 'name'
}

const BODY_LINES = 8
const BODY_LINES_WITH_ERROR = 4
const PROMPT_MAX = 500
const NAME_MAX = 64
const DESCRIPTION_MAX = 200
const BODY_MAX = 200000

function readClipboard(): string {
  return clipboardy.readSync()
}

export function addSkillFromSource(ctx: SkillsModalContext, source: string): void {
  const expanded = expandHome(source)
  const result = isDirectory(expanded)
    ? runCastSkills(['add', ctx.agentName, '--folder', path.resolve(expanded)])
    : runCastSkills(['add', ctx.agentName, '--github', source, '--json'])
  if (result.status === 2) {
    const choices = parseChoices(result.stdout)
    if (choices && choices.length > 0) {
      openSkillsModal(ctx, {kind: 'picker', github: source, choices: sortSkillsByName(choices)})
      return
    }
  }
  if (!result.ok) {
    ctx.messages.addAgentMessage(castErrorText(result.stderr, result.stdout), ctx.mode)
    return
  }
  ctx.messages.addAgentMessage(`${successLine(result.stdout)}\n${RESTART_LINE}`, ctx.mode)
}

export function openSkillsModal(ctx: SkillsModalContext, initial: SkillsStep): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: `Skills: ${ctx.agentName}`,
    overlay: true,
  })
  if (modal.overlay) ctx.renderer.root.add(modal.overlay)

  modal.box.overflow = 'hidden'
  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
    overflow: 'hidden',
  })

  const stack: SkillsStep[] = [initial]
  let selected = 0
  let error = ''
  let draft = createTextEntry()
  let installed: SkillListItem[] = []
  let entry: {name: TextEntry; description: TextEntry; body: TextEntry; field: EntryField} = {
    name: createTextEntry(),
    description: createTextEntry(),
    body: createTextEntry(),
    field: 'name',
  }

  const current = (): SkillsStep => stack[stack.length - 1]

  function contentColumns(): number {
    const width = typeof ctx.renderer?.width === 'number' ? ctx.renderer.width : 0
    return modalContentColumns(width)
  }

  function addLine(chunks: Array<ReturnType<typeof white>>): void {
    contentBox.add(new TextRenderable(ctx.renderer, {content: new StyledText(chunks)}))
  }

  function addBlock(text: string, color: typeof white): void {
    contentBox.add(new TextRenderable(ctx.renderer, {
      content: new StyledText([color(text)]),
      width: '100%',
      wrapMode: 'none',
      flexShrink: 0,
    }))
  }

  function addError(message: string): void {
    addBlock(clipFieldError(message, contentColumns()), red)
  }

  function refreshInstalled(): void {
    const result = runCastSkills([ctx.agentName, '--json'])
    if (!result.ok) {
      error = castErrorText(result.stderr, result.stdout)
      installed = []
      return
    }
    const parsed = parseInstalled(result.stdout)
    if (!parsed) {
      error = 'Could not read skills.'
      installed = []
      return
    }
    installed = sortSkillsByName(parsed)
    if (installed.length > 0 && selected >= installed.length) selected = 0
  }

  function closeAll(): void {
    modal.hide()
    ctx.input.focus()
  }

  function announce(line: string): void {
    closeAll()
    ctx.messages.addAgentMessage(`${line}\n${RESTART_LINE}`, ctx.mode)
  }

  function push(step: SkillsStep): void {
    stack.push(step)
    selected = 0
    error = ''
    draft = createTextEntry()
    if (step.kind === 'entry') {
      entry = {name: createTextEntry(), description: createTextEntry(), body: createTextEntry(), field: 'name'}
    }
    if (step.kind === 'list') refreshInstalled()
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
    if (current().kind === 'list') refreshInstalled()
    render()
  }

  function runAdd(extra: string[], githubSource?: string): void {
    // --json keeps the multi-skill choice list machine-readable for the picker.
    const args = ['add', ctx.agentName, ...extra]
    if (githubSource) args.push('--json')
    const result = runCastSkills(args)
    if (result.status === 2 && githubSource) {
      const choices = parseChoices(result.stdout)
      if (!choices || choices.length === 0) {
        const failed = recordFailedSubmit(draft, castErrorText(result.stderr, result.stdout) || 'Could not read skill choices.')
        draft = failed.entry
        error = failed.error
        render()
        return
      }
      push({kind: 'picker', github: githubSource, choices: sortSkillsByName(choices)})
      return
    }
    if (!result.ok) {
      const failed = recordFailedSubmit(draft, castErrorText(result.stderr, result.stdout))
      draft = failed.entry
      error = failed.error
      render()
      return
    }
    announce(successLine(result.stdout))
  }

  function submitEntry(): void {
    const result = runCastSkills(
      ['add', ctx.agentName, '--name', entry.name.text, '--description', entry.description.text, '--body', '-'],
      entry.body.text,
    )
    if (!result.ok) {
      const active = entry.field === 'description' ? entry.description : entry.field === 'body' ? entry.body : entry.name
      const failed = recordFailedSubmit(active, castErrorText(result.stderr, result.stdout))
      if (entry.field === 'description') entry.description = failed.entry
      else if (entry.field === 'body') entry.body = failed.entry
      else if (entry.field === 'name') entry.name = failed.entry
      error = failed.error
      render()
      return
    }
    announce(successLine(result.stdout))
  }

  function render(): void {
    for (const child of [...contentBox.getChildren()]) {
      contentBox.remove(child.id)
    }
    const step = current()
    if (step.kind === 'list') renderList()
    else if (step.kind === 'source') renderSource()
    else if (step.kind === 'github') renderPrompt('GitHub repository', 'owner/repo or https://github.com/owner/repo')
    else if (step.kind === 'folder') renderPrompt('Folder on this machine', 'Absolute path or ~/path')
    else if (step.kind === 'entry') renderEntry()
    else if (step.kind === 'confirm') renderConfirm()
    else renderPicker(step)
    ctx.renderer.requestRender?.()
  }

  function renderList(): void {
    modal.setTitle(`Skills: ${ctx.agentName}`)
    if (error) addError(error)
    if (installed.length === 0) {
      addLine([white(`No skills on '${ctx.agentName}'.`)])
      addLine([dim(' ')])
      addLine([white('A  Add a skill')])
      addLine([white('ESC  Close')])
      return
    }
    installed.forEach((skill, index) => {
      const line = formatSkillRow(skill, index === selected)
      addLine([index === selected ? cyan(line) : white(line)])
    })
    addLine([dim(' ')])
    addLine([dim('A Add   D Remove   ↑↓ Select   ESC Close')])
  }

  function renderSource(): void {
    modal.setTitle(`Add a skill to '${ctx.agentName}'`)
    ADD_SOURCE_LABELS.forEach((label, index) => {
      const line = formatNumberedRow(index, label, index === selected)
      addLine([index === selected ? cyan(line) : white(line)])
    })
    addLine([dim(' ')])
    addLine([dim('↑↓ or 1-3   Enter   ESC Back')])
  }

  function renderPrompt(title: string, hint: string): void {
    modal.setTitle(title)
    addLine([dim(hint)])
    addBlock(previewField(draft, {multiline: false, columns: contentColumns(), showCursor: true}), cyan)
    if (error) addError(error)
    addLine([dim(' ')])
    addLine([dim('Enter Confirm   ESC Back')])
  }

  function renderEntry(): void {
    modal.setTitle(`New skill on '${ctx.agentName}'`)
    const columns = contentColumns()
    const bodyLines = error && (entry.field === 'body' || entry.field === 'save') ? BODY_LINES_WITH_ERROR : BODY_LINES
    addLine([dim('Name')])
    addBlock(shownField(entry.name, columns, false, entry.field === 'name'), entry.field === 'name' ? cyan : white)
    if (error && entry.field === 'name') addError(error)
    addLine([dim('Description')])
    addBlock(shownField(entry.description, columns, false, entry.field === 'description'), entry.field === 'description' ? cyan : white)
    if (error && entry.field === 'description') addError(error)
    addLine([dim('Body')])
    addBlock(shownField(entry.body, columns, true, entry.field === 'body', bodyLines), entry.field === 'body' ? cyan : white)
    if (error && entry.field === 'body') addError(error)
    addLine([dim(' ')])
    const save = entry.field === 'save' ? '▸ Save' : '  Save'
    addLine([entry.field === 'save' ? cyan(save) : white(save)])
    if (error && entry.field === 'save') addError(error)
    addLine([dim(' ')])
    addLine([dim('Ctrl+S Save   Tab Next   ESC Cancel')])
  }

  function shownField(value: TextEntry, columns: number, multiline: boolean, active: boolean, maxLines?: number): string {
    const shown = previewField(value, {multiline, columns, maxLines, showCursor: active})
    return shown || (active ? '_' : ' ')
  }

  function renderConfirm(): void {
    const skill = installed[selected]
    const name = skill?.name ?? ''
    modal.setTitle('Remove skill')
    addLine([white(`Remove skill '${name}' from '${ctx.agentName}'?`)])
    addLine([dim(' ')])
    addLine([white(`This deletes ~/.cast/agents/${ctx.agentName}/skills/${name}`)])
    addLine([white('and its entry in agent.yaml.')])
    if (error) addError(error)
    addLine([dim(' ')])
    addLine([dim('Y  Remove    N  Cancel')])
  }

  function renderPicker(step: Extract<SkillsStep, {kind: 'picker'}>): void {
    modal.setTitle(`Choose a skill for '${ctx.agentName}'`)
    step.choices.forEach((skill, index) => {
      const line = formatSkillRow(skill, index === selected)
      addLine([index === selected ? cyan(line) : white(line)])
    })
    if (error) addError(error)
    addLine([dim(' ')])
    addLine([dim('↑↓ Select   Enter Install   ESC Back')])
  }

  function onListKey(key: KeyEvent): void {
    if (installed.length > 0 && key.name === 'up') {
      selected = wrapIndex(selected, -1, installed.length)
      render()
      return
    }
    if (installed.length > 0 && key.name === 'down') {
      selected = wrapIndex(selected, 1, installed.length)
      render()
      return
    }
    if (key.name === 'return' || key.name === 'enter') return
    const letter = letterKey(key)
    if (letter === 'a') {
      push({kind: 'source'})
      return
    }
    if (letter === 'd' && installed.length > 0) {
      push({kind: 'confirm'})
      return
    }
  }

  function onSourceKey(key: KeyEvent): void {
    const count = ADD_SOURCE_LABELS.length
    if (key.name === 'up') {
      selected = wrapIndex(selected, -1, count)
      render()
      return
    }
    if (key.name === 'down') {
      selected = wrapIndex(selected, 1, count)
      render()
      return
    }
    const numbered = numberKeyIndex(key.name, count)
    if (numbered !== null) {
      selected = numbered
      openSource(numbered)
      return
    }
    if (key.name === 'return' || key.name === 'enter') openSource(selected)
  }

  function openSource(index: number): void {
    if (index === 0) push({kind: 'github'})
    else if (index === 1) push({kind: 'folder'})
    else push({kind: 'entry'})
  }

  function onPromptKey(key: KeyEvent, kind: 'github' | 'folder'): void {
    if (key.name === 'return' || key.name === 'enter') {
      const value = draft.text.trim()
      if (!value) {
        const failed = recordFailedSubmit(
          draft,
          kind === 'github'
            ? 'Give a GitHub repo (owner/name or https://github.com/owner/name).'
            : 'Give an absolute path or a path starting with ~.',
        )
        draft = failed.entry
        error = failed.error
        render()
        return
      }
      if (kind === 'github') runAdd(['--github', value], value)
      else runAdd(['--folder', value])
      return
    }
    const next = applyEntryKey(draft, key, {kind: 'single', maxLength: PROMPT_MAX}, readClipboard)
    if (!next.handled) return
    if (next.entry.text !== draft.text) error = ''
    draft = next.entry
    render()
  }

  function onEntryKey(key: KeyEvent): void {
    if (key.ctrl && (key.name === 's' || key.name === 'S')) {
      submitEntry()
      return
    }
    if (key.name === 'tab') {
      entry.field = nextField(entry.field)
      render()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (entry.field === 'name') entry.field = 'description'
      else if (entry.field === 'description') entry.field = 'body'
      else if (entry.field === 'body') {
        const next = insertText(entry.body, '\n', 'body', BODY_MAX)
        if (next.text !== entry.body.text) error = ''
        entry.body = next
      } else {
        submitEntry()
        return
      }
      render()
      return
    }
    if (entry.field === 'save') return
    const current = entry.field === 'name' ? entry.name : entry.field === 'description' ? entry.description : entry.body
    const kind: TextFieldKind = entry.field === 'body' ? 'body' : 'single'
    const maxLength = entry.field === 'name' ? NAME_MAX : entry.field === 'description' ? DESCRIPTION_MAX : BODY_MAX
    const next = applyEntryKey(current, key, {kind, maxLength}, readClipboard)
    if (!next.handled) return
    if (next.entry.text !== current.text) error = ''
    if (entry.field === 'name') entry.name = next.entry
    else if (entry.field === 'description') entry.description = next.entry
    else entry.body = next.entry
    render()
  }

  function pasteIntoField(raw: string): void {
    const step = current()
    if (step.kind === 'github' || step.kind === 'folder') {
      const next = insertText(draft, raw, 'single', PROMPT_MAX)
      if (next.text !== draft.text) error = ''
      draft = next
      render()
      return
    }
    if (step.kind !== 'entry' || entry.field === 'save') return
    const currentEntry = entry.field === 'name' ? entry.name : entry.field === 'description' ? entry.description : entry.body
    const kind: TextFieldKind = entry.field === 'body' ? 'body' : 'single'
    const maxLength = entry.field === 'name' ? NAME_MAX : entry.field === 'description' ? DESCRIPTION_MAX : BODY_MAX
    const next = insertText(currentEntry, raw, kind, maxLength)
    if (next.text !== currentEntry.text) error = ''
    if (entry.field === 'name') entry.name = next
    else if (entry.field === 'description') entry.description = next
    else entry.body = next
    render()
  }

  function onConfirmKey(key: KeyEvent): void {
    const letter = letterKey(key)
    if (letter === 'n') {
      back()
      return
    }
    if (letter !== 'y') return
    const skill = installed[selected]
    if (!skill) return
    const result = runCastSkills(['remove', ctx.agentName, skill.name])
    if (!result.ok) {
      error = castErrorText(result.stderr, result.stdout)
      render()
      return
    }
    announce(successLine(result.stdout))
  }

  function onPickerKey(key: KeyEvent, step: Extract<SkillsStep, {kind: 'picker'}>): void {
    if (key.name === 'up') {
      selected = wrapIndex(selected, -1, step.choices.length)
      render()
      return
    }
    if (key.name === 'down') {
      selected = wrapIndex(selected, 1, step.choices.length)
      render()
      return
    }
    if (key.name !== 'return' && key.name !== 'enter') return
    const choice = step.choices[selected]
    if (!choice) return
    const args = ['--github', step.github]
    if (choice.ref) args.push('--ref', choice.ref)
    if (choice.subpath) args.push('--subpath', choice.subpath)
    runAdd(args, step.github)
  }

  if (initial.kind === 'list') refreshInstalled()
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
    if (step.kind === 'list') onListKey(key)
    else if (step.kind === 'source') onSourceKey(key)
    else if (step.kind === 'github' || step.kind === 'folder') onPromptKey(key, step.kind)
    else if (step.kind === 'entry') onEntryKey(key)
    else if (step.kind === 'confirm') onConfirmKey(key)
    else onPickerKey(key, step)
    return true
  }

  modal.box.handlePaste = (event: PasteEvent): void => {
    const step = current()
    if (step.kind !== 'github' && step.kind !== 'folder' && step.kind !== 'entry') return
    event.preventDefault()
    pasteIntoField(decodePasteBytes(event.bytes))
  }
}
