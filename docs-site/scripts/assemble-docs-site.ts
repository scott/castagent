/**
 * After the current site is built into dist/, copy retained docs snapshots
 * to dist/vX.Y.Z/ and write /versions.json plus /version-picker.js at the
 * site root. Does not unpack the version that is currently latest, and does
 * not rebuild old trees.
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  canonicalVersion,
  docsReleasesFromApi,
  retainedDocsReleases,
  unpackDocsArchive,
  versionsManifestFromReleases,
  type DocsReleaseAsset,
  type GitHubReleasePayload,
} from '../src/lib/docs-versions.ts'

const here = dirname(fileURLToPath(import.meta.url))
const DOCS = resolve(here, '..')
const REPO = resolve(DOCS, '..')
const DIST = join(DOCS, 'dist')

function packageVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { version: string }
  return canonicalVersion(pkg.version)
}

function loadReleases(): DocsReleaseAsset[] {
  if (process.env.DOCS_RELEASES_JSON) {
    return JSON.parse(process.env.DOCS_RELEASES_JSON) as DocsReleaseAsset[]
  }
  const repo = process.env.GITHUB_REPOSITORY
  const endpoint = repo
    ? `repos/${repo}/releases?per_page=100`
    : 'repos/{owner}/{repo}/releases?per_page=100'
  const result = spawnSync('gh', ['api', '--paginate', endpoint], { cwd: REPO, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`gh api releases failed: ${result.stderr || result.status}`)
  }
  return docsReleasesFromApi(JSON.parse(result.stdout) as GitHubReleasePayload[])
}

function download(tag: string, asset: string, dir: string): string {
  const result = spawnSync(
    'gh',
    ['release', 'download', tag, '--pattern', asset, '--dir', dir, '--clobber'],
    { cwd: REPO, encoding: 'utf8' },
  )
  if (result.status !== 0) {
    throw new Error(`gh release download ${tag} ${asset} failed: ${result.stderr || result.status}`)
  }
  return join(dir, asset)
}

function main(): void {
  const latest = packageVersion()
  const releases = loadReleases()
  const retained = retainedDocsReleases(latest, releases)
  const cache = mkdtempSync(join(tmpdir(), 'cast-docs-archives-'))
  for (const item of retained) {
    const archive = download(item.tag, item.asset, cache)
    unpackDocsArchive(archive, join(DIST, `v${item.version}`), item.version)
  }
  mkdirSync(DIST, { recursive: true })
  const manifest = versionsManifestFromReleases(latest, releases)
  writeFileSync(join(DIST, 'versions.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  copyFileSync(join(DOCS, 'public', 'version-picker.js'), join(DIST, 'version-picker.js'))
}

main()
