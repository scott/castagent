import {expect, test} from '@oclif/test'

describe('shutdown', () => {
  test
    .stdout()
    .command(['shutdown', 'nonexistent-agent'])
    .it('warns when agent is not deployed', (ctx) => {
      expect(ctx.stdout).to.contain("not currently deployed")
    })
})
