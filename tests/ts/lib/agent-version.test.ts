import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import {MISSING_AGENT_VERSION, readAgentYamlVersion} from '../../../typescript/cast-cli/src/lib/agent-version'

interface VersionCase {
  name: string
  yaml: string
  expected: string
  explicit: boolean
}

interface VersionTable {
  missingVersion: string
  cases: VersionCase[]
}

const tablePath = path.join(__dirname, '../../fixtures/agent-yaml-version.json')
const table = JSON.parse(fs.readFileSync(tablePath, 'utf8')) as VersionTable

describe('agent.yaml version', () => {
  it('uses the shared missing-version string', () => {
    expect(MISSING_AGENT_VERSION).to.equal(table.missingVersion)
    expect(table.cases.length).to.be.greaterThan(0)
  })

  for (const item of table.cases) {
    it(`${item.name} is ${JSON.stringify(item.expected)}`, () => {
      const parsed = readAgentYamlVersion(item.yaml)
      expect(parsed.version, item.name).to.equal(item.expected)
      expect(parsed.explicit, item.name).to.equal(item.explicit)
      expect(parsed.version).to.be.a('string')
    })
  }
})
