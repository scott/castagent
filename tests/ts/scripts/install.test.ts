import {execFileSync} from 'child_process'
import * as path from 'path'

describe('install.sh', function () {
  this.timeout(120000)

  it('bootstraps a piped install on Linux and macOS', () => {
    execFileSync('bash', [path.resolve(__dirname, '../../sh/install.test.sh')], {
      stdio: 'inherit',
    })
  })
})
