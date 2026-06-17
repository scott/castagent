#!/usr/bin/env tsx
/**
 * extract-cli.ts — parse every command file in typescript/cast-cli/src/commands/
 * and write data/cli.json.
 *
 * Strategy:
 *   - Walk the commands directory recursively.
 *   - For each .ts file, use ts-morph to find the default-exported class.
 *   - Pull `static description`, `static examples`, `static flags`, `static args`.
 *   - Derive the command path from the file location:
 *       src/commands/new.ts           -> "cast new"
 *       src/commands/git/init.ts      -> "cast git init"
 *       src/commands/meta/test.ts     -> "cast meta test"
 *
 * Why ts-morph: gives a typed AST and a forgiving parser that won't choke on
 * the few .ts files in commands/ that import side-effectful modules.
 */
import { Project, SyntaxKind, Node, type ClassDeclaration, type PropertyAssignment, type ObjectLiteralExpression, type CallExpression } from 'ts-morph'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const COMMANDS_DIR = join(REPO, 'typescript', 'cast-cli', 'src', 'commands')
const DATA = join(REPO, 'docs-site', 'data')

if (!existsSync(COMMANDS_DIR)) {
  console.error(`commands dir not found: ${COMMANDS_DIR}`)
  process.exit(1)
}

interface FlagSpec {
  name: string
  char?: string
  description?: string
  type: 'boolean' | 'string' | 'integer'
  required?: boolean
  default?: unknown
  multiple?: boolean
  options?: string[]
}

interface ArgSpec {
  name: string
  description?: string
  required?: boolean
  default?: string
}

interface CliCommand {
  id: string
  topic: string
  full: string
  description: string
  examples: string[]
  flags: FlagSpec[]
  args: ArgSpec[]
  source: string
}

// --- file walking ---

function readdirSafe(dir: string): any[] {
  try {
    return readdirSync(dir, { withFileTypes: true }) as any
  } catch {
    return []
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSafe(dir)) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full)
    }
  }
  return out
}

// --- AST helpers ---

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '')
}

