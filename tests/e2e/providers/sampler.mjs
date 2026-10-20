import {spawn} from 'node:child_process'
import {assert} from '../lib/assert.mjs'
import {TOKENS, startProcSampler} from '../lib/harness.mjs'

export const shims = []

export const cases = [
  {
    id: 'sampler.self-check',
    provider: 'sampler',
    name: 'self-check',
    ownSampler: true,
    async run() {
      const sampler = startProcSampler()
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)', TOKENS.FLY_API_TOKEN], {
        stdio: 'ignore',
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      const hits = sampler.stop()
      child.kill('SIGKILL')
      assert(hits.some(hit => hit.name === 'FLY_API_TOKEN' && hit.source === 'proc'), `sampler missed argv token: ${JSON.stringify(hits)}`)
    },
  },
]
