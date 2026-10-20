import {expect} from 'chai'
import {execFileSync} from 'child_process'
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