function evalLiteral(node: any): unknown {
  if (!node) return undefined
  const text = node.getText()
  if (text === 'true')  return true
  if (text === 'false') return false
  if (text === 'null')  return null
  if (/^-?\d+$/.test(text)) return parseInt(text, 10)
  if (/^-?\d*\.\d+$/.test(text)) return parseFloat(text)
  if (/^['"`].*['"`]$/.test(text)) return text.slice(1, -1)
  return text
}

function readObjectProps(obj: ObjectLiteralExpression): PropertyAssignment[] {
  return obj.getProperties().filter((p): p is PropertyAssignment => Node.isPropertyAssignment(p))
}

// --- flag parsing ---

/**
 * Parse a single flag spec from either a CallExpression like
 *   Flags.string({ description: '...', char: 'f' })
 * or an object literal like
 *   { description: '...', char: 'f' }
 */
function parseFlagMeta(name: string, node: any): FlagSpec | null {
  let obj: ObjectLiteralExpression | undefined
  if (Node.isCallExpression(node)) {
    const args = node.getArguments()
    if (args.length === 0) return null
    const first = args[0]
    if (!Node.isObjectLiteralExpression(first)) return null
    obj = first
  } else if (Node.isObjectLiteralExpression(node)) {
    obj = node
  } else {
    return null
  }
  if (!obj) return null

  let description: string | undefined
  let char: string | undefined
  let required: boolean | undefined
  let defaultValue: unknown
  let multiple: boolean | undefined
  let options: string[] | undefined

  for (const prop of readObjectProps(obj)) {
    const pn = prop.getName()
    const init = prop.getInitializer()
    if (!init) continue
    switch (pn) {
      case 'description': description = unquote(init.getText()); break
      case 'char':        char        = unquote(init.getText()); break
      case 'required':    required    = init.getText() === 'true'; break
      case 'multiple':    multiple    = init.getText() === 'true'; break
      case 'default':     defaultValue = evalLiteral(init); break
      case 'options': {
        if (Node.isArrayLiteralExpression(init)) {
          options = init.getElements().map((e) => unquote(e.getText()))
        }
        break
      }
    }
  }

  // Determine type: the wrapping call is `Flags.string(...)` / `.integer(...)` / `.boolean(...)`.
  // When called as an object literal we infer from the name + default value.
  let type: FlagSpec['type']
  if (Node.isCallExpression(node)) {
    const expr = node.getExpression().getText()
    if (expr.endsWith('.integer'))       type = 'integer'
    else if (expr.endsWith('.boolean'))  type = 'boolean'
    else                                  type = 'string'
  } else {
    type = typeof defaultValue === 'number' ? 'integer' : 'string'
  }

  if (defaultValue === undefined) {
    if (type === 'boolean') defaultValue = false
    else if (type === 'integer' && name === 'port') defaultValue = 0
    else if (type === 'string'  && name === 'version') defaultValue = 'latest'
  }

  return { name, char, description, type, required, default: defaultValue, multiple, options }
}

/** Parse `static flags = { ... }` into FlagSpec[]. */
function parseFlagsObject(init: any): FlagSpec[] {
  if (!init || !Node.isObjectLiteralExpression(init)) return []
  const out: FlagSpec[] = []
  for (const prop of readObjectProps(init)) {
    const name = prop.getName()
    if (name === 'help' || name === 'parsed' || name === 'aliases' || name === 'dependsOn' || name === 'relationships' || name === 'deprecateAliases' || name === 'enableJsonFlag' || name === 'allowUnknownFlags') continue
    const val = prop.getInitializer()
    if (!val) continue
    const flag = parseFlagMeta(name, val)
    if (flag) out.push(flag)
  }
  return out
}

// --- arg parsing ---

function parseArgMeta(name: string, node: any): ArgSpec | null {
  if (!Node.isCallExpression(node)) return null
  const args = node.getArguments()
  if (args.length === 0) return { name }
  const first = args[0]
  if (!Node.isObjectLiteralExpression(first)) return { name }
  let description: string | undefined
  let required: boolean | undefined
  let def: string | undefined
  for (const prop of readObjectProps(first)) {
    const pn = prop.getName()
    const init = prop.getInitializer()
    if (!init) continue
    if (pn === 'description') description = unquote(init.getText())
    else if (pn === 'required') required = init.getText() === 'true'
    else if (pn === 'default')   def = unquote(init.getText())
  }
  return { name, description, required, default: def }
}

function parseArgsObject(init: any): ArgSpec[] {
  if (!init || !Node.isObjectLiteralExpression(init)) return []
  const out: ArgSpec[] = []
  for (const prop of readObjectProps(init)) {
    const name = prop.getName()
    const val = prop.getInitializer()
    if (!val) continue
    const a = parseArgMeta(name, val)
    if (a) out.push(a)
  }
  return out
}

// --- example parsing ---

function parseExamples(init: any, id: string): string[] {
  if (!init || !Node.isArrayLiteralExpression(init)) return []
  const out: string[] = []
  for (const el of init.getElements()) {
    const raw = unquote(el.getText())
    out.push(
      raw
        .replace(/<%=\s*config\.bin\s*%>/g, 'cast')
        .replace(/<%=\s*command\.id\s*%>/g, id),
    )
  }
  return out
}

// --- main ---

function derivePath(file: string): { id: string; topic: string; full: string } {
  const rel = relative(COMMANDS_DIR, file).replace(/\\/g, '/').replace(/\.ts$/, '')
  const segments = rel.split('/')
  const id = segments[segments.length - 1]
  const topic = segments.length > 1 ? segments.slice(0, -1).join(' ') : id
  return { id, topic, full: `cast ${segments.join(' ')}` }
}

const project = new Project({
  tsConfigFilePath: join(REPO, 'docs-site', 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
})

const files = walk(COMMANDS_DIR)
const commands: CliCommand[] = []

for (const file of files) {
  const sf = project.addSourceFileAtPath(file)
  const cls =
    sf.getDefaultExportSymbol()?.getDeclarations().find((d): d is ClassDeclaration => Node.isClassDeclaration(d)) ??
    sf.getClasses().find((c) => c.getStaticProperty('description'))

  if (!cls) {
    console.warn(`[skip] no exported class in ${relative(REPO, file)}`)
    project.removeSourceFile(sf)
    continue
  }

  const desc = unquote(cls.getStaticProperty('description')?.getInitializer()?.getText() ?? '')
  const exInit   = cls.getStaticProperty('examples')?.getInitializer()
  const flagsInit= cls.getStaticProperty('flags')?.getInitializer()
  const argsInit = cls.getStaticProperty('args')?.getInitializer()
  const path = derivePath(file)

  commands.push({
    id: path.id,
    topic: path.topic,
    full: path.full,
    description: desc,
    examples: parseExamples(exInit, path.id),
    flags: parseFlagsObject(flagsInit),
    args: parseArgsObject(argsInit),
    source: relative(REPO, file),
  })

  project.removeSourceFile(sf)
}

commands.sort((a, b) => a.full.localeCompare(b.full))

writeFileSync(join(DATA, 'cli.json'), JSON.stringify(commands, null, 2) + '\n')
console.log(`extracted ${commands.length} CLI commands -> data/cli.json`)
