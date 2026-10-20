import {spawn} from 'node:child_process'
import {assert} from '../lib/assert.mjs'
import {currentTokens, startProcSampler} from '../lib/harness.mjs'

export const shims = []

export const tokens = {
  CAST_E2E_SAMPLER_TOKEN: 'sampler-secret-e2e-9f3a7c-not-a-real-token',
}

export const cases = [
  {
    id: 'sampler.self-check',
    provider: 'sampler',
    name: 'self-check',
    ownSampler: true,
    async run() {
      const tokens = currentTokens()
      assert(typeof tokens.CAST_E2E_SAMPLER_TOKEN === 'string', 'discovery did not merge sampler tokens')
      const sampler = startProcSampler(tokens)
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)', tokens.CAST_E2E_SAMPLER_TOKEN], {
        stdio: 'ignore',
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      const hits = sampler.stop()
      child.kill('SIGKILL')
      const names = hits.map(hit => hit.name)
      assert(names.includes('CAST_E2E_SAMPLER_TOKEN'), `sampler missed argv token names: ${JSON.stringify(names)}`)
      assert(!names.includes('FLY_API_TOKEN'), `sampler self-check borrowed another provider token: ${JSON.stringify(names)}`)
    },
  },
]
