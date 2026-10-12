import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {BoxRenderable, TextRenderable, StyledText, white, dim, red} from '@opentui/core'
import type {KeyEvent} from '@opentui/core'
import {createModal} from '../components/modal.js'
import {
  classifyBuilderSkillAddSource,
  formatBuilderSkillRow,
  sortBuilderSkillRows,
  wrapSkillIndex,
  type BuilderSkillRow,
} from '../lib/builder-skills-list.js'

/**
 * Host surface the slash command passes in. Kept narrow so this file does
 * not import the slash registry.
 */
export interface BuilderSkillsHost {
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

const ADD_SOURCES: BuilderSkillRow[] = [
  {name: 'GitHub repository', description: 'owner/repo, owner/repo@ref, or a github.com URL'},
  {name: 'Folder on disk', description: 'A directory that contains SKILL.md'},
  {name: 'Enter it here', description: 'Name, description, and markdown'},
]

const MANUAL_FIELDS = ['name', 'description', 'body', 'save'] as const

/**
 * Locate the cast CLI binary. Same search order as findCastBinary in
 * slash-registry.ts (itself duplicated from components/terminal.ts).
 */
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

function runCast(args: string[], input?: string): CastResult {
  const binary = findCastBinary()
  if (!binary) {
    return {status: 127, stdout: '', stderr: 'Could not find cast CLI binary. Please ensure cast is installed.'}
  }
  try {
    const stdout = execFileSync(binary, ['builder-skills', ...args], {
      encoding: 'utf8',
      cwd: os.homedir(),
      timeout: 120000,
      ...(input !== undefined ? {input} : {}),
    })
    return {status: 0, stdout: stdout ?? '', stderr: ''}
  } catch (err: any) {
    const stdout = typeof err?.stdout === 'string' ? err.stdout : err?.stdout?.toString?.() ?? ''
    const stderr = typeof err?.stderr === 'string' ? err.stderr : err?.stderr?.toString?.() ?? ''
    return {status: typeof err?.status === 'number' ? err.status : 1, stdout, stderr: stderr || err?.message || String(err)}
  }
}

function failureText(result: CastResult): string {
  const text = (result.stderr || result.stdout || 'Failed to update builder skills.').trim()
  return text.length > 500 ? text.slice(0, 497) + '...' : text
}

function appliedMessage(verb: 'Added' | 'Removed', name: string): string {
  return `${verb} builder skill '${name}'. It will apply on the next \`cast new\` or \`cast edit\`.`
}

function parseInstalled(stdout: string): {name: string} | null {
  try {
    const parsed = JSON.parse(stdout)
    if (parsed && typeof parsed.name === 'string') return {name: parsed.name}
  } catch {
    // not JSON
  }
  return null
}

function parseMultiple(stdout: string): BuilderSkillRow[] | null {
  try {
    const parsed = JSON.parse(stdout)
    if (!parsed || parsed.error !== 'multiple' || !Array.isArray(parsed.candidates)) return null
    return parsed.candidates.map((candidate: {name?: string; description?: string; subpath?: string}) => ({
      name: String(candidate.name ?? ''),
      description: String(candidate.description ?? ''),
      subpath: String(candidate.subpath ?? ''),
    }))
  } catch {
    return null
  }
}

function loadSkillRows(): {ok: true; skills: BuilderSkillRow[]} | {ok: false; error: string} {
  const result = runCast(['--json'])
  if (result.status !== 0) return {ok: false, error: failureText(result)}
  try {
    const parsed = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) throw new Error('not a list')
    const skills = sortBuilderSkillRows(parsed.map((skill: {name?: string; description?: string}) => ({
      name: String(skill.name ?? ''),
      description: String(skill.description ?? ''),
    })))
    return {ok: true, skills}
  } catch {
    return {ok: false, error: 'Failed to read builder skills.'}
  }
}

function printableChar(key: KeyEvent): string | null {
  if (key.ctrl || key.meta) return null
  const sequence = (key as KeyEvent & {sequence?: string}).sequence
  if (sequence && sequence.length === 1 && sequence >= ' ' && sequence !== '\u007f') return sequence
  if (key.name === 'space') return ' '
  if (key.name && key.name.length === 1 && key.name >= ' ' && key.name <= '~') return key.name
  return null
}

