import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

import {
  filterInferenceEnv,
  loadInferenceCatalog,
} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {
  inferencePrefixError,
  matchingProvider,
} from '../../../typescript/cast-cli/src/lib/inference-routing'

interface RoutingCase {
  id: string
  provider: string | null
  model?: string
  temperature?: number | null
  error?: string
}

const CASES = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../fixtures/inference/routing-cases.json'),
  'utf8',
)) as RoutingCase[]

const OPENROUTER = 'sk-or-v1-secret-openrouter-key'
const DIGITALOCEAN = 'do-model-secret-key-0123456789'
const BOTH = {
  OPENROUTER_API_KEY: OPENROUTER,
  DIGITALOCEAN_MODEL_ACCESS_KEY: DIGITALOCEAN,
  OPENROUTER_BASE_URL: 'https://openrouter.example/v1',
  DIGITALOCEAN_INFERENCE_BASE_URL: 'https://inference.example/v1',
}

describe('shared inference routing cases', () => {
  const catalog = loadInferenceCatalog()

  for (const item of CASES) {
    it(item.id, () => {
      const error = inferencePrefixError(item.id, catalog)
      if (item.provider === null) {
        expect(error, item.id).to.be.a('string')
        expect(error, item.id).to.include(item.error || '')
        expect(filterInferenceEnv(item.id, BOTH, catalog)).to.deep.equal({})
        return
      }
      expect(error, item.id).to.equal(null)
      const matched = matchingProvider(item.id, catalog)?.key
      const provider = matched ?? catalog.find(entry => entry.default)?.key
      expect(provider, item.id).to.equal(item.provider)
      const envVar = item.provider === 'digitalocean'
        ? 'DIGITALOCEAN_MODEL_ACCESS_KEY'
        : 'OPENROUTER_API_KEY'
      const value = item.provider === 'digitalocean' ? DIGITALOCEAN : OPENROUTER
      const forwarded = filterInferenceEnv(item.id, BOTH, catalog)
      expect(forwarded, item.id).to.deep.equal({[envVar]: value})
      expect(JSON.stringify(forwarded)).to.not.include('BASE_URL')
    })
  }
})
