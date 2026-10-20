import {isAlias, isMap, isScalar, parseDocument, YAMLParseError, type Scalar} from 'yaml'
import {AgentYamlError, quotedYamlLine} from './agent-yaml'

/**
 * Version string both `cast deploy` and the Python runtime report when
 * agent.yaml has no usable top-level `version`.
 * The runtime already used this default. Deploy records it too, so the
 * registry matches the version the running agent reports.
 */
export const MISSING_AGENT_VERSION = '1.0'

export interface AgentYamlVersion {
  /** Version text. `1.0` when `explicit` is false. */
  version: string
  /** False when the key is missing, null, or blank after trimming. */
  explicit: boolean
}

/**
 * Top-level `version` scalar, as text.
 *
 * The spelling comes from the YAML scalar itself, so `1.10` stays `1.10`
 * and `2.0` stays `2.0`. Block scalars keep the parser's text with
 * surrounding whitespace removed, which drops the trailing newline `|`,
 * `>`, and `|+` add. Anchors, aliases, and tags resolve before that
 * spelling is read. A later duplicate `version` key wins. A YAML null
 * (`null`, `~`, empty) is not a version.
 *
 * This is the same rule as `read_agent_yaml_version` in
 * `python/cast/agent/base.py`. The shared cases live in
 * `tests/fixtures/agent-yaml-version.json`.
 */
export function readAgentYamlVersion(text: string): AgentYamlVersion {
  const spelling = explicitVersionSpelling(text)
  if (spelling === null) return {version: MISSING_AGENT_VERSION, explicit: false}
  return {version: spelling, explicit: true}
}

function explicitVersionSpelling(text: string): string | null {
  const doc = parseDocument(text)
  const error = doc.errors.find(item => item.code !== 'DUPLICATE_KEY')
  if (error) {
    const pos = error instanceof YAMLParseError ? error.linePos?.[0] : undefined
    const line = pos ? quotedYamlLine(text, pos.line, pos.col) : undefined
    const location = typeof line === 'number' ? `agent.yaml:${line}` : 'agent.yaml'
    throw new AgentYamlError(`agent.yaml could not be parsed (${location}): ${error.message}`)
  }
  if (!isMap(doc.contents)) return null

  let saw = false
  let scalar: Scalar | null = null
  for (const item of doc.contents.items) {
    if (!isScalar(item.key) || item.key.value !== 'version') continue
    saw = true
    const resolved = isAlias(item.value) ? item.value.resolve(doc) : item.value
    scalar = isScalar(resolved) ? resolved : null
  }
  if (!saw || scalar === null) return null
  // A YAML null's source is the token `null` or `~`. That token is not
  // the version. A quoted "null" is a string and is kept.
  if (scalar.value === null || scalar.value === undefined) return null
  if (typeof scalar.source !== 'string') return null
  const trimmed = scalar.source.trim()
  return trimmed.length > 0 ? trimmed : null
}
