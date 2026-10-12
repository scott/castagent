import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

/**
 * Built-in provider keys. The landing page does not list these itself;
 * it renders whatever extract wrote to providers.json from the manifest.
 */
function deployProviderKeys(): string[] {
  const manifest = JSON.parse(read('typescript/cast-cli/src/lib/deploy/providers.manifest.json')) as Array<{key: string}>
  return manifest.map(provider => provider.key)
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
    expect(index).to.not.include('--provider railway')
    expect(index).to.not.include('--provider microvm')
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

  it('repeats the README why-Cast points and agent examples', () => {
    const readme = read('README.md')
    expect(readme).to.include('# Cast Agent: Build and Deploy AI Agents')
    expect(readme).to.include('https://castagent.dev')
    expect(readme).to.include('Why Cast Agent?')
    expect(readme).to.not.include('Agent Cast')
    expect(index).to.include('Why Cast Agent?')
    expect(index).to.include('https://castagent.dev')
    expect(index).to.include('Interactive Builder')
    expect(index).to.include('Agent Memory')
    expect(index).to.include('What you can build')
    expect(index).to.include('Code review assistant')
    expect(index).to.include('Customer support agent')
    expect(index).to.include('Email assistant')
    expect(index).to.include('Slack bot')
    expect(index).to.include('agents/developer.svg')
    expect(index).to.include('agents/business.svg')
    expect(index).to.include('agents/productivity.svg')
    expect(index).to.include('agents/communications.svg')
    expect(index).to.include('cast new')
  })

  it('loops a cast-new exchange in the hero and keeps a still frame for reduced motion', () => {
    expect(index).to.include('class="landing-hero"')
    expect(index).to.include('[● LIVE]')
    expect(index).to.include('A code review assistant that comments on pull requests.')
    expect(index).to.include('Scaffolded review-bot with instructions, a pull-request tool, and a model.')
    expect(index).to.include("matchMedia('(prefers-reduced-motion: reduce)')")
    expect(index).to.include('async function play()')
    const css = read('docs-site/src/styles/global.css')
    expect(css).to.include('.landing-hero')
    expect(css).to.include('.tui-header')
    expect(css).to.include('.landing-top::before')
    expect(css).to.not.include('at 78% 92%')
    expect(index).to.include('slot="top"')
    expect(landing).to.include('class="landing-top"')
  })

  it('uses the same teal on the landing page and the docs', () => {
    const css = read('docs-site/src/styles/global.css')
    const mark = read('docs-site/public/mark.svg')
    const logo = read('docs-site/public/logo.svg')
    expect(css).to.match(/:root \{[^}]*--color-accent: #0f766e/)
    expect(css).to.match(/:root \{[^}]*--color-link: #2dd4bf/)
    expect(css).to.not.include('#6d28d9')
    expect(css).to.not.include('#a78bfa')
    expect(landing).to.include('mark.svg')
    expect(landing).to.include('Cast Agent')
    expect(landing).to.not.include('logo.svg')
    expect(landing).to.not.include('#6d28d9')
    expect(mark).to.include('#0f766e')
    expect(mark).to.not.include('#6d28d9')
    expect(logo).to.include('#0f766e')
    expect(logo).to.include('#14b8a6')
    expect(logo).to.not.include('#6d28d9')
    expect(index).to.not.include('#6d28d9')
  })

  it('keeps the old homepage reachable as the docs overview', () => {
    expect(overview).to.include('What you can do with Cast')
    expect(overview).to.include('How Cast is organized')
    expect(overview).to.include('layouts/Docs.astro')
    expect(sidebar).to.include('href="overview"')
    expect(sidebar).to.not.match(/<a href="" class=\{isHome/)
  })
})
