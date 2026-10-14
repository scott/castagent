import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')

/**
 * Issue #119: `cast new` loads OpenTUI through Bun, and the bundle
 * imports `@opentui/core-${platform}-${arch}/index.ts`. Those packages
 * are optional dependencies of `@opentui/core`. npm only installs an
 * optional package when the lockfile has a matching `node_modules/`
 * entry, so a lockfile that records only the macOS arm64 binary leaves
 * Linux (and every other platform) without the native module.
 */
describe('OpenTUI platform packages in package-lock.json', () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, {
      version?: string
      optional?: boolean
      os?: string[]
      cpu?: string[]
      optionalDependencies?: Record<string, string>
    }>
  }

  const platformName = /^@opentui\/core-(darwin|linux|win32)-(arm64|x64)$/

  it('lists every @opentui/core platform build as an installable optional package', () => {
    const core = lock.packages['node_modules/@opentui/core']
    expect(core, '@opentui/core lock entry').to.exist
    const optional = core.optionalDependencies ?? {}
    const platforms = Object.keys(optional).filter((name) => platformName.test(name))
    expect(platforms).to.include('@opentui/core-linux-x64')
    expect(platforms).to.have.length(6)

    for (const name of platforms) {
      const match = platformName.exec(name)
      expect(match, name).to.not.equal(null)
      const osName = match![1]
      const cpuName = match![2]
      const entry = lock.packages[`node_modules/${name}`]
      expect(entry, `lockfile entry for ${name}`).to.exist
      expect(entry.optional, `${name} optional`).to.equal(true)
      expect(entry.version, `${name} version`).to.equal(optional[name])
      expect(entry.os, `${name} os`).to.deep.equal([osName])
      expect(entry.cpu, `${name} cpu`).to.deep.equal([cpuName])
    }
  })
})
