/**
 * /update picker logic with no OpenTUI imports.
 * slash-registry cannot be loaded under Node, so tests transpile this file.
 *
 * The modal and the flag form both shell out to `cast update`, which owns
 * validation, the agent.yaml write, and the undo log entry.
 */

export const CAST_CLI_NOT_FOUND = 'cast CLI not found in PATH.'

export const UPDATE_USAGE = [
  'Usage: /update',
  '       /update --model <id>',
  '       /update --description <text>',
  'Run /update with no arguments to pick a field.',
].join('\n')

export const VALID_TOOLS = ['bash', 'read', 'glob'] as const
export const VALID_PERMISSION_LEVELS = ['always-allow', 'ask', 'deny'] as const
export const SUPPORTED_PYTHON_VERSIONS = ['3.11', '3.12'] as const

export const UPDATE_VALUE_FLAGS = [
  '--model',
  '--description',
  '--version',
  '--instructions',
  '--instructions-text',
  '--add-tool',
  '--remove-tool',
  '--add-principle',
  '--remove-principle',
  '--permission',
  '--remove-permission',
  '--python-version',
  '--add-requirement',
  '--remove-requirement',
] as const

export const UPDATE_BOOLEAN_FLAGS = ['--dry-run'] as const

const VALUE_FLAG_SET = new Set<string>(UPDATE_VALUE_FLAGS)
const BOOLEAN_FLAG_SET = new Set<string>(UPDATE_BOOLEAN_FLAGS)

export type UpdateFieldKind = 'text' | 'choice' | 'permission'

export interface UpdateField {
  id: string
  label: string
  flag: string
  kind: UpdateFieldKind
  hint: string
}

export const UPDATE_FIELDS: readonly UpdateField[] = [
  {
    id: 'model',
    label: 'Model',
    flag: '--model',
    kind: 'text',
    hint: 'Model id, for example openrouter/anthropic/claude-sonnet-4.6',
  },
  {
    id: 'description',
    label: 'Description',
    flag: '--description',
    kind: 'text',
    hint: 'One-line description',
  },
  {
    id: 'version',
    label: 'Version',
    flag: '--version',
    kind: 'text',
    hint: 'Version, for example 1.1.0',
  },
  {
    id: 'instructions-text',
    label: 'Instructions text',
    flag: '--instructions-text',
    kind: 'text',
    hint: 'One line. This replaces instructions.md. For a longer prompt, choose Instructions file.',
  },
  {
    id: 'instructions',
    label: 'Instructions file',
    flag: '--instructions',
    kind: 'text',
    hint: 'Path to a prompt file. A path starting with ~ is expanded.',
  },
  {
    id: 'add-tool',
    label: 'Add tool',
    flag: '--add-tool',
    kind: 'choice',
    hint: 'Built-in tool to add',
  },
  {
    id: 'remove-tool',
    label: 'Remove tool',
    flag: '--remove-tool',
    kind: 'choice',
    hint: 'Built-in tool to remove',
  },
  {
    id: 'add-principle',
    label: 'Add principle',
    flag: '--add-principle',
    kind: 'text',
    hint: 'Principle text',
  },
  {
    id: 'remove-principle',
    label: 'Remove principle',
    flag: '--remove-principle',
    kind: 'choice',
    hint: 'Principle to remove',
  },
  {
    id: 'permission',
    label: 'Set permission',
    flag: '--permission',
    kind: 'permission',
    hint: 'Tool, then permission level',
  },
  {
    id: 'remove-permission',
    label: 'Remove permission',
    flag: '--remove-permission',
    kind: 'choice',
    hint: 'Permission to remove',
  },
  {
    id: 'python-version',
    label: 'Python version',
    flag: '--python-version',
    kind: 'choice',
    hint: 'Runtime Python version',
  },
  {
    id: 'add-requirement',
    label: 'Add requirement',
    flag: '--add-requirement',
    kind: 'text',
    hint: 'Python package, for example requests',
  },
  {
    id: 'remove-requirement',
    label: 'Remove requirement',
    flag: '--remove-requirement',
    kind: 'choice',
    hint: 'Requirement to remove',
  },
]

