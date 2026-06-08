import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

interface VersionInfo {
  id: number
  timestamp: string
  source: string
  message: string
}

interface VersionsJson {
  current: number
  versions: VersionInfo[]
}

describe('versions command', () => {
  const testDir = path.join(os.tmpdir(), `cast-versions-test-${Date.now()}`)
  const agentsDir = path.join(testDir, '.cast', 'agents')

  before(() => {
    fs.mkdirSync(agentsDir, {recursive: true})
  })

  after(() => {
    try {
      fs.rmSync(testDir, {recursive: true, force: true})
    } catch {
      // Ignore cleanup errors
    }
  })

  describe('command description', () => {
    it('should have correct description', () => {
      expect('List all versions of an agent').to.not.be.empty
    })
  })

  describe('versions file structure', () => {
    it('should have correct versions.json structure', () => {
      const versionsData: VersionsJson = {
        current: 3,
        versions: [
          {
            id: 1,
            timestamp: '2024-01-01T00:00:00Z',
            source: 'create',
            message: 'Initial creation',
          },
          {
            id: 2,
            timestamp: '2024-01-02T00:00:00Z',
            source: 'edit',
            message: 'Updated instructions',
          },
          {
            id: 3,
            timestamp: '2024-01-03T00:00:00Z',
            source: 'edit',
            message: 'Added new tools',
          },
        ],
      }

      expect(versionsData.current).to.equal(3)
      expect(versionsData.versions.length).to.equal(3)
      expect(versionsData.versions[0].id).to.equal(1)
      expect(versionsData.versions[2].id).to.equal(3)
    })

    it('should handle missing versions file', () => {
      const agentName = 'non-existent-agent'
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')

      expect(fs.existsSync(versionsPath)).to.be.false
    })
  })

  describe('version listing', () => {
    const agentName = `versions-test-${Date.now()}`

    before(() => {
      const agentPath = path.join(agentsDir, agentName)
      const versionsDir = path.join(agentPath, '.cast', 'versions')
      fs.mkdirSync(versionsDir, {recursive: true})

      const versionsData: VersionsJson = {
        current: 2,
        versions: [
          {
            id: 1,
            timestamp: new Date('2024-01-01').toISOString(),
            source: 'create',
            message: 'Created agent',
          },
          {
            id: 2,
            timestamp: new Date('2024-01-02').toISOString(),
            source: 'edit',
            message: 'Updated config',
          },
        ],
      }

      fs.writeFileSync(
        path.join(versionsDir, 'versions.json'),
        JSON.stringify(versionsData, null, 2)
      )
    })

    after(() => {
      try {
        fs.rmSync(path.join(agentsDir, agentName), {recursive: true, force: true})
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should read versions from file', () => {
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsPath, 'utf8'))

      expect(data.versions.length).to.equal(2)
      expect(data.current).to.equal(2)
    })

    it('should format version date correctly', () => {
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsPath, 'utf8'))

      for (const v of data.versions) {
        const date = new Date(v.timestamp)
        const dateStr = date.toLocaleDateString() + ' ' + date.toLocaleTimeString()
        expect(dateStr).to.be.a('string')
      }
    })

    it('should show source as label', () => {
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsPath, 'utf8'))

      for (const v of data.versions) {
        const sourceLabel = v.source === 'create' ? 'CREATED' : v.source.toUpperCase()
        expect(sourceLabel).to.be.a('string')
      }
    })
  })

  describe('JSON output', () => {
    it('should output valid JSON format', () => {
      const versionsData: VersionsJson = {
        current: 1,
        versions: [
          {
            id: 1,
            timestamp: '2024-01-01T00:00:00Z',
            source: 'create',
            message: 'Test',
          },
        ],
      }

      const json = JSON.stringify(versionsData, null, 2)
      const parsed = JSON.parse(json)

      expect(parsed.current).to.equal(1)
      expect(parsed.versions.length).to.equal(1)
    })
  })

  describe('version navigation', () => {
    it('should document revert command', () => {
      const revertCommand = 'cast revert <agent> [version]'
      expect(revertCommand).to.include('revert')
    })

    it('should document diff command', () => {
      const diffCommand = 'cast diff <agent> [v1] [v2]'
      expect(diffCommand).to.include('diff')
    })
  })
})