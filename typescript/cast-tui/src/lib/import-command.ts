/**
 * Pure /import decisions. No OpenTUI imports so Node tests can load this file.
 * The slash handler renders these fields with the same key-by-key text input
 * used by /connect and /rename.
 */

export const IMPORT_MODAL_TITLE = 'Import Cast Agent'
export const IMPORT_MODAL_FOOTER = 'Enter Submit  ESC Close'
export const IMPORT_SOURCE_PLACEHOLDER = 'GitHub URL, user/repo, or local path'
export const IMPORT_NAME_PLACEHOLDER = 'Local agent name (leave blank to use default)'
export const IMPORT_FOCUS_TARGET = 'input' as const

const FIELD_MAX = 1024

export interface ImportModalField {
  id: 'source' | 'name'
  label: string
  required: boolean
  placeholder: string
}

export interface ImportModalSpec {
  title: string
  footer: string
  width: '90%'
  height: '80%'
  centered: true
  overlay: true
  focusOnClose: typeof IMPORT_FOCUS_TARGET
  fields: ImportModalField[]
}

export interface ImportModalFields {
  source: string
  name: string
  active: 'source' | 'name'
}

export interface ImportKey {
  name?: string
  ctrl?: boolean
  meta?: boolean
  sequence?: string
}

export type ImportModalEffect =
  | {type: 'update'; fields: ImportModalFields}
  | {type: 'invalid'; message: string; fields: ImportModalFields}
  | {type: 'close'; focus: typeof IMPORT_FOCUS_TARGET}
  | {type: 'submit'; source: string; name?: string}
  | {type: 'ignore'}

export type ImportPlan =
  | {type: 'modal'}
  | {type: 'run'; source: string; name?: string}

export interface ImportCommandHost {
  importAgent: (source: string, options: {name?: string}) => Promise<{name: string}>
  openModal: (spec: ImportModalSpec) => Promise<
    | {type: 'submit'; source: string; name?: string}
    | {type: 'cancel'; focus: typeof IMPORT_FOCUS_TARGET}
  >
  addAgentMessage: (text: string) => void
}

export function importModalSpec(): ImportModalSpec {
  return {
    title: IMPORT_MODAL_TITLE,
    footer: IMPORT_MODAL_FOOTER,
    width: '90%',
    height: '80%',
    centered: true,
    overlay: true,
    focusOnClose: IMPORT_FOCUS_TARGET,
    fields: [
      {
        id: 'source',
        label: 'Source',
        required: true,
        placeholder: IMPORT_SOURCE_PLACEHOLDER,
      },
      {
        id: 'name',
        label: 'Name',
        required: false,
        placeholder: IMPORT_NAME_PLACEHOLDER,
      },
    ],
  }
}

export function initialImportModalFields(): ImportModalFields {
  return {source: '', name: '', active: 'source'}
}

/** `/import` with no source opens the modal. A source skips it; the next arg is the name. */
export function planImportInvocation(args: string[]): ImportPlan {
  const source = (args[0] ?? '').trim()
  if (!source) return {type: 'modal'}
  const name = (args[1] ?? '').trim()
  if (!name) return {type: 'run', source}
  return {type: 'run', source, name}
}

export function reduceImportModal(fields: ImportModalFields, key: ImportKey): ImportModalEffect {
  const keyName = key.name || ''
  if (keyName === 'escape') {
    return {type: 'close', focus: IMPORT_FOCUS_TARGET}
  }
  if (keyName === 'return' || keyName === 'enter') {
    const source = fields.source.trim()
    if (!source) {
      return {type: 'invalid', message: 'Source is required.', fields}
    }
    const name = fields.name.trim()
    return {type: 'submit', source, name: name || undefined}
  }
  if (keyName === 'tab' || keyName === 'up' || keyName === 'down') {
    return {
      type: 'update',
      fields: {...fields, active: fields.active === 'source' ? 'name' : 'source'},
    }
  }
  if (keyName === 'backspace' || (key.ctrl && keyName === 'h')) {
    const current = fields[fields.active]
    if (current.length === 0) return {type: 'update', fields}
    return {
      type: 'update',
      fields: {...fields, [fields.active]: current.slice(0, -1)},
    }
  }
  const ch = printableChar(key)
  if (!ch) return {type: 'ignore'}
  const current = fields[fields.active]
  if (current.length >= FIELD_MAX) return {type: 'update', fields}
  return {
    type: 'update',
    fields: {...fields, [fields.active]: current + ch},
  }
}

export function formatImportSuccess(name: string, source: string): string {
  return [
    `Imported '${name}' from ${source}.`,
    '',
    'Next steps:',
    `- cast dev ${name}`,
    `- cast edit ${name}`,
    `- cast deploy ${name} --provider docker`,
  ].join('\n')
}

export function mapImportError(error: unknown): string {
  const code = readString(error, 'code')
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : readString(error, 'message') || String(error)

  if (code === 'auth' || isAuthMessage(message)) {
    return 'Authentication failed. Check SSH keys or use a GitHub token for HTTPS.'
  }
  if (
    code === 'missing-agent-yaml' ||
    /missing agent\.yaml/i.test(message) ||
    /does not contain a valid Cast agent/i.test(message) ||
    /does not contain a Cast agent/i.test(message)
  ) {
    return 'Source is not a Cast agent (missing agent.yaml).'
  }
  if (code === 'name-collision') {
    const agentName = readString(error, 'agentName') || 'unknown'
    return `Agent '${agentName}' already exists. Use a different name or run \`cast delete ${agentName}\` first.`
  }
  return message
}

export async function handleImportCommand(args: string[], host: ImportCommandHost): Promise<void> {
  const plan = planImportInvocation(args)
  let source: string
  let name: string | undefined
  if (plan.type === 'modal') {
    const outcome = await host.openModal(importModalSpec())
    if (outcome.type === 'cancel') return
    source = outcome.source
    name = outcome.name
  } else {
    source = plan.source
    name = plan.name
  }

  try {
    const result = await host.importAgent(source, name ? {name} : {})
    host.addAgentMessage(formatImportSuccess(result.name, source))
  } catch (error) {
    host.addAgentMessage(mapImportError(error))
  }
}

function printableChar(key: ImportKey): string | null {
  if (key.ctrl || key.meta) return null
  const sequence = key.sequence
  if (sequence && sequence.length === 1 && isPrintable(sequence)) return sequence
  const name = key.name
  if (name && name.length === 1 && isPrintable(name)) return name
  return null
}

function isPrintable(value: string): boolean {
  const code = value.charCodeAt(0)
  return code >= 32 && code <= 126
}

function readString(error: unknown, key: string): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const value = (error as Record<string, unknown>)[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function isAuthMessage(message: string): boolean {
  return /authentication failed|permission denied \(publickey\)|could not read username|terminal prompts disabled/i.test(message)
}