const FIELD_BY_ID = new Map(UPDATE_FIELDS.map((field) => [field.id, field]))

export interface AgentUpdateSnapshot {
  model: string
  description: string
  version: string
  instructionsFile: string
  tools: string[]
  principles: string[]
  permissions: Record<string, string>
  pythonVersion: string
  requirements: string[]
}

export function emptyAgentSnapshot(): AgentUpdateSnapshot {
  return {
    model: '',
    description: '',
    version: '',
    instructionsFile: '',
    tools: [],
    principles: [],
    permissions: {},
    pythonVersion: '',
    requirements: [],
  }
}

export function isUpdateCommandVisible(mode: 'dev' | 'production' | 'on-host'): boolean {
  return mode === 'dev' || mode === 'production'
}

export function updateField(id: string): UpdateField | undefined {
  return FIELD_BY_ID.get(id)
}

export function updateModalTitle(agentName: string, fieldLabel?: string): string {
  return fieldLabel ? `Update ${fieldLabel}: ${agentName}` : `Update: ${agentName}`
}

/** ESC on the field list returns focus to the chat input passed to createModal. */
export function updateFocusReturnTarget(): 'input' {
  return 'input'
}

export function missingAgentMessage(agentName: string, agentPath: string): string {
  return `Agent '${agentName}' not found at ${agentPath}.\nCreate the agent first with: cast dev ${agentName} --no-tui`
}

export function missingAgentYamlMessage(agentYamlPath: string): string {
  return `Agent YAML not found at ${agentYamlPath}.\nThe agent directory may be corrupted. Try recreating the agent.`
}

export function agentYamlParseMessage(detail: string): string {
  return `Failed to parse agent.yaml: ${detail}\nPlease fix the YAML syntax and try again.`
}

export function blankUpdateValueMessage(): string {
  return 'Enter a value.'
}

export function updateArgv(agentName: string, flags: readonly string[]): string[] {
  return ['update', agentName, ...flags]
}

export function flagsForField(fieldId: string, value: string): string[] {
  const field = updateField(fieldId)
  if (!field) throw new Error(`Unknown update field '${fieldId}'`)
  return [field.flag, value]
}

export function permissionValue(tool: string, level: string): string {
  return `${tool}=${level}`
}

export type ParsedUpdateArgs =
  | {ok: true; flags: string[]}
  | {ok: false; message: string}

function isKnownFlag(token: string): boolean {
  return VALUE_FLAG_SET.has(token) || BOOLEAN_FLAG_SET.has(token)
}

/**
 * Turn `/update` arguments into `cast update` flags.
 * A value runs until the next flag, so a description can contain spaces
 * after the chat input splits on them.
 */
export function parseUpdateArgs(args: readonly string[]): ParsedUpdateArgs {
  if (args.length === 0) return {ok: false, message: UPDATE_USAGE}
  const flags: string[] = []
  let index = 0
  while (index < args.length) {
    const token = args[index]
    if (!token.startsWith('--') || !isKnownFlag(token)) {
      return {ok: false, message: UPDATE_USAGE}
    }
    if (BOOLEAN_FLAG_SET.has(token)) {
      flags.push(token)
      index += 1
      continue
    }
    index += 1
    const parts: string[] = []
    while (index < args.length && !isKnownFlag(args[index])) {
      parts.push(args[index])
      index += 1
    }
    if (parts.length === 0) {
      return {ok: false, message: `Missing value for ${token}.\n${UPDATE_USAGE}`}
    }
    flags.push(token, parts.join(' '))
  }
  return {ok: true, flags}
}

export function wrapUpdateIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0
  const current = ((index % length) + length) % length
  const step = ((delta % length) + length) % length
  return (current + step) % length
}

