#!/usr/bin/env tsx
/**
 * extract-changelog.ts — parse the repo root CHANGELOG.md and write data/changelog.json.
 *
 * Recognises sections like:
 *   ## [1.1.0] - 2026-06-11
 *   ### Added
 *   - Bullet one
 *   - Bullet two
 *   ### Fixed
 *   - ...
 *
 * Each version produces an entry with grouped bullets.
 */
import matter from 'gray-matter'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(here, '..', '..')
const SOURCE = join(REPO, 'CHANGELOG.md')
const DATA = join(REPO, 'docs-site', 'data')

if (!existsSync(SOURCE)) {
  console.error(`CHANGELOG.md not found at ${SOURCE}`)
  process.exit(1)
}

interface ChangelogEntry {
  version: string
  date: string
  added: string[]
  fixed: string[]
  changed: string[]
  deprecated: string[]
  removed: string[]
  security: string[]
  documentation: string[]
  raw: string
  pr?: number
}

const raw = readFileSync(SOURCE, 'utf8')
const lines = raw.split('\n')

const SECTION_KEYS: Array<{ heading: string; key: keyof Omit<ChangelogEntry, 'version' | 'date' | 'raw' | 'pr'> }> = [
  { heading: 'Added',      key: 'added' },
  { heading: 'Fixed',      key: 'fixed' },
  { heading: 'Changed',    key: 'changed' },
  { heading: 'Deprecated', key: 'deprecated' },
  { heading: 'Removed',    key: 'removed' },
  { heading: 'Security',       key: 'security' },
  { heading: 'Documentation',  key: 'documentation' },
]

const entries: ChangelogEntry[] = []
let current: ChangelogEntry | null = null
let currentSection: keyof Omit<ChangelogEntry, 'version' | 'date' | 'raw' | 'pr'> | null = null
let currentRawLines: string[] = []

const versionRe = /^##\s+\[?([\d.]+)\]?\s*[-–—]\s*(\d{4}-\d{2}-\d{2})/
const sectionRe = /^###\s+(\w+)/
const bulletRe = /^\s*-\s+(.+)$/
const prRe = /\[#(\d+)\]/

function flush() {
  if (current) {
    current.raw = currentRawLines.join('\n').trim()
    const m = current.raw.match(prRe)
    if (m) current.pr = parseInt(m[1], 10)
    entries.push(current)
  }
  current = null
  currentSection = null
  currentRawLines = []
}

for (const line of lines) {
  const v = line.match(versionRe)
  if (v) {
    flush()
    current = {
      version: v[1],
      date: v[2],
      added: [], fixed: [], changed: [], deprecated: [], removed: [], security: [], documentation: [],
      raw: '',
    }
    currentSection = null
    currentRawLines = [line]
    continue
  }
  if (current) currentRawLines.push(line)
  if (!current) continue

  const s = line.match(sectionRe)
  if (s) {
    const matched = SECTION_KEYS.find((k) => k.heading.toLowerCase() === s[1].toLowerCase())
    currentSection = matched ? matched.key : null
    continue
  }
  const b = line.match(bulletRe)
  if (b && currentSection) {
    current[currentSection].push(b[1].trim())
  }
}
flush()

entries.sort((a, b) => b.date.localeCompare(a.date))

writeFileSync(join(DATA, 'changelog.json'), JSON.stringify(entries, null, 2) + '\n')
console.log(`extracted ${entries.length} changelog entries -> data/changelog.json`)