type Screen =
  | {name: 'list'; skills: BuilderSkillRow[]; selected: number; error?: string}
  | {name: 'add'; selected: number}
  | {name: 'github'; draft: string; error?: string}
  | {name: 'folder'; draft: string; error?: string}
  | {name: 'manual'; nameText: string; description: string; body: string; field: number; error?: string}
  | {name: 'pick'; source: string; candidates: BuilderSkillRow[]; selected: number; error?: string}
  | {name: 'confirm'; skillName: string}

function directoryExists(source: string): boolean {
  try {
    return fs.existsSync(source) && fs.statSync(source).isDirectory()
  } catch {
    return false
  }
}

/**
 * /builder-skills. The TUI shells out to `cast builder-skills` and does not
 * write ~/.cast/builder/skills itself. ESC closes every step.
 */
export function openBuilderSkillsCommand(ctx: BuilderSkillsHost, args: string[]): void {
  if (args.length === 0) {
    const loaded = loadSkillRows()
    openModal(ctx, loaded.ok
      ? {name: 'list', skills: loaded.skills, selected: 0}
      : {name: 'list', skills: [], selected: 0, error: loaded.error})
    return
  }
  if (args[0] !== 'add') {
    ctx.messages.addAgentMessage('Usage: /builder-skills [add <github-or-folder>]', ctx.mode)
    return
  }
  const source = args.slice(1).join(' ').trim()
  if (!source) {
    openModal(ctx, {name: 'add', selected: 0})
    return
  }
  const kind = classifyBuilderSkillAddSource(source, directoryExists(source))
  if (kind === 'invalid') {
    ctx.messages.addAgentMessage(
      `Could not add a builder skill from '${source}'. Run /builder-skills to enter a skill in the modal.`,
      ctx.mode,
    )
    return
  }
  if (kind === 'folder') {
    const result = runCast(['add', '--folder', source, '--json'])
    reportInstall(ctx, result)
    return
  }
  const result = runCast(['add', '--github', source, '--json'])
  const multiple = parseMultiple(result.stdout)
  if (multiple) {
    openModal(ctx, {name: 'pick', source, candidates: sortBuilderSkillRows(multiple), selected: 0})
    return
  }
  reportInstall(ctx, result)
}

function reportInstall(ctx: BuilderSkillsHost, result: CastResult): void {
  if (result.status === 0) {
    const installed = parseInstalled(result.stdout)
    ctx.messages.addAgentMessage(appliedMessage('Added', installed?.name ?? 'skill'), ctx.mode)
    return
  }
  ctx.messages.addAgentMessage(failureText(result), ctx.mode)
}

