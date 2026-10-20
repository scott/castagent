import {expect} from 'chai'
import {execFileSync, spawnSync} from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {pathToFileURL} from 'url'

const root = path.resolve(__dirname, '../../..')
const scriptUrl = pathToFileURL(path.join(root, 'scripts/compare-failures.mjs')).href

function classifyPytest(baseXml: string, headXml: string) {
  const source = `
    import {pytestRecordsFromXml, compareSets} from ${JSON.stringify(scriptUrl)}
    const base = pytestRecordsFromXml(process.env.BASE_XML).map(record => record.id)
    const head = pytestRecordsFromXml(process.env.HEAD_XML).map(record => record.id)
    process.stdout.write(JSON.stringify({base, head, compared: compareSets(base, head)}))
  `
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8',
    env: {...process.env, BASE_XML: baseXml, HEAD_XML: headXml},
  })
  return JSON.parse(stdout) as {
    base: string[]
    head: string[]
    compared: {newFailures: string[], alreadyFailing: string[]}
  }
}

describe('pytest failure ids', () => {
  it('reports a new failure beside an existing failure in the same class', () => {
    const baseXml = [
      '<testsuite>',
      '<testcase classname="pkg.TestBox" name="test_already"><failure message="old">boom</failure></testcase>',
      '<testcase classname="pkg.TestBox" name="test_fresh"></testcase>',
      '</testsuite>',
    ].join('')
    const headXml = [
      '<testsuite>',
      '<testcase classname="pkg.TestBox" name="test_already"><failure message="old">boom</failure></testcase>',
      '<testcase classname="pkg.TestBox" name="test_fresh"><failure message="new">boom</failure></testcase>',
      '</testsuite>',
    ].join('')
    const result = classifyPytest(baseXml, headXml)
    expect(result.head).to.deep.equal([
      'pytest:pkg.TestBox::test_already',
      'pytest:pkg.TestBox::test_fresh',
    ])
    expect(result.compared.newFailures).to.deep.equal(['pytest:pkg.TestBox::test_fresh'])
    expect(result.compared.alreadyFailing).to.deep.equal(['pytest:pkg.TestBox::test_already'])
  })

  it('reads name as its own attribute when the value contains an ampersand', () => {
    const xml = '<testcase classname="pkg.TestBox" name="a &amp; b"><failure message="x">nope</failure></testcase>'
    const result = classifyPytest('', xml)
    expect(result.head).to.deep.equal(['pytest:pkg.TestBox::a & b'])
  })
})

function writeSuite(dir: string, name: string, body: string) {
  fs.mkdirSync(dir, {recursive: true})
  fs.writeFileSync(path.join(dir, name), body)
}

function greenResults(dir: string) {
  writeSuite(dir, 'mocha.json', `${JSON.stringify({stats: {passes: 1, failures: 0, pending: 0}, failures: []})}\n`)
  writeSuite(dir, 'pytest.xml', '<testsuite tests="0"></testsuite>\n')
  writeSuite(dir, 'pytest-session.xml', '<testsuite tests="0"></testsuite>\n')
  writeSuite(dir, 'smoke-summary.json', `${JSON.stringify({ok: true, cases: []})}\n`)
  writeSuite(dir, 'snapshot-summary.json', `${JSON.stringify({ok: true, cases: []})}\n`)
}

function runCompare(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts/compare-failures.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {...process.env, ...env},
  })
}

describe('head artifacts', () => {
  it('rejects an empty or unparsable pytest.xml when artifacts are required', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-compare-head-'))
    const summary = path.join(dir, 'compare-summary.json')
    try {
      for (const body of ['', 'this is not junit']) {
        greenResults(dir)
        fs.writeFileSync(path.join(dir, 'pytest.xml'), body)
        fs.rmSync(summary, {force: true})
        const result = runCompare(['--head', dir, '--skip-base'], {
          COMPARE_REQUIRE_ARTIFACTS: '1',
          COMPARE_SUMMARY: summary,
        })
        expect(result.status, result.stderr).to.equal(1)
        expect(result.stderr).to.match(/unusable pytest\.xml/)
        expect(fs.existsSync(summary)).to.equal(false)
      }
      greenResults(dir)
      const ok = runCompare(['--head', dir, '--skip-base'], {
        COMPARE_REQUIRE_ARTIFACTS: '1',
        COMPARE_SUMMARY: summary,
      })
      expect(ok.status, ok.stderr).to.equal(0)
      expect(JSON.parse(fs.readFileSync(summary, 'utf8')).ok).to.equal(true)
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })

  it('does not call a suite deleted on the head fixed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-compare-deleted-'))
    const base = path.join(dir, 'base')
    const head = path.join(dir, 'head')
    const summary = path.join(dir, 'compare-summary.json')
    try {
      greenResults(base)
      greenResults(head)
      writeSuite(base, 'smoke-summary.json', `${JSON.stringify({
        ok: false,
        cases: [{id: 'sprites.deploy', status: 'fail'}],
      })}\n`)
      writeSuite(head, 'smoke-summary.json', `${JSON.stringify({ok: true, cases: [], absent: true})}\n`)
      const deleted = runCompare(['--base', base, '--head', head], {COMPARE_SUMMARY: summary})
      expect(deleted.status, deleted.stderr).to.equal(0)
      const deletedSummary = JSON.parse(fs.readFileSync(summary, 'utf8'))
      expect(deletedSummary.fixed).to.deep.equal([])
      expect(deletedSummary.newFailures).to.deep.equal([])

      writeSuite(head, 'smoke-summary.json', `${JSON.stringify({ok: true, cases: []})}\n`)
      const ran = runCompare(['--base', base, '--head', head], {COMPARE_SUMMARY: summary})
      expect(ran.status, ran.stderr).to.equal(0)
      expect(JSON.parse(fs.readFileSync(summary, 'utf8')).fixed).to.deep.equal(['smoke:sprites.deploy'])
    } finally {
      fs.rmSync(dir, {recursive: true, force: true})
    }
  })
})

describe('provider smoke selection', () => {
  it('combines --provider and --case with AND', () => {
    const list = (args: string[]) => execFileSync(process.execPath, ['tests/e2e/run.mjs', '--list', ...args], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    expect(list(['--provider', 'fly', '--case', 'fly.deploy'])).to.equal('fly.deploy')
    expect(list(['--provider', 'fly', '--case', 'sprites.rollback'])).to.equal('')
  })
})
