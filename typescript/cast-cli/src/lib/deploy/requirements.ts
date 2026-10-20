import {execFileSync} from 'child_process'
import * as fs from 'fs'
import * as path from 'path'
import YAML from 'yaml'

/**
 * Used when the project virtualenv cannot be frozen.
 * Direct runtime minimums are declared in python/pyproject.toml.
 * renderRequirementsFile keeps the higher minimum when both name a package,
 * so a floor in this list cannot undercut that declaration.
 * GitPython is appended later when the frozen list and pyproject.toml both omit it.
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

/** Numeric lower bound from >=, ==, or ~=. A bare name has none. */
export function requirementLowerBound(spec: string): string | null {
  const match = spec.match(/(?:==|>=|~=)\s*v?(\d+(?:\.\d+)*)/)
  return match ? match[1] : null
}

/** Compare dotted numeric versions. 1.10 is greater than 1.9. Missing parts are 0. */
export function compareVersions(left: string, right: string): number {
  const parse = (version: string): number[] => version.split('.').map(part => {
    const match = /^(\d+)/.exec(part)
    return match ? Number(match[1]) : 0
  })
  const a = parse(left)
  const b = parse(right)
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
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
  const incoming = requirementLowerBound(trimmed)
  if (!incoming) return
  const current = requirementLowerBound(lines[index])
  if (!current || compareVersions(current, incoming) < 0) {
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
  // The pip script's shebang records the path where the virtualenv was
  // created. A renamed checkout still runs via `python -m pip` because
  // the interpreter is a symlink, not that script.
  const pythonPath = path.join(projectRoot, 'python', '.venv', 'bin', 'python')
  if (!fs.existsSync(pythonPath)) return ''
  try {
    return execFileSync(pythonPath, ['-m', 'pip', 'freeze'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    return ''
  }
}

const PYPROJECT_MARKER = path.join('python', 'pyproject.toml')

/** Checkout that contains python/pyproject.toml. cwd wins when it is that checkout. */
export function findRequirementsProjectRoot(): string {
  const candidates = [
    process.cwd(),
    path.resolve(__dirname, '../../..'),
    path.resolve(__dirname, '../../../..'),
    path.resolve(__dirname, '../../../../..'),
    path.resolve(__dirname, '../../../../../..'),
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, PYPROJECT_MARKER))) return candidate
  }
  return process.cwd()
}

/**
 * Write requirements.txt for a deployed agent.
 * python/pyproject.toml is the source of truth for runtime minimums.
 * Docker, Fly, Sprites, Droplets, MicroVMs, and Railway install this file.
 * cast deploy calls this before provider.deploy, so a new provider does too.
 */
export function stagePythonRequirements(agentPath: string, projectRoot = findRequirementsProjectRoot()): string {
  return writeRequirementsTxt(projectRoot, agentPath)
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
