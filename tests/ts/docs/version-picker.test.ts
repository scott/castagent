import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

const root = path.resolve(__dirname, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function loadDocsVersions(): any {
  const file = path.resolve(root, 'docs-site/src/lib/docs-versions.ts')
  const source = fs.readFileSync(file, 'utf8')
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText
  const module = {exports: {} as any}
  const sandbox = {
    exports: module.exports,
    module,
    require,
    process,
    Buffer,
    console,
    __dirname: path.dirname(file),
    __filename: file,
  }
  vm.createContext(sandbox)
  vm.runInContext(js, sandbox)
  return module.exports
}

function loadPickerScript(): any {
  const source = read('docs-site/public/version-picker.js')
  const module = {exports: {} as any}
  const sandbox: any = {module, exports: module.exports, console}
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return module.exports
}

const lib = loadDocsVersions()
const picker = loadPickerScript()

function entry(version: string, latest = false) {
  return {
    version,
    label: `v${version}`,
    href: latest ? '/' : `/v${version}/`,
    latest,
  }
}

describe('docs version picker placement', () => {
  const sidebar = read('docs-site/src/components/Sidebar.astro')
  const landing = read('docs-site/src/layouts/Landing.astro')
  const docs = read('docs-site/src/layouts/Docs.astro')
  const component = read('docs-site/src/components/VersionPicker.astro')
  const css = read('docs-site/src/styles/global.css')
  const pickerCss = css.slice(css.indexOf('/* Version picker.'))

  function pickerFollowsAnchor(source: string, className: string): void {
    const classAt = source.indexOf(`class="${className}"`)
    expect(classAt, className).to.be.greaterThan(-1)
    const open = source.lastIndexOf('<a', classAt)
    const close = source.indexOf('</a>', classAt)
    const control = source.indexOf('<VersionPicker', classAt)
    expect(open).to.be.greaterThan(-1)
    expect(close).to.be.greaterThan(classAt)
    expect(control).to.be.greaterThan(close)
  }

  it('sits after the wordmark on docs pages and not inside the brand link', () => {
    expect(sidebar).to.include('class="brand-row"')
    expect(sidebar).to.include('Cast Agent')
    pickerFollowsAnchor(sidebar, 'brand')
    expect(docs).to.include('Sidebar')
    expect(docs).to.match(/<html[^>]*data-docs-version=/)
    const pages = [
      'docs-site/src/pages/404.astro',
      'docs-site/src/pages/overview.astro',
      'docs-site/src/pages/changelog.astro',
      'docs-site/src/pages/status.astro',
      'docs-site/src/pages/cli/reference.astro',
      'docs-site/src/pages/tui/slash-commands.astro',
      'docs-site/src/pages/deployment/providers.astro',
      'docs-site/src/pages/[...slug].astro',
      'docs-site/src/pages/versions.astro',
    ]
    for (const page of pages) {
      expect(read(page), page).to.include('layouts/Docs.astro')
    }
  })

  it('groups the control with the landing brand and leaves GitHub and Docs on the right', () => {
    expect(landing).to.include('class="landing-brand-group"')
    pickerFollowsAnchor(landing, 'landing-brand')
    const group = landing.indexOf('class="landing-brand-group"')
    const nav = landing.indexOf('class="landing-nav"')
    expect(nav).to.be.greaterThan(group)
    expect(landing).to.include('https://github.com/scott/castagent')
    expect(landing).to.include('href="overview"')
    expect(landing).to.match(/<html[^>]*data-docs-version=/)
    expect(landing).to.not.include('logo.svg')
  })

  it('labels the button with the version and loads the picker by an absolute path', () => {
    expect(component).to.include('v{docsVersion}')
    expect(component).to.include('version-picker-latest')
    expect(component).to.include('Latest')
    expect(component).to.include('src="/version-picker.js"')
    expect(component).to.not.include('src="version-picker.js"')
    expect(component).to.not.include('src="./version-picker.js"')
    expect(component).to.include('data-version-picker')
    expect(component).to.include('data-docs-version={docsVersion}')
    expect(read('docs-site/astro.config.mjs')).to.include('DOCS_VERSION')
    expect(read('docs-site/astro.config.mjs')).to.include("package.json")
    expect(read('docs-site/public/version-picker.js')).to.include("'/versions.json'")
    expect(read('docs-site/public/version-picker.js')).to.not.match(/fetch\(\s*['"]versions\.json['"]/)
  })

  it('keeps the logo row visible below 800px and uses the existing colors', () => {
    expect(css).to.not.include('.sidebar { display: none')
    expect(css).to.match(/@media \(max-width: 800px\) \{[\s\S]*\.sidebar nav \{ display: none/)
    expect(pickerCss).to.include('var(--font-mono)')
    expect(pickerCss).to.include('var(--color-fg)')
    expect(pickerCss).to.include('var(--color-border)')
    expect(pickerCss).to.include('var(--color-bg-elevated)')
    expect(pickerCss).to.include('var(--color-fg-muted)')
    expect(pickerCss).to.not.include('--color-accent')
    expect(pickerCss).to.not.include('--color-link')
    expect(pickerCss).to.not.match(/#[0-9a-fA-F]{3,8}/)
  })
})

describe('docs version path mapping', () => {
  const cases: Array<[string, string, string, string]> = [
    ['/overview', '/', '/v2.2.0/', '/v2.2.0/overview'],
    ['/v2.2.0/getting-started/install', '/v2.2.0/', '/', '/getting-started/install'],
    ['/v2.2.0/', '/v2.2.0/', '/', '/'],
    ['/v2.2.0', '/v2.2.0/', '/', '/'],
    ['/', '/', '/v2.2.0/', '/v2.2.0/'],
    ['/getting-started/install/', '/', '/v2.2.0/', '/v2.2.0/getting-started/install/'],
    ['/overview?x=1#y', '/', '/v2.2.0/', '/v2.2.0/overview?x=1#y'],
  ]

  for (const [current, from, to, expected] of cases) {
    it(`maps ${current} via ${from} → ${to}`, () => {
      expect(lib.mapDocsPath(current, from, to)).to.equal(expected)
      expect(picker.mapDocsPath(current, from, to)).to.equal(expected)
    })
  }
})

describe('docs version picker rows', () => {
  const versions = [
    entry('3.0.0', true),
    entry('2.6.0'),
    entry('2.5.0'),
    entry('2.4.0'),
    entry('2.3.0'),
    entry('2.2.0'),
    entry('2.1.0'),
  ]

  it('caps frozen releases at five and ends with Older versions', () => {
    for (const rowsOf of [lib.pickerRows, picker.pickerRows]) {
      const rows = rowsOf(versions)
      expect(rows.map((row: any) => row.kind === 'older' ? 'older' : row.entry.version)).to.deep.equal([
        '3.0.0', '2.6.0', '2.5.0', '2.4.0', '2.3.0', '2.2.0', 'older',
      ])
      expect(rows[rows.length - 1]).to.deep.equal({kind: 'older', href: '/versions'})
      expect(rowsOf(versions.slice(0, 6)).some((row: any) => row.kind === 'older')).to.equal(false)
    }
    expect(read('docs-site/public/version-picker.js')).to.include('Older versions')
    expect(read('docs-site/src/pages/versions.astro')).to.include('data-versions-index')
  })

  it('opens, moves, wraps, selects, and closes from the keyboard', () => {
    const closed = {open: false, index: 1, count: 3}
    for (const keyOf of [lib.pickerKey, picker.pickerKey]) {
      expect(keyOf(closed, 'Enter')).to.deep.equal({open: true, index: 1, action: 'open'})
      expect(keyOf(closed, ' ')).to.deep.equal({open: true, index: 1, action: 'open'})
      expect(keyOf({open: true, index: 1, count: 3}, ' ')).to.deep.equal({
        open: false, index: 1, action: 'close',
      })
      expect(keyOf({open: true, index: 1, count: 3}, 'Enter').action).to.equal('select')
      expect(keyOf({open: true, index: 1, count: 3}, 'Escape')).to.deep.equal({
        open: false, index: 1, action: 'close',
      })
      expect(keyOf(closed, 'Escape').action).to.equal('none')
      expect(keyOf({open: true, index: 2, count: 3}, 'ArrowDown').index).to.equal(0)
      expect(keyOf({open: true, index: 0, count: 3}, 'ArrowUp').index).to.equal(2)
    }
  })
})

describe('versions.json shape', () => {
  const releases = [
    {tag: 'cast-cli@2.3.0', isDraft: false, assetNames: ['cast-cli.tgz']},
    {tag: 'cast-tui@2.2.0', isDraft: false, assetNames: ['docs-v2.2.0.tar.gz']},
    {tag: 'v2.3.0', isDraft: false, assetNames: ['docs-v2.3.0.tar.gz']},
    {tag: 'v2.2.0', isDraft: false, assetNames: ['docs-v2.2.0.tar.gz']},
    {tag: 'v2.10.0', isDraft: false, assetNames: ['docs-v2.10.0.tar.gz']},
    {tag: 'v2.1.0', isDraft: false, assetNames: []},
    {tag: 'v1.1.0', isDraft: false, assetNames: []},
    {tag: 'v1.0.0', isDraft: false, assetNames: []},
    {tag: 'v0.1.0', isDraft: false, assetNames: []},
    {tag: 'v2.0.0', isDraft: true, assetNames: ['docs-v2.0.0.tar.gz']},
  ]

  it('lists latest first, then frozen releases newest first, and omits package tags', () => {
    expect(lib.versionsManifestFromReleases('2.3.0', [
      {tag: 'cast-cli@2.3.0', assetNames: []},
      {tag: 'cast-tui@2.3.0', assetNames: []},
      {tag: 'v2.3.0', assetNames: ['docs-v2.3.0.tar.gz']},
      {tag: 'v2.2.0', assetNames: ['docs-v2.2.0.tar.gz']},
      {tag: 'v1.1.0', assetNames: []},
      {tag: 'v1.0.0', assetNames: []},
      {tag: 'v0.1.0', assetNames: []},
    ])).to.deep.equal({
      latest: '2.3.0',
      versions: [
        {version: '2.3.0', label: 'v2.3.0', href: '/', latest: true},
        {version: '2.2.0', label: 'v2.2.0', href: '/v2.2.0/', latest: false},
      ],
    })
  })

  it('reads docs assets from the GitHub releases API', () => {
    const releases = lib.docsReleasesFromApi([
      { tag_name: 'cast-cli@2.3.0', draft: false, assets: [{ name: 'cli.tgz' }] },
      { tag_name: 'v2.3.0', draft: false, assets: [{ name: 'docs-v2.3.0.tar.gz' }] },
      { tag_name: 'v2.2.0', draft: false, assets: [{ name: 'docs-v2.2.0.tar.gz' }] },
    ])
    expect(lib.versionsManifestFromReleases('2.3.0', releases).versions.map((item: { version: string }) => item.version))
      .to.deep.equal(['2.3.0', '2.2.0'])
  })

  it('does not unpack the current latest and sorts newer frozen releases first', () => {
    const retained = lib.retainedDocsReleases('2.3.0', releases)
    expect(retained.map((item: {version: string}) => item.version)).to.deep.equal(['2.10.0', '2.2.0'])
    expect(retained.some((item: {tag: string}) => item.tag.includes('@'))).to.equal(false)
    const manifest = lib.versionsManifestFromReleases('v2.3.0', releases)
    expect(manifest.versions.map((item: {version: string}) => item.version)).to.deep.equal([
      '2.3.0', '2.10.0', '2.2.0',
    ])
    expect(manifest.versions[0].href).to.equal('/')
    expect(manifest.versions[0].latest).to.equal(true)
  })
})

describe('archived docs HTML', () => {
  const raw = [
    '<!DOCTYPE html><html lang="en"> <head><base href="/v2.2.0/"></head>',
    '<body><a href="" class="brand"> <span>Cast Agent</span> </a> <nav></nav></body></html>',
  ].join('')

  it('requests the picker and versions.json by absolute path and keeps its base href', () => {
    const html = lib.injectPicker(raw, '2.2.0')
    expect(html).to.include('<base href="/v2.2.0/">')
    expect(html).to.include('src="/version-picker.js"')
    expect(html).to.not.include('src="version-picker.js"')
    expect(html).to.include('data-version-picker')
    expect(html).to.include('data-docs-version="2.2.0"')
    expect(html.indexOf('data-version-picker')).to.be.greaterThan(html.indexOf('class="brand"'))
    expect(html.indexOf('data-version-picker')).to.be.greaterThan(html.indexOf('</a>'))
    expect(lib.injectPicker(html, '2.2.0')).to.equal(html)
    expect(read('docs-site/public/version-picker.js')).to.include("'/versions.json'")
  })

  it('injects next to the landing brand and leaves files with neither brand alone', () => {
    const landing = '<html lang="en"><header class="landing-header"> <a class="landing-brand" href=""><span>Cast Agent</span></a> <nav class="landing-nav">'
    const injected = lib.injectPicker(landing, 'v2.2.0')
    expect(injected).to.include('src="/version-picker.js"')
    expect(injected).to.include('class="landing-brand-group"')
    expect(injected.indexOf('data-version-picker')).to.be.greaterThan(injected.indexOf('</a>'))
    const nav = injected.indexOf('landing-nav')
    const groupClose = injected.indexOf('</div>', injected.indexOf('version-picker.js'))
    expect(nav).to.be.greaterThan(groupClose)
    const docs = lib.injectPicker(raw, '2.2.0')
    expect(docs).to.include('class="brand-row"')
    expect(docs).to.include('display:flex')
    const plain = '<html><p>no brand</p></html>'
    expect(lib.injectPicker(plain, '2.2.0')).to.equal(plain)
  })
})

describe('docs snapshot unpack', () => {
  const dirs: string[] = []

  after(() => {
    for (const dir of dirs) fs.rmSync(dir, {recursive: true, force: true})
  })

  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-docs-ver-'))
    dirs.push(dir)
    return dir
  }

  function writeTree(dir: string, html: string): void {
    fs.mkdirSync(path.join(dir, 'overview'), {recursive: true})
    fs.writeFileSync(path.join(dir, 'overview', 'index.html'), html)
    fs.writeFileSync(path.join(dir, 'asset.txt'), 'frozen-bytes')
    fs.writeFileSync(path.join(dir, 'plain.html'), '<html><p>no brand</p></html>')
  }

  function files(dir: string): string[] {
    const out: string[] = []
    for (const name of fs.readdirSync(dir)) {
      if (name === '.DS_Store' || name.startsWith('._')) continue
      const file = path.join(dir, name)
      if (fs.statSync(file).isDirectory()) out.push(...files(file))
      else out.push(file)
    }
    return out.sort()
  }

  it('changes a raw archive only by injecting the picker and dropping CNAME', () => {
    const raw = '<html lang="en"><head><base href="/v2.2.0/"></head><body><a href="" class="brand"><span>Cast Agent</span></a></body></html>'
    const src = tempDir()
    writeTree(src, raw)
    fs.writeFileSync(path.join(src, 'CNAME'), 'castagent.dev\n')
    const archive = path.join(tempDir(), 'docs-v2.2.0.tar.gz')
    lib.packDocsDirectory(src, archive)
    const dest = tempDir()
    lib.unpackDocsArchive(archive, dest, '2.2.0')
    expect(fs.existsSync(path.join(dest, 'CNAME'))).to.equal(false)
    expect(fs.readFileSync(path.join(dest, 'overview', 'index.html'), 'utf8')).to.equal(lib.injectPicker(raw, '2.2.0'))
    expect(fs.readFileSync(path.join(dest, 'asset.txt'), 'utf8')).to.equal('frozen-bytes')
    expect(fs.readFileSync(path.join(dest, 'plain.html'), 'utf8')).to.equal('<html><p>no brand</p></html>')
    expect(fs.readFileSync(path.join(dest, 'overview', 'index.html'), 'utf8')).to.include('<base href="/v2.2.0/">')
  })

  it('unpacks an already injected archive byte-for-byte, including a second unpack', () => {
    const raw = '<html lang="en"><head><base href="/v2.2.0/"></head><body><a class="landing-brand" href=""><span>Cast Agent</span></a></body></html>'
    const injected = lib.injectPicker(raw, '2.2.0')
    const src = tempDir()
    writeTree(src, injected)
    const archive = path.join(tempDir(), 'docs-v2.2.0.tar.gz')
    lib.packDocsDirectory(src, archive)
    const once = tempDir()
    const twice = tempDir()
    lib.unpackDocsArchive(archive, once, '2.2.0')
    lib.unpackDocsArchive(archive, twice, '2.2.0')
    const onceFiles = files(once)
    const twiceFiles = files(twice)
    expect(onceFiles.map(file => path.relative(once, file))).to.deep.equal(
      twiceFiles.map(file => path.relative(twice, file)),
    )
    for (const file of onceFiles) {
      const rel = path.relative(once, file)
      expect(fs.readFileSync(file)).to.deep.equal(fs.readFileSync(path.join(twice, rel)))
      expect(fs.readFileSync(file)).to.deep.equal(fs.readFileSync(path.join(src, rel)))
    }
  })
})

describe('docs version workflows', () => {
  const docs = read('.github/workflows/docs.yml')
  const snapshot = read('.github/workflows/docs-snapshot.yml')

  it('deploys current docs and unpacks retained snapshots without rebuilding them', () => {
    expect(docs).to.include('scripts/assemble-docs-site.ts')
    expect(docs).to.include('contents: read')
    expect(read('docs-site/scripts/assemble-docs-site.ts')).to.include('retainedDocsReleases')
    expect(read('docs-site/scripts/assemble-docs-site.ts')).to.include('unpackDocsArchive')
    expect(read('docs-site/scripts/assemble-docs-site.ts')).to.not.include('astro build')
    expect(docs).to.include('PUBLIC_SITE_BASE: /')
  })

  it('builds a product release snapshot and uploads it without CNAME', () => {
    expect(snapshot).to.include('contents: write')
    expect(snapshot).to.include('types: [published]')
    expect(snapshot).to.include('PUBLIC_SITE_URL=https://castagent.dev')
    expect(snapshot).to.include('PUBLIC_SITE_BASE="/${TAG}/"')
    expect(snapshot).to.include('DOCS_VERSION="$VERSION"')
    expect(snapshot).to.include('rm -f docs-site/dist/CNAME')
    expect(snapshot).to.include('gh release upload')
    expect(snapshot).to.include('docs-${TAG}.tar.gz')
    expect(snapshot).to.match(/\^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$/)
  })

  it('documents the version paths in the docs-site readme', () => {
    const readme = read('docs-site/README.md')
    expect(readme).to.include('`/` is the current docs')
    expect(readme).to.include('`/vX.Y.Z/` is a frozen snapshot')
    expect(readme).to.include('/versions.json')
    expect(readme).to.include('/version-picker.js')
    expect(readme).to.include('CNAME')
  })
})