export function updateWindow(
  length: number,
  selected: number,
  maxRows: number,
): {start: number; end: number} {
  if (length <= 0 || maxRows <= 0) return {start: 0, end: 0}
  const size = Math.min(maxRows, length)
  let start = Math.max(0, selected - Math.floor((size - 1) / 2))
  if (start + size > length) start = Math.max(0, length - size)
  return {start, end: start + size}
}

/** Modal width and height match createModal's 90% by 80% defaults. */
export function updateModalInnerRows(termHeight: number): number {
  const height = Number.isFinite(termHeight) && termHeight > 0 ? Math.floor(termHeight) : 24
  return Math.max(0, Math.floor(height * 0.8) - 4)
}

const UPDATE_LIST_CHROME = 4
const UPDATE_ERROR_ROWS = 5

export function updateMaxRows(termHeight: number, hasError = false): number {
  const reserved = UPDATE_LIST_CHROME + (hasError ? UPDATE_ERROR_ROWS : 0)
  const room = updateModalInnerRows(termHeight) - reserved
  return room >= 1 ? room : 1
}

export function fitUpdateLine(text: string, columns: number): string {
  const single = text.replace(/[\r\n]+/g, ' ')
  const shown = single.length > 0 ? single : ' '
  if (!Number.isFinite(columns) || columns <= 0) return shown
  if (shown.length > columns) return shown.slice(0, columns)
  return shown.padEnd(columns, ' ')
}

/** Current values in the field list stop at 50 characters. */
export function truncateUpdateValue(value: string, max = 50): string {
  const single = value.replace(/[\r\n]+/g, ' ').trim()
  if (single.length <= max) return single
  if (max <= 3) return single.slice(0, max)
  return single.slice(0, max - 3) + '...'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0)
}

export function snapshotFromConfig(config: unknown): AgentUpdateSnapshot {
  const root = asRecord(config)
  if (!root) return emptyAgentSnapshot()
  const brain = asRecord(root.brain)
  const harness = asRecord(root.harness)
  const tools = asRecord(root.tools)
  const runtime = asRecord(root.runtime)
  const permissions: Record<string, string> = {}
  const rawPermissions = asRecord(harness?.permissions)
  if (rawPermissions) {
    for (const key of Object.keys(rawPermissions).sort()) {
      const level = asString(rawPermissions[key])
      if (level) permissions[key] = level
    }
  }
  return {
    model: asString(brain?.model),
    description: asString(root.description),
    version: asString(root.version),
    instructionsFile: asString(brain?.instructions_file),
    tools: asStringList(tools?.builtin),
    principles: asStringList(harness?.principles),
    permissions,
    pythonVersion: asString(runtime?.python_version),
    requirements: asStringList(runtime?.requirements),
  }
}

export function currentForField(fieldId: string, snapshot: AgentUpdateSnapshot): string {
  switch (fieldId) {
    case 'model':
      return snapshot.model
    case 'description':
      return snapshot.description
    case 'version':
      return snapshot.version
    case 'instructions-text':
      return snapshot.instructionsFile
    case 'instructions':
      return snapshot.instructionsFile
    case 'add-tool':
    case 'remove-tool':
      return snapshot.tools.join(', ')
    case 'add-principle':
    case 'remove-principle':
      return snapshot.principles.join(', ')
    case 'permission':
    case 'remove-permission':
      return Object.keys(snapshot.permissions).sort().map((tool) => `${tool}=${snapshot.permissions[tool]}`).join(', ')
    case 'python-version':
      return snapshot.pythonVersion
    case 'add-requirement':
    case 'remove-requirement':
      return snapshot.requirements.join(', ')
    default:
      return ''
  }
}

export function emptyChoiceMessage(fieldId: string): string {
  switch (fieldId) {
    case 'remove-tool':
      return 'This agent has no built-in tools to remove.'
    case 'remove-principle':
      return 'This agent has no principles to remove.'
    case 'remove-requirement':
      return 'This agent has no requirements to remove.'
    case 'remove-permission':
      return 'This agent has no permissions to remove.'
    default:
      return 'Nothing to choose.'
  }
}

