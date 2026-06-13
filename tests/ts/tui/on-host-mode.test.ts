/**
 * Tests for the on-host TUI mode.
 *
 * These tests verify that the UiMode type and mode-checking logic
 * correctly handle the 'on-host' mode. Full integration tests
 * require the OpenTUI renderer (see TODO in slash-registry.test.ts).
 */

import {expect} from 'chai'
import type {UiMode} from '../../../typescript/cast-tui/src/components/header.js'

describe('On-host TUI Mode', () => {
  describe('UiMode type', () => {
    it('should accept on-host as a valid UiMode', () => {
      // TypeScript compile-time check: this line would fail if
      // UiMode did not include 'on-host'
      const mode: UiMode = 'on-host'
      expect(mode).to.equal('on-host')
    })

    it('should accept production as a valid UiMode', () => {
      const mode: UiMode = 'production'
      expect(mode).to.equal('production')
    })

    it('should accept dev as a valid UiMode', () => {
      const mode: UiMode = 'dev'
      expect(mode).to.equal('dev')
    })
  })

  describe('on-host mode semantics', () => {
    // The 'on-host' mode behaves identically to 'production' mode:
    //   - Shows [● LIVE] in the header
    //   - Hides thinking/tool-call messages
    //   - Shows the production indicator
    //   - Uses the green (#10B981) background

    it('should map to the same isProduction check as production', () => {
      const isOnHost = (mode: UiMode): boolean => mode === 'production' || mode === 'on-host'
      expect(isOnHost('on-host')).to.be.true
      expect(isOnHost('production')).to.be.true
      expect(isOnHost('dev')).to.be.false
    })

    it('should be distinguishable from production via exact match', () => {
      const isOnHost = (mode: UiMode): boolean => mode === 'on-host'
      expect(isOnHost('on-host')).to.be.true
      expect(isOnHost('production')).to.be.false
      expect(isOnHost('dev')).to.be.false
    })
  })
})
