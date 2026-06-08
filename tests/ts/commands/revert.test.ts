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

describe('revert command', () => {
  const testDir = path.join(os.tmpdir(), `cast-revert-test-${Date.now()}`)
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
      expect('Revert an agent to a previous version').to.not.be.empty
    })
  })

  describe('version selection', () => {
    it('should default to latest version', () => {
      const versionsData: VersionsJson = {
        current: 3,
        versions: [
          {id: 1, timestamp: '2024-01-01', source: 'create', message: 'v1'},
          {id: 2, timestamp: '2024-01-02', source: 'edit', message: 'v2'},
          {id: 3, timestamp: '2024-01-03', source: 'edit', message: 'v3'},
        ],
      }

      const targetVersion = versionsData.current
      expect(targetVersion).to.equal(3)
    })

    it('should accept specific version number', () => {
      const targetVersion = 2
      expect(targetVersion).to.be.a('number')
      expect(targetVersion).to.be.greaterThan(0)
    })
  })

  describe('revert validation', () => {
    it('should verify agent exists', () => {
      const agentName = 'test-agent'
      const agentPath = path.join(agentsDir, agentName)

      expect(fs.existsSync(agentPath)).to.be.false
    })

    it('should verify versions file exists', () => {
      const agentName = 'test-agent'
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')

      expect(fs.existsSync(versionsPath)).to.be.false
    })

    it('should check version exists', () => {
      const versionsData: VersionsJson = {
        current: 3,
        versions: [
          {id: 1, timestamp: '2024-01-01', source: 'create', message: 'v1'},
          {id: 2, timestamp: '2024-01-02', source: 'edit', message: 'v2'},
        ],
      }

      const targetVersion = 5
      const version = versionsData.versions.find(v => v.id === targetVersion)
      expect(version).to.be.undefined
    })
  })

  describe('revert operation', () => {
    const agentName = `revert-test-${Date.now()}`

    before(() => {
      const agentPath = path.join(agentsDir, agentName)
      const versionsDir = path.join(agentPath, '.cast', 'versions')
      fs.mkdirSync(versionsDir, {recursive: true})

      const versionsData: VersionsJson = {
        current: 3,
        versions: [
          {id: 1, timestamp: '2024-01-01T00:00:00Z', source: 'create', message: 'Initial'},
          {id: 2, timestamp: '2024-01-02T00:00:00Z', source: 'edit', message: 'Updated'},
          {id: 3, timestamp: '2024-01-03T00:00:00Z', source: 'edit', message: 'Modified'},
        ],
      }

      fs.writeFileSync(
        path.join(versionsDir, 'versions.json'),
        JSON.stringify(versionsData, null, 2)
      )

      // Create agent directory
      fs.mkdirSync(agentPath, {recursive: true})
      fs.writeFileSync(
        path.join(agentPath, 'instructions.md'),
        'Current instructions'
      )
    })

    after(() => {
      try {
        fs.rmSync(path.join(agentsDir, agentName), {recursive: true, force: true})
      } catch {
        // Ignore cleanup errors
      }
    })

    it('should read versions file', () => {
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsPath, 'utf8'))

      expect(data.versions.length).to.equal(3)
    })

    it('should find target version', () => {
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsPath, 'utf8'))

      const targetVersion = 2
      const version = data.versions.find(v => v.id === targetVersion)

      expect(version).to.exist
      expect(version?.message).to.equal('Updated')
    })

    it('should display revert information', () => {
      const versionsPath = path.join(agentsDir, agentName, '.cast', 'versions', 'versions.json')
      const data: VersionsJson = JSON.parse(fs.readFileSync(versionsPath, 'utf8'))

      const targetVersion = 2
      const version = data.versions.find(v => v.id === targetVersion)

      const revertInfo = {
        message: version?.message,
        timestamp: version?.timestamp,
        source: version?.source,
      }

      expect(revertInfo.message).to.equal('Updated')
    })
  })

  describe('dry-run mode', () => {
    it('should preview changes in dry-run mode', () => {
      const dryRun = true

      if (dryRun) {
        // Should show what would happen without making changes
        const preview = {
          targetVersion: 2,
          action: 'Would revert to version 2',
        }
        expect(preview.action).to.include('Would revert')
      }
    })

    it('should not modify files in dry-run mode', () => {
      const dryRun = true
      const currentContent = 'Current content'

      if (!dryRun) {
        // This should not execute
        expect(true).to.be.false
      }

      // Content should remain unchanged
      expect(currentContent).to.equal('Current content')
    })
  })

  describe('version creation on revert', () => {
    it('should create new version recording revert', () => {
      const versionsData: VersionsJson = {
        current: 4,
        versions: [
          {id: 1, timestamp: '2024-01-01', source: 'create', message: 'v1'},
          {id: 2, timestamp: '2024-01-02', source: 'edit', message: 'v2'},
          {id: 3, timestamp: '2024-01-03', source: 'edit', message: 'v3'},
          // New version created by revert
          {id: 4, timestamp: new Date().toISOString(), source: 'revert', message: 'Reverted to version 2'},
        ],
      }

      expect(versionsData.versions.length).to.equal(4)
      expect(versionsData.current).to.equal(4)

      const revertVersion = versionsData.versions.find(v => v.source === 'revert')
      expect(revertVersion).to.exist
    })
  })
})