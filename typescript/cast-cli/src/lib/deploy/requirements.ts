import {execSync} from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import YAML from 'yaml'

/**
 * Used when the project virtualenv cannot be frozen. The runtime imports
 * these libraries at process start. GitPython is appended later when the
 * frozen list and pyproject.toml both omit it.
 */
export const FALLBACK_REQUIREMENTS = `anyio>=4.13.0
certifi>=2026.4.22
charset-normalizer>=3.4.7
distro>=1.9.0
httpx>=0.28.1
idna>=3.13
jiter>=0.14.0
jsonpatch>=1.33
jsonpointer>=3.1.1
langchain>=1.2.15
langchain-core>=1.3.2
langchain-openai>=1.2.1
langgraph>=1.1.10
langgraph-checkpoint>=4.0.3
langgraph-prebuilt>=1.0.12
langgraph-sdk>=0.3.13
openai>=2.33.0
orjson>=3.11.8
packaging>=26.2
pydantic>=2.13.3
pydantic_core>=2.46.3
python-dotenv>=1.2.2
PyYAML>=6.0.1
regex>=2026.4.4
requests>=2.33.1
requests-toolbelt>=1.0.0
sniffio>=1.3.1
starlette>=1.0.0
tenacity>=9.1.4
tiktoken>=0.12.0
tqdm>=4.67.3
typing-inspection>=0.4.2
urllib3>=2.6.3
uvicorn>=0.46.0
xxhash>=3.7.0
`

/** The runtime imports GitPython before the server binds. 3.2.1 is outside every historical OSV range. */
export const GITPYTHON_REQUIREMENT = 'GitPython>=3.2.1'

/** PEP 503-style name so GitPython and gitpython compare as the same package. */
export function canonicalRequirementName(spec: string): string {
  const match = spec.trim().match(/^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/)
  if (!match) return ''
  return match[1].toLowerCase().replace(/[_.]+/g, '-')
}

function hasVersionSpecifier(spec: string): boolean {
  return /[=<>!~]/.test(spec) || /\s@\s/.test(spec)
}

export function filterRequirementLines(text: string): string[] {
  const lines: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const lower = trimmed.toLowerCase()
    if (/^cast\b/.test(lower) || lower.includes('castagent')) continue
    if (!canonicalRequirementName(trimmed)) continue
    lines.push(trimmed)
  }
  return lines
}

export function upsertRequirement(lines: string[], spec: string): void {
  const trimmed = spec.trim()
  const name = canonicalRequirementName(trimmed)
  if (!name || name === 'cast') return
  if (trimmed.toLowerCase().includes('castagent')) return
  const index = lines.findIndex(line => canonicalRequirementName(line) === name)
  if (index === -1) {
    lines.push(trimmed)
    return
  }
  if (!hasVersionSpecifier(lines[index]) && hasVersionSpecifier(trimmed)) {
    lines[index] = trimmed
  }
}

function extractTomlTable(source: string, name: string): string {
  const lines = source.split(/\r?\n/)
  const header = new RegExp(`^\\[${name}\\]\\s*(?:#.*)?$`)
  let inTable = false
  const collected: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (header.test(trimmed)) {
      inTable = true
      continue
    }
    if (inTable && /^\[[^\]]+\]/.test(trimmed)) break
    if (inTable) collected.push(line)
  }
  return collected.join('\n')
}

/** Dependencies declared on `[project]`, not optional extras. */
export function parsePyprojectDependencies(source: string): string[] {
  const project = extractTomlTable(source, 'project')
  const match = project.match(/dependencies\s*=\s*\[([\s\S]*?)\]/)
  if (!match) return []
  const deps: string[] = []
  const quoted = /"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g
  let found: RegExpExecArray | null
  while ((found = quoted.exec(match[1])) !== null) {
    const value = (found[1] ?? found[2] ?? '').replace(/\\"/g, '"').replace(/\\'/g, "'").trim()
    if (value) deps.push(value)
  }
  return deps
}

export function parseRuntimeRequirements(agentYaml: string): string[] {
  if (!agentYaml.trim()) return []
  let parsed: unknown
  try {
    parsed = YAML.parse(agentYaml)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const runtime = (parsed as {runtime?: {requirements?: unknown}}).runtime
  if (!runtime || !Array.isArray(runtime.requirements)) return []
  return runtime.requirements
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

export function renderRequirementsFile(input: {
  frozen: string
  pyprojectSource?: string
  agentYaml?: string
}): string {
  const frozen = input.frozen.trim()
  const lines = filterRequirementLines(frozen ? input.frozen : FALLBACK_REQUIREMENTS)
  const pyprojectDeps = input.pyprojectSource ? parsePyprojectDependencies(input.pyprojectSource) : []
  for (const dep of pyprojectDeps) upsertRequirement(lines, dep)
  for (const dep of parseRuntimeRequirements(input.agentYaml || '')) upsertRequirement(lines, dep)
  if (!lines.some(line => canonicalRequirementName(line) === 'gitpython')) {
    lines.push(GITPYTHON_REQUIREMENT)
  }
  return `${lines.join('\n')}\n`
}

export function readFrozenRequirements(projectRoot: string): string {
  const pipPath = path.join(projectRoot, 'python', '.venv', 'bin', 'pip')
  if (!fs.existsSync(pipPath)) return ''
  try {
    return execSync(`"${pipPath}" freeze`, {encoding: 'utf8'})
  } catch {
    return ''
  }
}

/** Write the image requirements for a Docker deploy or upgrade. Returns the file text. */
export function writeRequirementsTxt(projectRoot: string, agentPath: string): string {
  const pyprojectPath = path.join(projectRoot, 'python', 'pyproject.toml')
  const agentYamlPath = path.join(agentPath, 'agent.yaml')
  const text = renderRequirementsFile({
    frozen: readFrozenRequirements(projectRoot),
    pyprojectSource: fs.existsSync(pyprojectPath) ? fs.readFileSync(pyprojectPath, 'utf8') : '',
    agentYaml: fs.existsSync(agentYamlPath) ? fs.readFileSync(agentYamlPath, 'utf8') : '',
  })
  fs.writeFileSync(path.join(agentPath, 'requirements.txt'), text)
  return text
}
