import * as fs from 'fs'
import * as path from 'path'
import {parseDocument, YAMLParseError} from 'yaml'

export class AgentYamlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentYamlError'
  }
}

/**
 * Load agent.yaml the way deploy must see it.
 * A missing file or an empty document uses the runtime's defaults.
 * A parse error or a non-mapping document is thrown.
 * Duplicate keys are kept (last wins), matching PyYAML's safe_load.
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

  const doc = parseDocument(text)
  const error = doc.errors.find(item => item.code !== 'DUPLICATE_KEY')
  if (error) {
    const line = error instanceof YAMLParseError ? error.linePos?.[0]?.line : undefined
    const location = typeof line === 'number' ? `${yamlPath}:${line}` : yamlPath
    throw new AgentYamlError(`agent.yaml could not be parsed (${location}): ${error.message}`)
  }

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
