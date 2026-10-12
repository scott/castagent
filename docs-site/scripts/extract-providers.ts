#!/usr/bin/env tsx
/**
 * extract-providers.ts — parse deployment provider metadata and known models,
 * and write data/providers.json + data/models.json.
 *
 * Sources:
 *   - typescript/cast-cli/src/commands/deploy.ts   (`PROVIDERS` constant)
 *   - python/cast/providers/manifest.json          (`knownModels` on each row)
 *
 * We also detect which providers support `--with-tui` by reading the
 * `withTui` flag in the deploy command and finding where it is wired
 * into the provider switch (only DigitalOcean at the time of writing).
 */
import { Project, Node, type ObjectLiteralExpression, type PropertyAssignment } from 'ts-morph'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const DEPLOY_SRC = join(REPO, 'typescript', 'cast-cli', 'src', 'commands', 'deploy.ts')
const MANIFEST = join(REPO, 'python', 'cast', 'providers', 'manifest.json')
const DATA = join(REPO, 'docs-site', 'data')

if (!existsSync(DEPLOY_SRC) || !existsSync(MANIFEST)) {
  console.error(`source files not found`)
  process.exit(1)
}

interface ProviderInfo {
  key: string
  name: string
  description: string
  cliCommand: string
  cliInstallUrl: string
  authCommand?: string
  authEnvVar?: string
  supportsWithTui: boolean
}

interface ModelInfo {
  id: string
  provider: string
  family: string
}

function unquote(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '')
}

function readProps(obj: ObjectLiteralExpression): PropertyAssignment[] {
  return obj.getProperties().filter((p): p is PropertyAssignment => Node.isPropertyAssignment(p))
}

const project = new Project({
  tsConfigFilePath: join(REPO, 'docs-site', 'tsconfig.json'),
  skipAddingFilesFromTsConfig: true,
  skipFileDependencyResolution: true,
})

// --- providers ---

const deployFile = project.addSourceFileAtPath(DEPLOY_SRC)
let providersObj: ObjectLiteralExpression | undefined
for (const stmt of deployFile.getVariableStatements()) {
  for (const decl of stmt.getDeclarations()) {
    if (decl.getName() === 'PROVIDERS') {
      const init = decl.getInitializer()
      if (init && Node.isObjectLiteralExpression(init)) providersObj = init
    }
  }
}
if (!providersObj) {
  console.error('PROVIDERS constant not found in deploy.ts')
  process.exit(1)
}

// Detect supportsWithTui by scanning the `run()` body of the Deploy command for
// `doArgs = withTui ? [agentName, '--with-tui'] : [agentName]` patterns.
// At the time of writing only DigitalOcean accepts --with-tui.
function detectWithTuiSupport(): Set<string> {
  const out = new Set<string>()
  for (const cls of deployFile.getClasses()) {
    if (cls.getName() !== 'Deploy') continue
    for (const method of cls.getMethods()) {
      if (method.getName() !== 'run') continue
      const text = method.getBody()?.getText() ?? ''
      // Heuristic: any `case '<provider>':` that contains a `--with-tui` arg
      // inside its block is supported.
      const caseRe = /case\s+'([^']+)':\s*\{([\s\S]*?)\}/g
      let m: RegExpExecArray | null
      while ((m = caseRe.exec(text))) {
        const provider = m[1]
        const body = m[2]
        if (body.includes('--with-tui') || body.includes('with-tui')) {
          out.add(provider)
        }
      }
    }
  }
  return out
}
const withTuiSupported = detectWithTuiSupport()

const providers: ProviderInfo[] = []
for (const prop of readProps(providersObj)) {
  const key = prop.getName()
  const init = prop.getInitializer()
  if (!init || !Node.isObjectLiteralExpression(init)) continue
  let name = key
  let description = ''
  let cliCommand = ''
  let cliInstallUrl = ''
  let authCommand: string | undefined
  let authEnvVar: string | undefined
  for (const sub of readProps(init)) {
    const subInit = sub.getInitializer()
    if (!subInit) continue
    switch (sub.getName()) {
      case 'name':          name          = unquote(subInit.getText()); break
      case 'description':   description   = unquote(subInit.getText()); break
      case 'cliCommand':    cliCommand    = unquote(subInit.getText()); break
      case 'cliInstallUrl': cliInstallUrl = unquote(subInit.getText()); break
      case 'authCommand':   authCommand   = unquote(subInit.getText()); break
      case 'authEnvVar':    authEnvVar    = unquote(subInit.getText()); break
    }
  }
  providers.push({
    key,
    name,
    description,
    cliCommand,
    cliInstallUrl,
    authCommand,
    authEnvVar,
    supportsWithTui: withTuiSupported.has(key),
  })
}

providers.sort((a, b) => a.name.localeCompare(b.name))
writeFileSync(join(DATA, 'providers.json'), JSON.stringify(providers, null, 2) + '\n')
console.log(`extracted ${providers.length} providers -> data/providers.json`)

// --- models ---
// Built-in known ids only. External providers are not written into the docs site.

interface ManifestRow {
  key: string
  knownModels?: string[]
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) as ManifestRow[]
const models: ModelInfo[] = []
for (const row of manifest) {
  for (const raw of row.knownModels ?? []) {
    // Format is "openrouter/<provider>/<model>" or "kimi/k2.5" etc.
    // We normalise away the openrouter/ prefix and split on the first slash.
    const stripped = raw.replace(/^openrouter\//, '')
    const slash = stripped.indexOf('/')
    let provider: string
    let family: string
    if (slash === -1) {
      provider = stripped
      family = stripped
    } else {
      provider = stripped.slice(0, slash)
      family = stripped.slice(slash + 1)
    }
    models.push({ id: raw, provider, family })
  }
}
models.sort((a, b) => a.id.localeCompare(b.id))
writeFileSync(join(DATA, 'models.json'), JSON.stringify(models, null, 2) + '\n')
console.log(`extracted ${models.length} known models -> data/models.json`)
