import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import {loadInferenceCatalog, type InferenceCatalogEntry} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {modelsForProvider} from '../../../typescript/cast-cli/src/lib/inference-provider'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response
}

describe('inference model listing', () => {
  const previousHome = process.env.HOME
  const previousDo = process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
  const previousFake = process.env.FAKEAI_API_KEY
  const catalog = loadInferenceCatalog()
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-inference-models-'))
    process.env.HOME = home
    delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    delete process.env.FAKEAI_API_KEY
  })

  afterEach(() => {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    if (previousDo === undefined) delete process.env.DIGITALOCEAN_MODEL_ACCESS_KEY
    else process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = previousDo
    if (previousFake === undefined) delete process.env.FAKEAI_API_KEY
    else process.env.FAKEAI_API_KEY = previousFake
    fs.rmSync(home, {recursive: true, force: true})
  })

  it('lists the curated OpenRouter catalog without a live fetch', async () => {
    const entry = catalog.find(item => item.key === 'openrouter')
    expect(entry).to.not.equal(undefined)
    let called = false
    const result = await modelsForProvider(entry!, {
      fetchImpl: async () => {
        called = true
        throw new Error('OpenRouter must not fetch /models')
      },
    })
    expect(called).to.equal(false)
    expect(result.providerKey).to.equal('openrouter')
    expect(result.fallback).to.equal(false)
    expect(result.models.map(model => model.id)).to.include('minimax/minimax-m2.5')
    expect(result.models.map(model => model.id)).to.include('anthropic/claude-sonnet-4.6')
  })

  it('lists DigitalOcean models from /models and prefixes them', async () => {
    const entry = catalog.find(item => item.key === 'digitalocean')
    expect(entry?.modelsPath).to.equal('/models')
    process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = 'do-list-key'
    const seen: {url: string; authorization?: string}[] = []
    const result = await modelsForProvider(entry!, {
      fetchImpl: async (url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>
        seen.push({url: String(url), authorization: headers.Authorization})
        return jsonResponse({
          data: [{id: 'llama3.3-70b-instruct'}, {id: 'deepseek-v3.2'}],
        })
      },
    })
    expect(seen).to.deep.equal([{
      url: 'https://inference.do-ai.run/v1/models',
      authorization: 'Bearer do-list-key',
    }])
    expect(result.fallback).to.equal(false)
    expect(result.models.map(model => model.id)).to.deep.equal([
      'digitalocean/llama3.3-70b-instruct',
      'digitalocean/deepseek-v3.2',
    ])
  })

  it('uses DigitalOcean fallback ids when the live list fails', async () => {
    const entry = catalog.find(item => item.key === 'digitalocean')
    process.env.DIGITALOCEAN_MODEL_ACCESS_KEY = 'do-list-key'
    const result = await modelsForProvider(entry!, {
      fetchImpl: async () => jsonResponse({}, 500),
    })
    expect(result.fallback).to.equal(true)
    expect(result.models.map(model => model.id)).to.deep.equal([
      'digitalocean/llama3.3-70b-instruct',
      'digitalocean/deepseek-v3.2',
    ])
  })

  it('filters, strips, and sends header templates for a shared-class row', async () => {
    const entry: InferenceCatalogEntry = {
      key: 'fakeai',
      name: 'Fake AI',
      default: false,
      prefixes: ['fakeai/'],
      envVar: 'FAKEAI_API_KEY',
      configKey: 'providers.fakeai.api_key',
      baseUrl: 'https://fakeai.example/v1',
      acceptsAnyModel: true,
      modelsPath: '/models',
      modelsFilter: '^chat-',
      modelsHeaders: {Authorization: 'Bearer ${token}', 'X-Region': 'sfo3'},
      stripModelIdPrefix: 'models/',
      fallbackModels: ['chat-small'],
    }
    process.env.FAKEAI_API_KEY = 'fake-list-key'
    const seen: {url: string; headers: Record<string, string>}[] = []
    const result = await modelsForProvider(entry, {
      fetchImpl: async (url, init) => {
        seen.push({url: String(url), headers: {...(init?.headers as Record<string, string>)}})
        return jsonResponse({
          data: [
            {id: 'models/chat-small'},
            {id: 'models/chat-large'},
            {id: 'models/embed-small'},
          ],
        })
      },
    })
    expect(seen[0].url).to.equal('https://fakeai.example/v1/models')
    expect(seen[0].headers.Authorization).to.equal('Bearer fake-list-key')
    expect(seen[0].headers['X-Region']).to.equal('sfo3')
    expect(result.models.map(model => model.id)).to.deep.equal([
      'fakeai/chat-small',
      'fakeai/chat-large',
    ])
  })

  it('lists curated models without a token when the row is keyless', async () => {
    const entry: InferenceCatalogEntry = {
      key: 'fakelocal',
      name: 'Fake Local',
      default: false,
      prefixes: ['fakelocal/'],
      envVar: '',
      configKey: '',
      baseUrl: 'http://127.0.0.1:11434/v1',
      acceptsAnyModel: true,
      keyless: true,
      curatedModels: true,
      fallbackModels: ['tiny'],
    }
    let called = false
    const result = await modelsForProvider(entry, {
      knownModels: {fakelocal: ['tiny', 'small']},
      fetchImpl: async () => {
        called = true
        throw new Error('curated models must not fetch')
      },
    })
    expect(called).to.equal(false)
    expect(result.models.map(model => model.id)).to.deep.equal([
      'fakelocal/tiny',
      'fakelocal/small',
    ])
  })
})
