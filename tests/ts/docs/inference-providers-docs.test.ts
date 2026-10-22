import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/**
 * Issue #423: the docs site names each shipped inference provider and
 * does not present the reserved bedrock prefix as available.
 */
describe('inference provider docs', () => {
  const manifest = JSON.parse(read('python/cast/providers/manifest.json')) as Array<{
    key: string
    impl?: string
    prefixes?: string[]
    envVar?: string
    knownModels?: string[]
  }>
  const shipped = manifest.filter(row => row.impl !== 'reserved')
  const reserved = manifest.filter(row => row.impl === 'reserved')
  const catalog = read('docs-site/src/components/InferenceCatalog.astro')
  const page = read('docs-site/content/getting-started/inference-providers.mdx')
  const providerPage = read('docs-site/content/getting-started/provider.md')
  const install = read('docs-site/content/getting-started/install.md')
  const settings = read('docs-site/content/getting-started/global-settings.md')
  const builder = read('docs-site/content/building-agents/builder-model.md')
  const reference = read('docs-site/src/pages/cli/reference.astro')
  const slash = read('docs-site/src/pages/tui/slash-commands.astro')
  const hosts = read('docs-site/src/pages/deployment/providers.astro')
  const extract = read('docs-site/scripts/extract-providers.ts')
  const snapshot = read('docs-site/scripts/snapshot-manifest.ts')
  const docsManifest = JSON.parse(read('docs-site/data/manifest.json')) as {
    models: Array<{id: string; provider?: string; inferenceProvider?: string}>
  }

  it('renders the inference catalog from the python manifest', () => {
    expect(catalog).to.include('python/cast/providers/manifest.json')
    expect(catalog).to.include('vendor-prefixes.json')
    expect(page).to.include('InferenceCatalog')
    expect(page).to.include('bedrock/')
    expect(page).to.match(/not shipped/i)
    for (const row of shipped) {
      expect(catalog).to.include('row.key')
      expect(row.envVar, row.key).to.be.a('string')
    }
    expect(reserved.map(row => row.key)).to.include('bedrock')
    expect(catalog).to.include("impl === 'reserved'")
    expect(catalog).to.not.match(/sk-[A-Za-z0-9]{8,}/)
    expect(providerPage).to.not.match(/sk-[A-Za-z0-9]{8,}/)
  })

  it('gives cast provider a page that refs the CLI and slash commands', () => {
    expect(providerPage).to.match(/ref:\s*\[[^\]]*cli:provider/)
    expect(providerPage).to.match(/ref:\s*\[[^\]]*slash:provider/)
    expect(providerPage).to.include('{% ref "cli:provider" %}')
    expect(providerPage).to.include('{% ref "slash:provider" %}')
    expect(providerPage).to.include('--token -')
    expect(providerPage).to.include('--url')
    expect(providerPage).to.include('~/.cast/tokens/inference/<key>.token')
  })

  it('points install, settings, the builder, and the host page at the new pages', () => {
    for (const doc of [install, settings, builder]) {
      expect(doc).to.include('getting-started/inference-providers')
    }
    expect(install).to.include('getting-started/provider')
    expect(settings).to.include('getting-started/provider')
    expect(builder).to.include('openai-api/gpt-4o')
    expect(builder).to.include('xai/grok-4.7')
    expect(builder).to.include('ollama/qwen3')
    expect(slash).to.include('getting-started/provider')
    expect(slash).to.include('/provider')
    expect(slash).to.include('/model')
    expect(hosts).to.include('getting-started/inference-providers')
    expect(reference).to.not.include('KNOWN_MODELS')
    expect(reference).to.include('getModels')
    expect(reference).to.include('model.provider')
  })

  it('writes a provider field for each known model', () => {
    expect(extract).to.include('inferenceProvider: row.key')
    expect(snapshot).to.include('provider: m.provider')
    expect(snapshot).to.include('inferenceProvider: m.inferenceProvider')
    const known = manifest.flatMap(row => (row.knownModels ?? []).map(id => ({id, key: row.key})))
    const owner = new Map(known.map(item => [item.id, item.key]))
    expect(docsManifest.models.map(model => model.id).sort()).to.deep.equal(known.map(item => item.id).sort())
    for (const model of docsManifest.models) {
      const stripped = model.id.replace(/^openrouter\//, '')
      const slash = stripped.indexOf('/')
      const vendor = slash === -1 ? stripped : stripped.slice(0, slash)
      expect(model.provider, model.id).to.equal(vendor)
      expect(model.inferenceProvider, model.id).to.equal(owner.get(model.id))
    }
  })
})