export function choicesForField(fieldId: string, snapshot: AgentUpdateSnapshot): string[] {
  switch (fieldId) {
    case 'add-tool':
    case 'permission':
      return [...VALID_TOOLS]
    case 'remove-tool':
      return snapshot.tools.filter((tool) => (VALID_TOOLS as readonly string[]).includes(tool))
    case 'remove-principle':
      return [...snapshot.principles]
    case 'remove-permission':
      return Object.keys(snapshot.permissions).sort()
    case 'python-version':
      return [...SUPPORTED_PYTHON_VERSIONS]
    case 'remove-requirement':
      return [...snapshot.requirements]
    default:
      return []
  }
}

export function permissionLevels(): string[] {
  return [...VALID_PERMISSION_LEVELS]
}

export function choiceNote(
  fieldId: string,
  choice: string,
  snapshot: AgentUpdateSnapshot,
  tool?: string,
): string {
  if (fieldId === 'python-version' && choice === snapshot.pythonVersion) return '(current)'
  if (fieldId === 'add-tool' && snapshot.tools.includes(choice)) return '(added)'
  if (fieldId === 'permission' && tool && snapshot.permissions[tool] === choice) return '(current)'
  return ''
}

export function textFieldMaxLength(fieldId: string): number {
  switch (fieldId) {
    case 'model':
      return 200
    case 'description':
    case 'add-principle':
    case 'instructions':
      return 500
    case 'version':
      return 64
    case 'instructions-text':
      return 8000
    case 'add-requirement':
      return 200
    default:
      return 500
  }
}

export function normalizeFieldValue(fieldId: string, raw: string, home: string): string {
  const trimmed = raw.trim()
  if (fieldId === 'instructions') return expandHome(trimmed, home)
  return trimmed
}

export function expandHome(input: string, home: string): string {
  if (input === '~') return home
  if (input.startsWith('~/')) return `${home}/${input.slice(2)}`
  return input
}

export function unchangedUpdateMessage(
  fieldId: string,
  value: string,
  snapshot: AgentUpdateSnapshot,
): string | null {
  if (fieldId === 'model' && snapshot.model && value === snapshot.model) {
    return `Model is already ${value}.`
  }
  if (fieldId === 'description' && snapshot.description && value === snapshot.description) {
    return 'Description is already set to that text.'
  }
  if (fieldId === 'version' && snapshot.version && value === snapshot.version) {
    return `Version is already ${value}.`
  }
  if (fieldId === 'python-version' && snapshot.pythonVersion && value === snapshot.pythonVersion) {
    return `Python version is already ${value}.`
  }
  if (fieldId === 'add-tool' && snapshot.tools.includes(value)) {
    return `Tool '${value}' is already on this agent.`
  }
  if (fieldId === 'permission') {
    const split = value.indexOf('=')
    if (split > 0) {
      const tool = value.slice(0, split)
      const level = value.slice(split + 1)
      if (snapshot.permissions[tool] === level) return `Permission ${tool} is already ${level}.`
    }
  }
  return null
}

export function updateRestartLine(agentName: string): string {
  return `Restart the local agent so it picks up the change: cast dev ${agentName}`
}

export function updateAppliedMessage(agentName: string, stdout: string): string {
  const dryRun = /dry run mode/i.test(stdout)
  const changes = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('+ '))
  if (!dryRun && changes.length === 0 && /no changes made/i.test(stdout)) {
    return `No changes made for '${agentName}'. Pick a field with /update.`
  }
  const lines: string[] = []
  if (dryRun) lines.push(`Dry run for '${agentName}'. No changes written.`)
  else lines.push(`Updated '${agentName}'.`)
  for (const change of changes) lines.push(change)
  if (!dryRun && changes.length > 0) lines.push(updateRestartLine(agentName))
  return lines.join('\n')
}

export type UpdateLineTone = 'text' | 'hint' | 'error'

export interface UpdateLine {
  text: string
  tone: UpdateLineTone
  selected: boolean
}

