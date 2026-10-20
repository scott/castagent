import {expect} from 'chai'
import {execFileSync, spawn} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const root = path.resolve(__dirname, '../../..')
const bundle = path.join(root, 'typescript/cast-tui/dist/index.js')
const hidden = `${bundle}.e2e-hidden`

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function withBundle(fn: () => Promise<void>) {
  fs.mkdirSync(path.dirname(bundle), {recursive: true})
  const hadBundle = fs.existsSync(bundle)
  const original = hadBundle ? fs.readFileSync(bundle) : null
  const hadHidden = fs.existsSync(hidden)
  const hiddenOriginal = hadHidden ? fs.readFileSync(hidden) : null
  if (!hadBundle) fs.writeFileSync(bundle, '// e2e tui placeholder\n')
  try {
    await fn()
  } finally {
    if (fs.existsSync(hidden) && !fs.existsSync(bundle)) fs.renameSync(hidden, bundle)
    if (original) fs.writeFileSync(bundle, original)
    else if (!hadBundle) fs.rmSync(bundle, {force: true})
    if (hiddenOriginal) fs.writeFileSync(hidden, hiddenOriginal)
    else fs.rmSync(hidden, {force: true})
  }
}

describe('provider smoke TUI hide', () => {
  it('restores a leftover hidden bundle when the runner starts', async () => {
    await withBundle(async () => {
      const bytes = fs.readFileSync(bundle)
      fs.renameSync(bundle, hidden)
      expect(fs.existsSync(bundle)).to.equal(false)
      const stdout = execFileSync(process.execPath, ['tests/e2e/run.mjs', '--list'], {
        cwd: root,
        encoding: 'utf8',
      })
      expect(fs.existsSync(bundle)).to.equal(true)
      expect(fs.existsSync(hidden)).to.equal(false)
      expect(fs.readFileSync(bundle).equals(bytes)).to.equal(true)
      expect(stdout).to.include('sprites.deploy')
    })
  })

  it('restores the bundle when the runner is stopped with SIGINT', async () => {
    await withBundle(async () => {
      const bytes = fs.readFileSync(bundle)
      const summary = path.join(os.tmpdir(), `cast-e2e-sigint-${process.pid}.json`)
      const child = spawn(process.execPath, ['tests/e2e/run.mjs', '--case', 'sprites.deploy'], {
        cwd: root,
        env: {...process.env, SMOKE_SUMMARY: summary},
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', chunk => {
        stderr += chunk.toString()
      })
      try {
        const started = Date.now()
        while (!fs.existsSync(hidden)) {
          if (child.exitCode !== null || child.signalCode) {
            throw new Error(`runner exited before hiding the TUI\n${stdout}\n${stderr}`)
          }
          if (Date.now() - started > 20000) {
            throw new Error(`timed out waiting for the hidden TUI bundle\n${stdout}\n${stderr}`)
          }
          await sleep(30)
        }
        child.kill('SIGINT')
        const result = await new Promise<{code: number | null, signal: NodeJS.Signals | null}>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('runner ignored SIGINT')), 10000)
          child.on('close', (code, signal) => {
            clearTimeout(timer)
            resolve({code, signal})
          })
        })
        expect(fs.existsSync(bundle)).to.equal(true)
        expect(fs.existsSync(hidden)).to.equal(false)
        expect(fs.readFileSync(bundle).equals(bytes)).to.equal(true)
        expect(result.signal === 'SIGINT' || result.code === 130).to.equal(true)
      } finally {
        if (child.exitCode === null && !child.signalCode) child.kill('SIGKILL')
        fs.rmSync(summary, {force: true})
      }
    })
  })
})
