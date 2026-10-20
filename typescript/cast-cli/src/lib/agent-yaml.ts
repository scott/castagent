import * as fs from 'fs'
import * as path from 'path'
import {parseDocument, YAMLParseError, type Document} from 'yaml'

/**
 * Line the parser quotes. A mark at column 1 of a blank line is the parser
 * stopping after an unclosed token, one past that token.
 */
export function quotedYamlLine(text: string, line: number, column: number): number {
  if (line > 1 && column === 1) {
    const lines = text.split(/\r?\n/)
    const pointed = lines[line - 1] ?? ''
    const previous = lines[line - 2] ?? ''
    if (pointed.trim() === '' && previous.trim() !== '') return line - 1
  }
  return line
}

export class AgentYamlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentYamlError'
  }
}

/**
 * Parse agent.yaml text once.
 * Duplicate keys are kept (last wins), matching PyYAML's safe_load.
 * `quotedYamlLine` always returns a line number, so a parser mark is enough
 * to name the location.
 */
export function parseAgentYamlDocument(text: string, yamlPath: string): Document {
  const doc = parseDocument(text)
  const error = doc.errors.find(item => item.code !== 'DUPLICATE_KEY')
  if (error) {
    const pos = error instanceof YAMLParseError ? error.linePos?.[0] : undefined
    const location = pos ? `${yamlPath}:${quotedYamlLine(text, pos.line, pos.col)}` : yamlPath
    throw new AgentYamlError(`agent.yaml could not be parsed (${location}): ${error.message}`)
  }
  return doc
}

/** Mapping from an already-parsed document. A non-mapping document is thrown. */
export function agentConfigFromDocument(doc: Document, yamlPath: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = doc.toJS()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AgentYamlError(`agent.yaml could not be parsed (${yamlPath}): ${message}`)
  }
  if (parsed == null) return {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentYamlError(`agent.yaml could not be validated (${yamlPath}): expected a mapping`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Load agent.yaml the way deploy must see it.
 * A missing file or an empty document uses the runtime's defaults.
 * A parse error or a non-mapping document is thrown.
 */
export function loadAgentYaml(agentPath: string): Record<string, unknown> {
  const yamlPath = path.join(agentPath, 'agent.yaml')
  if (!fs.existsSync(yamlPath)) return {}

  let text: string
  try {
    text = fs.readFileSync(yamlPath, 'utf8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new AgentYamlError(`agent.yaml could not be read (${yamlPath}): ${message}`)
  }

  return agentConfigFromDocument(parseAgentYamlDocument(text, yamlPath), yamlPath)
}