const LABEL_WIDTH = 18

export function formatUpdateFieldRow(label: string, selected: boolean, current: string): string {
  const prefix = selected ? '▸ ' : '  '
  const value = truncateUpdateValue(current)
  if (!value) return `${prefix}${label}`
  return `${prefix}${label.padEnd(LABEL_WIDTH, ' ')}  ${value}`
}

export function formatUpdateChoiceRow(label: string, selected: boolean, note: string): string {
  const prefix = selected ? '▸ ' : '  '
  return note ? `${prefix}${label}  ${note}` : `${prefix}${label}`
}

function pushLine(
  lines: UpdateLine[],
  text: string,
  tone: UpdateLineTone,
  columns: number,
  selected = false,
): void {
  lines.push({text: fitUpdateLine(text, columns), tone, selected})
}

function pushError(lines: UpdateLine[], error: string | null | undefined, columns: number): void {
  if (!error || !error.trim()) return
  pushLine(lines, ' ', 'hint', columns)
  for (const line of error.split('\n')) pushLine(lines, line, 'error', columns)
}

export function buildUpdateFieldLines(options: {
  fields: readonly {label: string; id: string}[]
  currents: readonly string[]
  selected: number
  termHeight: number
  columns: number
  error?: string | null
}): UpdateLine[] {
  const columns = options.columns
  const error = options.error && options.error.trim() ? options.error : null
  const length = options.fields.length
  const selected = length === 0 ? 0 : Math.min(Math.max(options.selected, 0), length - 1)
  const span = updateWindow(length, selected, updateMaxRows(options.termHeight, error !== null))
  const lines: UpdateLine[] = []
  if (span.start > 0) pushLine(lines, '  ...', 'hint', columns)
  for (let index = span.start; index < span.end; index++) {
    const field = options.fields[index]
    const rowSelected = index === selected
    pushLine(
      lines,
      formatUpdateFieldRow(field.label, rowSelected, options.currents[index] ?? ''),
      'text',
      columns,
      rowSelected,
    )
  }
  if (span.end < length) pushLine(lines, '  ...', 'hint', columns)
  pushError(lines, error, columns)
  pushLine(lines, ' ', 'hint', columns)
  pushLine(lines, '↑↓ Select   Enter Edit   ESC Close', 'hint', columns)
  return lines
}

export function buildUpdateChoiceLines(options: {
  choices: readonly string[]
  notes: readonly string[]
  selected: number
  termHeight: number
  columns: number
  error?: string | null
  footer: string
}): UpdateLine[] {
  const columns = options.columns
  const error = options.error && options.error.trim() ? options.error : null
  const length = options.choices.length
  const selected = length === 0 ? 0 : Math.min(Math.max(options.selected, 0), length - 1)
  const span = updateWindow(length, selected, updateMaxRows(options.termHeight, error !== null))
  const lines: UpdateLine[] = []
  if (span.start > 0) pushLine(lines, '  ...', 'hint', columns)
  for (let index = span.start; index < span.end; index++) {
    const rowSelected = index === selected
    pushLine(
      lines,
      formatUpdateChoiceRow(options.choices[index], rowSelected, options.notes[index] ?? ''),
      'text',
      columns,
      rowSelected,
    )
  }
  if (span.end < length) pushLine(lines, '  ...', 'hint', columns)
  pushError(lines, error, columns)
  pushLine(lines, ' ', 'hint', columns)
  pushLine(lines, options.footer, 'hint', columns)
  return lines
}

export function buildUpdateTextLines(options: {
  hint: string
  preview: string
  columns: number
  error?: string | null
}): UpdateLine[] {
  const columns = options.columns
  const lines: UpdateLine[] = []
  pushLine(lines, options.hint, 'hint', columns)
  pushLine(lines, options.preview || ' ', 'text', columns)
  pushError(lines, options.error, columns)
  pushLine(lines, ' ', 'hint', columns)
  pushLine(lines, 'Enter Apply   ESC Back', 'hint', columns)
  return lines
}