function openModal(ctx: BuilderSkillsHost, initial: Screen): void {
  const modal = createModal(ctx.renderer, ctx.input, {
    title: 'Builder skills',
    width: '90%',
    height: '80%',
    centered: true,
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

  let screen = initial

  const close = () => {
    modal.hide()
    ctx.input.focus()
  }

  const succeed = (verb: 'Added' | 'Removed', name: string) => {
    close()
    ctx.messages.addAgentMessage(appliedMessage(verb, name), ctx.mode)
  }

  const addLine = (text: string, tone: 'text' | 'selected' | 'error' | 'hint' = 'text') => {
    const color = tone === 'error' ? red : tone === 'selected' || tone === 'text' ? white : dim
    contentBox.add(new TextRenderable(ctx.renderer, {content: new StyledText([color(text)])}))
  }

  const clear = () => {
    for (const child of contentBox.getChildren()) contentBox.remove(child.id)
  }

  const footer = (text: string) => {
    addLine(' ')
    addLine(text, 'hint')
  }

  function showList(error?: string) {
    const loaded = loadSkillRows()
    screen = loaded.ok
      ? {name: 'list', skills: loaded.skills, selected: 0, error: error ?? undefined}
      : {name: 'list', skills: [], selected: 0, error: loaded.error}
    render()
  }

  function installGithub(source: string, subpath?: string) {
    const args = ['add', '--github', source, '--json']
    if (subpath !== undefined) args.push('--subpath', subpath || '.')
    const result = runCast(args)
    const multiple = parseMultiple(result.stdout)
    if (multiple) {
      screen = {name: 'pick', source, candidates: sortBuilderSkillRows(multiple), selected: 0}
      render()
      return
    }
    if (result.status === 0) {
      const installed = parseInstalled(result.stdout)
      succeed('Added', installed?.name ?? 'skill')
      return
    }
    if (screen.name === 'github' || screen.name === 'pick') {
      screen = {...screen, error: failureText(result)}
      render()
      return
    }
    close()
    ctx.messages.addAgentMessage(failureText(result), ctx.mode)
  }

  function installFolder(folder: string) {
    const result = runCast(['add', '--folder', folder, '--json'])
    if (result.status === 0) {
      const installed = parseInstalled(result.stdout)
      succeed('Added', installed?.name ?? 'skill')
      return
    }
    screen = {name: 'folder', draft: folder, error: failureText(result)}
    render()
  }

  function saveManual(draft: {nameText: string; description: string; body: string; field: number}) {
    const result = runCast(
      ['add', '--name', draft.nameText.trim(), '--description', draft.description.trim(), '--body', '-', '--json'],
      draft.body,
    )
    if (result.status === 0) {
      const installed = parseInstalled(result.stdout)
      succeed('Added', installed?.name ?? draft.nameText.trim())
      return
    }
    screen = {...draft, name: 'manual', error: failureText(result)}
    render()
  }

  function render() {
    clear()
    const current = screen
    if (current.name === 'list') {
      modal.setTitle('Builder skills')
      if (current.error) addLine(current.error, 'error')
      if (current.skills.length === 0) {
        addLine('No builder skills yet. Skills added here are used the next time you create or edit an agent.', 'hint')
      } else {
        const selected = current.selected
        current.skills.forEach((skill, index) => {
          addLine(formatBuilderSkillRow(skill, index === selected), index === selected ? 'selected' : 'hint')
        })
      }
      footer('A Add   D Remove   ↑↓ Navigate   ESC Close')
    } else if (current.name === 'add') {
      modal.setTitle('Add builder skill')
      addLine('Choose a source', 'hint')
      const selected = current.selected
      ADD_SOURCES.forEach((source, index) => {
        addLine(formatBuilderSkillRow(source, index === selected), index === selected ? 'selected' : 'hint')
      })
      footer('↑↓ Navigate   Enter Select   ESC Close')
    } else if (current.name === 'github') {
      modal.setTitle('GitHub repository')
      addLine('owner/repo, owner/repo@ref, or a github.com URL', 'hint')
      addLine((current.draft || '') + '_', 'selected')
      if (current.error) addLine(current.error, 'error')
      footer('Enter Install   ESC Close')
    } else if (current.name === 'folder') {
      modal.setTitle('Folder on disk')
      addLine('Path to a folder that contains SKILL.md', 'hint')
      addLine((current.draft || '') + '_', 'selected')
      if (current.error) addLine(current.error, 'error')
      footer('Enter Install   ESC Close')
    } else if (current.name === 'manual') {
      modal.setTitle('New builder skill')
      const labels = ['Name', 'Description', 'Body', 'Save']
      const values = [current.nameText, current.description, current.body, '']
      for (let i = 0; i < labels.length; i++) {
        const selected = i === current.field
        const prefix = selected ? '▸ ' : '  '
        if (i === 3) {
          addLine(`${prefix}Save`, selected ? 'selected' : 'hint')
          continue
        }
        addLine(`${prefix}${labels[i]}`, selected ? 'selected' : 'hint')
        addLine(`  ${values[i]}${selected ? '_' : ''}`, 'text')
      }
      if (current.error) addLine(current.error, 'error')
      footer('Enter does not save the body. Ctrl+S or Save writes the skill. ESC Close')
    } else if (current.name === 'pick') {
      modal.setTitle('Choose a skill')
      addLine('This repository has more than one skill.', 'hint')
      const selected = current.selected
      current.candidates.forEach((skill, index) => {
        addLine(formatBuilderSkillRow(skill, index === selected), index === selected ? 'selected' : 'hint')
      })
      if (current.error) addLine(current.error, 'error')
      footer('↑↓ Navigate   Enter Install   ESC Close')
    } else {
      modal.setTitle('Remove builder skill')
      addLine(`Delete '${current.skillName}'?`, 'text')
      addLine('This deletes that skill directory only.', 'hint')
      footer('Y Delete   N Cancel   ESC Close')
    }

    modal.setContent(contentBox)
    ctx.renderer.requestRender?.()
  }

  modal.box.handleKeyPress = (key: KeyEvent): boolean => {
    if (key.name === 'escape') {
      close()
      return true
    }

    if (screen.name === 'list') {
      const keyName = (key.name ?? '').toLowerCase()
      if (key.ctrl || key.meta) return false
      if (key.name === 'up' || key.name === 'down') {
        if (screen.skills.length > 0) {
          const delta = key.name === 'up' ? -1 : 1
          screen = {...screen, selected: wrapSkillIndex(screen.selected, delta, screen.skills.length)}
          render()
        }
        return true
      }
      if (keyName === 'a') {
        screen = {name: 'add', selected: 0}
        render()
        return true
      }
      if (keyName === 'd') {
        if (screen.skills.length === 0) {
          screen = {...screen, error: 'No builder skills to remove.'}
          render()
          return true
        }
        const skill = screen.skills[screen.selected]
        if (!skill) return true
        screen = {name: 'confirm', skillName: skill.name}
        render()
        return true
      }
      return false
    }

    if (screen.name === 'add') {
      if (key.name === 'up' || key.name === 'down') {
        const delta = key.name === 'up' ? -1 : 1
        screen = {...screen, selected: wrapSkillIndex(screen.selected, delta, ADD_SOURCES.length)}
        render()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        if (screen.selected === 0) screen = {name: 'github', draft: ''}
        else if (screen.selected === 1) screen = {name: 'folder', draft: ''}
        else screen = {name: 'manual', nameText: '', description: '', body: '', field: 0}
        render()
        return true
      }
      return false
    }

    if (screen.name === 'github' || screen.name === 'folder') {
      if (key.name === 'return' || key.name === 'enter') {
        const draft = screen.draft.trim()
        if (!draft) {
          screen = {...screen, error: 'A value is required.'}
          render()
          return true
        }
        if (screen.name === 'github') installGithub(draft)
        else installFolder(draft)
        return true
      }
      if (key.name === 'backspace') {
        screen = {...screen, draft: screen.draft.slice(0, -1), error: undefined}
        render()
        return true
      }
      const ch = printableChar(key)
      if (ch && screen.draft.length < 300) {
        screen = {...screen, draft: screen.draft + ch, error: undefined}
        render()
        return true
      }
      return false
    }

    if (screen.name === 'manual') {
      if (key.ctrl && (key.name === 's' || key.name === 'S')) {
        saveManual(screen)
        return true
      }
      if (key.name === 'up' || key.name === 'down') {
        const delta = key.name === 'up' ? -1 : 1
        screen = {...screen, field: wrapSkillIndex(screen.field, delta, MANUAL_FIELDS.length)}
        render()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        // Enter moves between the single-line fields. In the body it inserts
        // a newline. Saving is Ctrl+S or the Save line, never a plain Enter.
        if (screen.field === 3) {
          saveManual(screen)
          return true
        }
        if (screen.field === 2) screen = {...screen, body: screen.body + '\n'}
        else screen = {...screen, field: screen.field + 1}
        render()
        return true
      }
      if (key.name === 'backspace') {
        if (screen.field === 0) screen = {...screen, nameText: screen.nameText.slice(0, -1)}
        else if (screen.field === 1) screen = {...screen, description: screen.description.slice(0, -1)}
        else if (screen.field === 2) screen = {...screen, body: screen.body.slice(0, -1)}
        render()
        return true
      }
      const ch = printableChar(key)
      if (!ch || screen.field === 3) return false
      if (screen.field === 0 && screen.nameText.length < 64) screen = {...screen, nameText: screen.nameText + ch}
      else if (screen.field === 1 && screen.description.length < 200) screen = {...screen, description: screen.description + ch}
      else if (screen.field === 2 && screen.body.length < 20000) screen = {...screen, body: screen.body + ch}
      render()
      return true
    }

    if (screen.name === 'pick') {
      if (key.name === 'up' || key.name === 'down') {
        const delta = key.name === 'up' ? -1 : 1
        screen = {...screen, selected: wrapSkillIndex(screen.selected, delta, screen.candidates.length)}
        render()
        return true
      }
      if (key.name === 'return' || key.name === 'enter') {
        const chosen = screen.candidates[screen.selected]
        if (!chosen) return true
        installGithub(screen.source, chosen.subpath ?? '.')
        return true
      }
      return false
    }

    const keyName = (key.name ?? '').toLowerCase()
    if (key.ctrl || key.meta) return false
    if (keyName === 'y') {
      const name = screen.skillName
      const result = runCast(['remove', name, '--json'])
      if (result.status === 0) succeed('Removed', name)
      else {
        const loaded = loadSkillRows()
        screen = {
          name: 'list',
          skills: loaded.ok ? loaded.skills : [],
          selected: 0,
          error: failureText(result),
        }
        render()
      }
      return true
    }
    if (keyName === 'n') {
      showList()
      return true
    }
    return false
  }

  modal.setContent(contentBox)
  ctx.renderer.root.add(modal.box)
  modal.show()
  render()
}
