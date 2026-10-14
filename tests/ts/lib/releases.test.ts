import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'

/**
 * Tests for typescript/cast-cli/src/lib/releases.ts (the TypeScript wrapper
 * that calls the Python releases module).
 *
 * Since the TS wrapper exec's out to python, we focus on validating the
 * exported function shapes, types, and that they exist. The actual logic
 * is tested in tests/python/unit/test_releases.py.
 */
describe('releases lib (TS wrapper)', () => {
  let releases: any

  before(() => {
    releases = require('../../../typescript/cast-cli/src/lib/releases')
  })

  describe('exports', () => {
    it('should export createRelease', () => {
      expect(typeof releases.createRelease).to.equal('function')
    })

    it('should export listReleases', () => {
      expect(typeof releases.listReleases).to.equal('function')
    })

    it('should export getRelease', () => {
      expect(typeof releases.getRelease).to.equal('function')
    })

    it('should export getCurrentRelease', () => {
      expect(typeof releases.getCurrentRelease).to.equal('function')
    })

    it('should export suggestVersion', () => {
      expect(typeof releases.suggestVersion).to.equal('function')
    })

    it('should export validateSemver', () => {
      expect(typeof releases.validateSemver).to.equal('function')
    })

    it('should export extractRelease', () => {
      expect(typeof releases.extractRelease).to.equal('function')
    })
  })

  describe('ReleaseInfo interface', () => {
    it('should define a ReleaseInfo type with expected fields', () => {
      // The interface is a TypeScript type so it gets erased at runtime.
      // We verify the function signatures accept objects that match it.
      expect(releases.createRelease.length).to.be.at.least(2)
      expect(releases.createRelease.length).to.be.at.most(3)
    })
  })

  describe('createRelease sqlite sync', () => {
    const agentName = `release-lib-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    const agentDir = path.join(os.homedir(), '.cast', 'agents', agentName)

    before(() => {
      fs.mkdirSync(agentDir, {recursive: true})
      fs.writeFileSync(path.join(agentDir, 'agent.yaml'), 'name: release-lib\nversion: "0.0"\n')
      fs.writeFileSync(path.join(agentDir, 'instructions.md'), '# release lib\n')
    })

    after(() => {
      try { db.deleteRelease(agentName, '1.5.0') } catch {}
      try { fs.rmSync(agentDir, {recursive: true, force: true}) } catch {}
    })

    it('writes SQLite when the lib createRelease call returns', async () => {
      const info = await releases.createRelease(agentName, '1.5.0', 'from tui path')
      const row = db.getRelease(agentName, '1.5.0')
      expect(row).to.exist
      expect(row.version).to.equal('1.5.0')
      expect(row.message).to.equal('from tui path')
      expect(row.tarball_path).to.equal(info.tarball_path)
      expect(row.change_number).to.equal(info.change_number)
      // Python stores fractional seconds. A later INSERT OR REPLACE would
      // reset created_at to SQLite's whole-second default.
      expect(String(row.created_at)).to.match(/\.\d{6}$/)

      const jsonCurrent = await releases.getCurrentRelease(agentName)
      expect(jsonCurrent).to.equal('1.5.0')
      expect(db.getCurrentRelease(agentName).version).to.equal('1.5.0')

      const manifest = JSON.parse(fs.readFileSync(
        path.join(agentDir, '.cast', 'releases', 'releases.json'),
        'utf-8',
      ))
      expect(manifest.current.version).to.equal('1.5.0')
      expect(manifest.releases[0].tarball_path).to.equal('.cast/releases/1.5.0.tar.gz')
      expect(path.isAbsolute(info.tarball_path)).to.equal(true)
      expect(fs.existsSync(info.tarball_path)).to.equal(true)
    })

    it('does not overwrite a SQLite row that is already stored', async () => {
      const Database = require('better-sqlite3')
      const raw = new Database(path.join(os.homedir(), '.cast', 'cast.db'))
      raw.prepare(
        `UPDATE releases SET message = ?, changelog = ? WHERE agent_name = ? AND version = ?`,
      ).run('keep-me', 'full-log', agentName, '1.5.0')
      raw.close()

      await releases.createRelease(agentName, '1.5.0', 'second')
      const row = db.getRelease(agentName, '1.5.0')
      expect(row.message).to.equal('keep-me')
      expect(row.changelog).to.equal('full-log')
    })
  })
})
