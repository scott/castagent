import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/**
 * Keys of the PROVIDERS object in deploy.ts. The landing page does not
 * list these itself; it renders whatever extract wrote to providers.json.
 */
function deployProviderKeys(): string[] {
  const source = read('typescript/cast-cli/src/commands/deploy.ts')
  const start = source.indexOf('const PROVIDERS')
  const end = source.indexOf('export default class Deploy')
  const block = source.slice(start, end)
  return [...block.matchAll(/^ {2}([a-z]+): \{$/gm)].map(match => match[1])
}

describe('landing page', () => {
  const index = read('docs-site/src/pages/index.astro')
  const landing = read('docs-site/src/layouts/Landing.astro')
  const overview = read('docs-site/src/pages/overview.astro')
  const sidebar = read('docs-site/src/components/Sidebar.astro')
  const installDoc = read('docs-site/content/getting-started/install.md')
  const providers = JSON.parse(read('docs-site/data/providers.json')) as Array<{
    key: string
    name: string
    description: string
  }>

  const installCommand = 'curl -sL https://raw.githubusercontent.com/scott/castagent/main/install.sh | bash'

  it('renders providers from data instead of a hardcoded list', () => {
    expect(index).to.include('getProviders()')
    expect(index).to.include('p.name')
    expect(index).to.include('p.key')
    expect(index).to.include('p.description')
    expect(index).to.not.include('Railway')
    expect(index).to.not.include('DigitalOcean')
    for (const provider of providers) {
      expect(provider.name.length).to.be.greaterThan(0)
      expect(provider.description.length).to.be.greaterThan(0)
    }
  })

  it('lists every deploy provider, including both DigitalOcean hosts', () => {
    const keys = providers.map(provider => provider.key).sort()
    expect(keys).to.deep.equal([...deployProviderKeys()].sort())
    expect(keys).to.include('digitalocean')
    expect(keys).to.include('microvm')
  })

  it('puts the install command, the repo, and the docs on the page', () => {
    expect(index).to.include(installCommand)
    expect(installDoc).to.include(installCommand)
    expect(index).to.include('getting-started/install')
    expect(index).to.include('Full install instructions')
    expect(index).to.include('Node.js 18+, Python 3.11+, and Bun.')
    expect(index).to.include('href="deployment/providers"')
    expect(landing).to.include('https://github.com/scott/castagent')
    expect(landing).to.include('href="overview"')
    expect(landing).to.not.include('Sidebar')
    expect(index).to.include("from '../layouts/Landing.astro'")
    expect(index).to.not.include('layouts/Docs.astro')
  })

  it('keeps the old homepage reachable as the docs overview', () => {
    expect(overview).to.include('What you can do with Cast')
    expect(overview).to.include('How Cast is organized')
    expect(overview).to.include('layouts/Docs.astro')
    expect(sidebar).to.include('href="overview"')
    expect(sidebar).to.not.match(/<a href="" class=\{isHome/)
  })
})
