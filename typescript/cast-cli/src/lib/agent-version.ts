import {isAlias, isMap, isScalar, type Document, type Scalar} from 'yaml'
import {parseAgentYamlDocument} from './agent-yaml'

/**
 * Version string both `cast deploy` and the Python runtime report when
 * agent.yaml has no usable top-level `version`.
 * The runtime already used this default. Deploy records it too, so the
 * registry matches the version the running agent reports.
 */
export const MISSING_AGENT_VERSION = '1.0'

/** YAML null tag. `!!null x` still carries source text, and that text is not a version. */
const NULL_TAG = 'tag:yaml.org,2002:null'

/**
 * MAJOR.MINOR or MAJOR.MINOR.PATCH.
 * The same rule as `validate_semver` in `python/cast/releases.py`.
 */
const SEMVER_LIKE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$|^(0|[1-9]\d*)\.(0|[1-9]\d*)$/

export function isSemverLike(version: string): boolean {
  return SEMVER_LIKE.test(version)
}

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
 * `>`, and `|+` add. A newline or space that remains inside the text is
 * kept. Anchors, aliases, and tags resolve before that spelling is read.
 * A later duplicate `version` key wins. A YAML null (`null`, `~`, empty,
 * or an explicit `!!null` tag) is not a version.
 *
 * This is the same rule as `read_agent_yaml_version` in
 * `python/cast/agent/base.py`. The shared cases live in
 * `tests/fixtures/agent-yaml-version.json`.
 */
export function readAgentYamlVersion(text: string): AgentYamlVersion {
  return versionFromAgentYamlDocument(parseAgentYamlDocument(text, 'agent.yaml'))
}

/** Version from a document `parseAgentYamlDocument` already accepted. */
export function versionFromAgentYamlDocument(doc: Document): AgentYamlVersion {
  const spelling = explicitVersionSpelling(doc)
  if (spelling === null) return {version: MISSING_AGENT_VERSION, explicit: false}
  return {version: spelling, explicit: true}
}

function explicitVersionSpelling(doc: Document): string | null {
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
  // A YAML null's source is the token `null`, `~`, or the text after
  // `!!null`. That token is not the version. A quoted "null" is a string
  // and is kept.
  if (scalar.tag === NULL_TAG || scalar.value === null || scalar.value === undefined) return null
  if (typeof scalar.source !== 'string') return null
  const trimmed = scalar.source.trim()
  return trimmed.length > 0 ? trimmed : null
}
