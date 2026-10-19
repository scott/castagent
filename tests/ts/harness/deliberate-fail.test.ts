import {expect} from 'chai'

/**
 * Temporary proof that Test & Coverage goes red when a test fails.
 * Reverted before the branch is finished. This file must not reach main.
 */
describe('deliberate CI failure', () => {
  it('fails on purpose so Test & Coverage must go red', () => {
    expect(false, 'deliberate failure to prove npm test status').to.equal(true)
  })
})
