import {expect} from 'chai'
import {spawnSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')

function writeExe(dir: string, name: string, body: string): void {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
}

/** Run scripts/run-tests.sh with stand-ins for nyc and npm. */
function runTestScript(nycExit: number, cleanExit: number): number {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-npm-test-'))
  try {
    writeExe(bin, 'nyc', `#!/bin/sh\nexit ${nycExit}\n`)
    writeExe(bin, 'npm', `#!/bin/sh\nexit ${cleanExit}\n`)
    const result = spawnSync('sh', ['scripts/run-tests.sh'], {
      cwd: repoRoot,
      env: {...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`},
      encoding: 'utf8',
      timeout: 15000,
    })
    expect(result.error, result.stderr || result.stdout).to.equal(undefined)
    expect(result.status, result.stderr || result.stdout).to.be.a('number')
    return result.status as number
  } finally {
    fs.rmSync(bin, {recursive: true, force: true})
  }
}

describe('npm test exit status', () => {
  it('does not chain cleanup with a semicolon', () => {
    const pkg = require('../../../package.json') as {scripts: Record<string, string>}
    expect(pkg.scripts.test).to.equal('sh scripts/run-tests.sh')
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script, name).to.not.match(/;\s*\S/)
    }
  })

  it('returns the suite status when cleanup succeeds', () => {
    expect(runTestScript(3, 0)).to.equal(3)
  })

  it('returns the cleanup status when the suite succeeded', () => {
    expect(runTestScript(0, 4)).to.equal(4)
  })

  it('keeps a failing suite status when cleanup also fails', () => {
    expect(runTestScript(5, 4)).to.equal(5)
  })

  it('returns 0 when the suite and cleanup both succeed', () => {
    expect(runTestScript(0, 0)).to.equal(0)
  })
})
