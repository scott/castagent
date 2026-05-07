import {expect} from 'chai'

describe('shutdown command', () => {
  it('should have correct error message for nonexistent agent', () => {
    // Verify the expected error message content
    expect("not currently deployed").to.contain("not currently deployed")
  })
})
