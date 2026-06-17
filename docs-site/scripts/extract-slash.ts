#!/usr/bin/env tsx
/**
 * extract-slash.ts — parse the TUI slash command registry and write data/slash.json.
 *
 * Source: typescript/cast-tui/src/commands/slash-registry.ts
 * Structure: `const commands: SlashCommand[] = [{ name, description, category, modes?, args?, handler }, ...]`
 *
 * We use ts-morph to find the `commands` array literal and walk its elements,
 * pulling name/description/category/modes/args. The handler is ignored.
 */
import { Project, SyntaxKind, Node, type ArrayLiteralExpression, type ObjectLiteralExpression, type PropertyAssignment } from 'ts-morph'
import { writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const SOURCE = join(REPO, 'typescript', 'cast-tui', 'src', 'commands', 'slash-registry.ts')
const DATA = join(REPO, 'docs-site', 'data')

if (!existsSync(SOURCE)) {
  console.error(`source not found: ${SOURCE}`)
  process.exit(1)
}

interface SlashCommand {
  name: string
  description: string
  category: 'chat' | 'agent' | 'session' | 'git'
  args?: string
  modes?: Array<'dev' | 'production' | 'on-host'>
  notes?: string
  source: string
}

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '')
}

const project = new Project({
  tsConfigFilePath: join(REPO, 'docs-site', 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
})
const sf = project.addSourceFileAtPath(SOURCE)

// Find `const commands: SlashCommand[] = [ ... ]`
let array: ArrayLiteralExpression | undefined
for (const stmt of sf.getVariableStatements()) {
  for (const decl of stmt.getDeclarations()) {
    if (decl.getName() === 'commands') {
      const init = decl.getInitializer()
      if (init && Node.isArrayLiteralExpression(init)) {
        array = init
      }
    }
  }
}
if (!array) {
  console.error(`could not find "const commands = [...]" in ${SOURCE}`)
  process.exit(1)
}

function readObject(obj: ObjectLiteralExpression): PropertyAssignment[] {
  return obj.getProperties().filter((p): p is PropertyAssignment => Node.isPropertyAssignment(p))
}

const commands: SlashCommand[] = []

for (const el of array.getElements()) {
  if (!Node.isObjectLiteralExpression(el)) continue
  const props = readObject(el)
  const cmd: Partial<SlashCommand> = {}
  for (const p of props) {
    const n = p.getName()
    const init = p.getInitializer()
    if (!init) continue
    switch (n) {
      case 'name':        cmd.name = unquote(init.getText()); break
      case 'description': cmd.description = unquote(init.getText()); break
      case 'category':    cmd.category = unquote(init.getText()) as SlashCommand['category']; break
      case 'args':        cmd.args = unquote(init.getText()); break
      case 'modes': {
        if (Node.isArrayLiteralExpression(init)) {
          cmd.modes = init.getElements().map((e) => unquote(e.getText())) as SlashCommand['modes']
        }
        break
      }
    }
  }
  if (!cmd.name || !cmd.description || !cmd.category) {
    console.warn(`[skip] incomplete slash command:`, cmd)
    continue
  }
  commands.push({
    name: cmd.name,
    description: cmd.description,
    category: cmd.category,
    args: cmd.args,
    modes: cmd.modes,
    source: relative(REPO, SOURCE),
  })
}

commands.sort((a, b) => a.name.localeCompare(b.name))

writeFileSync(join(DATA, 'slash.json'), JSON.stringify(commands, null, 2) + '\n')
console.log(`extracted ${commands.length} slash commands -> data/slash.json`)
