import {execFileSync} from 'child_process'
import * as path from 'path'

describe('upgrade.sh', function () {
  this.timeout(120000)

  it('fast-forwards a checkout and rebuilds in place', () => {
    execFileSync('bash', [path.resolve(__dirname, '../../sh/upgrade.test.sh')], {
      stdio: 'inherit',
    })
  })
})
