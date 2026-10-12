import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {execFileSync} from 'child_process'
import {BoxRenderable, TextRenderable, StyledText, white, dim, cyan, red} from '@opentui/core'
import type {KeyEvent} from '@opentui/core'
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

function typedChar(key: KeyEvent): string | null {
  if (key.ctrl || key.meta || key.option) return null
  if (key.name === 'space') return ' '
  if (key.sequence && key.sequence.length === 1 && key.sequence >= ' ' && key.sequence !== '\x7f') {
    return key.sequence
  }
  if (key.name && key.name.length === 1 && key.name >= ' ' && key.name <= '~') return key.name
  return null
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

function bodyPreview(body: string, active: boolean): string {
  const shown = active ? `${body}_` : body || ' '
  const lines = shown.split('\n')
  return lines.slice(-12).join('\n')
}

export function addSkillFromSource(ctx: SkillsModalContext, source: string): void {
  const expanded = expandHome(source)
  const result = isDirectory(expanded)
    ? runCastSkills(['add', ctx.agentName, '--folder', path.resolve(expanded)])
    : runCastSkills(['add', ctx.agentName, '--github', source])
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

  const contentBox = new BoxRenderable(ctx.renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
    gap: 0,
    paddingTop: 2,
    paddingLeft: 2,
    paddingRight: 2,
  })

  const stack: SkillsStep[] = [initial]
  let selected = 0
  let error = ''
  let draft = ''
  let installed: SkillListItem[] = []
  let entry: {name: string; description: string; body: string; field: EntryField} = {
    name: '',
    description: '',
    body: '',
    field: 'name',
  }

  const current = (): SkillsStep => stack[stack.length - 1]

  function addLine(chunks: Array<ReturnType<typeof white>>): void {
    contentBox.add(new TextRenderable(ctx.renderer, {content: new StyledText(chunks)}))
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
    draft = ''
    if (step.kind === 'entry') {
      entry = {name: '', description: '', body: '', field: 'name'}
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
    draft = ''
    if (current().kind === 'list') refreshInstalled()
    render()
  }

  function runAdd(extra: string[], githubSource?: string): void {
    const result = runCastSkills(['add', ctx.agentName, ...extra])
    if (result.status === 2 && githubSource) {
      const choices = parseChoices(result.stdout)
      if (!choices || choices.length === 0) {
        error = castErrorText(result.stderr, result.stdout) || 'Could not read skill choices.'
        render()
        return
      }
      push({kind: 'picker', github: githubSource, choices: sortSkillsByName(choices)})
      return
    }
    if (!result.ok) {
      error = castErrorText(result.stderr, result.stdout)
      render()
      return
    }
    announce(successLine(result.stdout))
  }

  function submitEntry(): void {
    const result = runCastSkills(
      ['add', ctx.agentName, '--name', entry.name, '--description', entry.description, '--body', '-'],
      entry.body,
    )
    if (!result.ok) {
      error = castErrorText(result.stderr, result.stdout)
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
    if (error && step.kind !== 'list') addLine([red(error)])
    ctx.renderer.requestRender?.()
  }

  function renderList(): void {
    modal.setTitle(`Skills: ${ctx.agentName}`)
    if (error) addLine([red(error)])
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
    addLine([white(`${draft}_`)])
    addLine([dim(' ')])
    addLine([dim('Enter Confirm   ESC Back')])
  }

  function renderEntry(): void {
    modal.setTitle(`New skill on '${ctx.agentName}'`)
    addLine([dim('Name')])
    addLine([entry.field === 'name' ? cyan(`${entry.name}_`) : white(entry.name || ' ')])
    addLine([dim('Description')])
    addLine([entry.field === 'description' ? cyan(`${entry.description}_`) : white(entry.description || ' ')])
    addLine([dim('Body')])
    addLine([entry.field === 'body' ? cyan(bodyPreview(entry.body, true)) : white(bodyPreview(entry.body, false))])
    addLine([dim(' ')])
    const save = entry.field === 'save' ? '▸ Save' : '  Save'
    addLine([entry.field === 'save' ? cyan(save) : white(save)])
    addLine([dim(' ')])
    addLine([dim('Ctrl+S Save   Tab Next   ESC Cancel')])
  }

  function renderConfirm(): void {
    const skill = installed[selected]
    const name = skill?.name ?? ''
    modal.setTitle('Remove skill')
    addLine([white(`Remove skill '${name}' from '${ctx.agentName}'?`)])
    addLine([dim(' ')])
    addLine([white(`This deletes ~/.cast/agents/${ctx.agentName}/skills/${name}`)])
    addLine([white('and its entry in agent.yaml.')])
    addLine([dim(' ')])
    addLine([dim('Y  Remove    N  Cancel')])
  }

  function renderPicker(step: Extract<SkillsStep, {kind: 'picker'}>): void {
    modal.setTitle(`Choose a skill for '${ctx.agentName}'`)
    step.choices.forEach((skill, index) => {
      const line = formatSkillRow(skill, index === selected)
      addLine([index === selected ? cyan(line) : white(line)])
    })
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
    if (key.name === 'backspace' || (key.ctrl && key.name === 'h')) {
      draft = draft.slice(0, -1)
      error = ''
      render()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      const value = draft.trim()
      if (!value) {
        error = kind === 'github'
          ? 'Give a GitHub repo (owner/name or https://github.com/owner/name).'
          : 'Give an absolute path or a path starting with ~.'
        render()
        return
      }
      if (kind === 'github') runAdd(['--github', value], value)
      else runAdd(['--folder', value])
      return
    }
    const ch = typedChar(key)
    if (!ch || draft.length >= 500) return
    draft += ch
    error = ''
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
    if (key.name === 'backspace' || (key.ctrl && key.name === 'h')) {
      if (entry.field === 'name') entry.name = entry.name.slice(0, -1)
      else if (entry.field === 'description') entry.description = entry.description.slice(0, -1)
      else if (entry.field === 'body') entry.body = entry.body.slice(0, -1)
      error = ''
      render()
      return
    }
    if (key.name === 'return' || key.name === 'enter') {
      if (entry.field === 'name') entry.field = 'description'
      else if (entry.field === 'description') entry.field = 'body'
      else if (entry.field === 'body') entry.body += '\n'
      else {
        submitEntry()
        return
      }
      error = ''
      render()
      return
    }
    const ch = typedChar(key)
    if (!ch || entry.field === 'save') return
    if (entry.field === 'name' && entry.name.length < 64) entry.name += ch
    else if (entry.field === 'description' && entry.description.length < 200) entry.description += ch
    else if (entry.field === 'body' && entry.body.length < 200000) entry.body += ch
    error = ''
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
}
