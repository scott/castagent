/**
 * Inject the version picker into an already-built docs tree and tar it.
 * Used for tags whose HTML has no picker. Omits CNAME from the archive.
 *
 *   tsx scripts/inject-snapshot.ts --dist <dir> --version 2.2.0 --archive out.tar.gz
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { injectPickerTree, packDocsDirectory } from '../src/lib/docs-versions.ts'

function arg(name: string): string {
  const index = process.argv.indexOf(name)
  const value = index >= 0 ? process.argv[index + 1] : ''
  if (!value) throw new Error(`missing ${name}`)
  return value
}

const dist = arg('--dist')
const version = arg('--version')
const archive = arg('--archive')
const cname = join(dist, 'CNAME')
if (existsSync(cname)) rmSync(cname)
injectPickerTree(dist, version)
packDocsDirectory(dist, archive)
console.log(`wrote ${archive}`)
