import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

describe('docs pagefind search', () => {
  const docs = read('docs-site/src/layouts/Docs.astro')
  const search = read('docs-site/src/components/Search.astro')
  const page = read('docs-site/src/pages/search.astro')
  const pkg = JSON.parse(read('docs-site/package.json'))
  const workflow = read('.github/workflows/docs.yml')

  it('mounts the search component from the docs layout', () => {
    expect(docs).to.include("components/Search.astro")
    expect(docs).to.match(/<Search\b/)
    expect(docs).to.include('data-pagefind-body')
    expect(search).to.include('PagefindUI')
    expect(search).to.include('data-docs-search')
  })

  it('has a dedicated search page', () => {
    expect(fs.existsSync(path.join(root, 'docs-site/src/pages/search.astro'))).to.equal(true)
    expect(page).to.include('layouts/Docs.astro')
    expect(page).to.include("components/Search.astro")
    expect(page).to.match(/<Search\b/)
  })

  it('runs pagefind as part of the docs build, before the pages artifact upload', () => {
    expect(pkg.scripts['build:search']).to.match(/pagefind\s+--site\s+dist\b/)
    expect(pkg.scripts.postbuild).to.include('build:search')
    expect(pkg.scripts.build).to.include('astro build')
    expect(pkg.devDependencies.pagefind).to.be.a('string')
    const buildAt = workflow.indexOf('npm --prefix docs-site run build')
    const uploadAt = workflow.indexOf('actions/upload-pages-artifact')
    expect(buildAt).to.be.greaterThan(-1)
    expect(uploadAt).to.be.greaterThan(buildAt)
  })

  it('points the pagefind bundle at the site base instead of a root-only path', () => {
    expect(search).to.include('import.meta.env.BASE_URL')
    expect(search).to.include('bundlePath')
    expect(search).to.include('baseUrl')
    expect(search).to.include('href="pagefind/pagefind-ui.css"')
    expect(search).to.include('src="pagefind/pagefind-ui.js"')
    expect(search).to.not.include('"/pagefind/')
    expect(search).to.not.include("'/pagefind/")
    expect(docs).to.not.include('"/pagefind/')
    expect(read('docs-site/src/pages/search.astro')).to.not.include('"/pagefind/')
  })
})
