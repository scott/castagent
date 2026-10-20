import {spawn} from 'node:child_process'
import {assert} from '../lib/assert.mjs'
import {currentTokens, startProcSampler} from '../lib/harness.mjs'

export const shims = []

// This token is only declared here. Discovery has to merge `tokens` or the
// argv sampler will not see CAST_E2E_PROBE_TOKEN.
export const tokens = {
  CAST_E2E_PROBE_TOKEN: 'probe-secret-e2e-9f3a7c-not-a-real-token',
}

export const cases = [
  {
    id: 'token-probe.argv',
    provider: 'token-probe',
    name: 'argv',
    ownSampler: true,
    async run() {
      const tokens = currentTokens()
      assert(typeof tokens.CAST_E2E_PROBE_TOKEN === 'string', 'discovery did not merge token-probe tokens')
      const sampler = startProcSampler(tokens)
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)', tokens.CAST_E2E_PROBE_TOKEN], {
        stdio: 'ignore',
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      const hits = sampler.stop()
      child.kill('SIGKILL')
      const names = hits.map(hit => hit.name)
      assert(names.includes('CAST_E2E_PROBE_TOKEN'), `sampler missed probe token names: ${JSON.stringify(names)}`)
    },
  },
]
