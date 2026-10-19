#!/usr/bin/env node
/**
 * Write docs-site/data/providers.json when docs-site's tsx is not installed.
 *
 * landing-page.test.ts reads that file while mocha is loading tests. The
 * file is generated and gitignored, so a clean checkout aborts the whole
 * run with ENOENT before any test executes. This fallback matches
 * docs-site/scripts/extract-providers.ts. When tsx is installed, the test
 * runner uses that script instead.
 */

'use strict'

const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const manifestPath = path.join(root, 'typescript/cast-cli/src/lib/deploy/providers.manifest.json')
const inferencePath = path.join(root, 'python/cast/providers/manifest.json')
const dataDir = path.join(root, 'docs-site/data')

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const providers = manifest.map(entry => {
  const info = {
    key: entry.key,
    name: entry.name,
    description: entry.description,
    cliCommand: entry.cliCommand,
    cliInstallUrl: entry.cliInstallUrl,
    supportsWithTui: entry.supportsWithTui === true,
  }
  if (entry.authCommand) info.authCommand = entry.authCommand
  if (entry.authEnvVar) info.authEnvVar = entry.authEnvVar
  return info
})
providers.sort((a, b) => a.name.localeCompare(b.name))

fs.mkdirSync(dataDir, {recursive: true})
fs.writeFileSync(path.join(dataDir, 'providers.json'), JSON.stringify(providers, null, 2) + '\n')
console.log(`extracted ${providers.length} providers -> data/providers.json`)

const inferenceManifest = JSON.parse(fs.readFileSync(inferencePath, 'utf8'))
const models = []
for (const row of inferenceManifest) {
  for (const raw of row.knownModels ?? []) {
    const stripped = raw.replace(/^openrouter\//, '')
    const slash = stripped.indexOf('/')
    const provider = slash === -1 ? stripped : stripped.slice(0, slash)
    const family = slash === -1 ? stripped : stripped.slice(slash + 1)
    models.push({id: raw, provider, family})
  }
}
models.sort((a, b) => a.id.localeCompare(b.id))
fs.writeFileSync(path.join(dataDir, 'models.json'), JSON.stringify(models, null, 2) + '\n')
console.log(`extracted ${models.length} known models -> data/models.json`)
