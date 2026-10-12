/**
 * The TUI opens on the chat screen. The splash module is gone, and
 * docs no longer tell the user to dismiss a startup prompt.
 */

import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')
const tuiSrc = path.join(root, 'typescript/cast-tui/src')

function listSourceFiles(dir: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(full))
    } else if (/\.(ts|tsx|js|mjs|cjs|mts|cts)$/.test(entry.name)) {
      files.push(full)
    }
  }
  return files
}

function importsWelcomeSplash(source: string): boolean {
  const flat = source.replace(/\s+/g, ' ')
  const importsModule = /(?:from|require\(|import\()\s*['"][^'"]*screens\/welcome(?:\.js)?['"]/.test(flat)
  const importsSymbol = /\bimport\s+(?:type\s+)?(?:\{[^}]*\bshowWelcomeScreen\b[^}]*\}|\bshowWelcomeScreen\b)/.test(flat)
  return importsModule || importsSymbol
}

describe('no welcome splash screen', () => {
  it('removes typescript/cast-tui/src/screens/welcome.ts', () => {
    expect(fs.existsSync(path.join(tuiSrc, 'screens/welcome.ts'))).to.equal(false)
  })

  it('does not import screens/welcome or showWelcomeScreen', () => {
    const offenders = listSourceFiles(tuiSrc)
      .filter(file => importsWelcomeSplash(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(root, file))
    expect(offenders).to.deep.equal([])
  })

  it('still forwards options.welcome into showChatScreen', () => {
    const source = fs.readFileSync(path.join(tuiSrc, 'index.ts'), 'utf8')
    const match = source.match(/showChatScreen\(([^)]*)\)/)
    expect(match, 'showChatScreen(...) call').to.not.equal(null)
    expect(match![1]).to.include('options.welcome')
  })

  it('does not document the splash prompt', () => {
    const phrase = 'Press any key to start'
    for (const rel of [
      'docs-site/content/getting-started/quickstart.md',
      'docs/SPEC.md',
    ]) {
      expect(fs.readFileSync(path.join(root, rel), 'utf8'), rel).to.not.include(phrase)
    }
  })
})
