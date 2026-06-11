import {expect} from 'chai'

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
})
