import {expect} from 'chai'
import * as http from 'http'
import {db} from '../../../typescript/cast-cli/src/lib/sqlite'
import {keychain} from '../../../typescript/cast-cli/src/lib/keychain'
import {resolveDeploymentAuthToken} from '../../../typescript/cast-cli/src/lib/deploy/deploy-utils'
import {microvmProvider} from '../../../typescript/cast-cli/src/lib/deploy/providers/microvm'
import {A2AClient} from '../../../typescript/cast-cli/dist/lib/a2a/client'
import {
  CastbotImportError,
  castbotLifecycleMessage,
  importCastbotBlob,
  removeCastbotImport,
} from '../../../typescript/cast-cli/src/lib/castbot-import'

const TOKEN = 'test-cli-token'
const AGENT_ID = 'agent-id-1'

function blob(overrides: Record<string, string> = {}): string {
  return JSON.stringify({
    name: overrides.name || 'placeholder',
    agent_id: overrides.agent_id || AGENT_ID,
    url: overrides.url || 'https://demo.microvm.ondigitalocean.com',
    provider: overrides.provider || 'microvm',
    token: overrides.token || TOKEN,
  })
}

function agentName(): string {
  return `castbot-import-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

describe('castbot import', () => {
  const names: string[] = []

  afterEach(() => {
    for (const name of names.splice(0)) {
      try { db.deleteAgent(name) } catch {}
    }
  })

  it('writes a hash, a managed row, and the token', async () => {
    const name = agentName()
    names.push(name)
    const saved = await importCastbotBlob(blob({name}))
    expect(saved.id).to.match(/^[a-f0-9]{6}$/)
    const row = db.getDeploymentBySha(saved.id)
    expect(row.agent_name).to.equal(name)
    expect(row.provider).to.equal('microvm')
    expect(row.deployment_url).to.equal('https://demo.microvm.ondigitalocean.com')
    expect(row.auth_token_hash).to.equal(keychain.hashToken(TOKEN))
    expect(row.auth_token_hash).to.not.equal(TOKEN)
    expect(JSON.stringify(row)).to.not.include(TOKEN)
    expect(row.managed_by).to.equal('castbot')
    const volume = JSON.parse(row.volume_config)
    expect(volume).to.deep.equal({authMode: 'dual', managedBy: 'castbot', agentId: AGENT_ID})
    expect(await keychain.getDeploymentToken(saved.id)).to.equal(TOKEN)
  })

  it('rejects addresses that are not a microvm host', async () => {
    const name = agentName()
    names.push(name)
    const bad = [
      'http://demo.microvm.ondigitalocean.com',
      'https://microvm.ondigitalocean.com',
      'https://user:pw@demo.microvm.ondigitalocean.com',
      'https://127.0.0.1',
      'https://demo.microvm.ondigitalocean.com.evil.example',
      'https://evilmicrovm.ondigitalocean.com',
      'https://demo.microvm.ondigitalocean.com:8443',
      'not a url',
    ]
    for (const url of bad) {
      try {
        await importCastbotBlob(blob({name, url}))
        expect.fail(`accepted ${url}`)
      } catch (error) {
        expect(error).to.be.instanceOf(CastbotImportError)
      }
    }
    expect(db.listDeployments(name)).to.have.length(0)
  })

  it('rejects an agent name the CLI cannot store', async () => {
    try {
      await importCastbotBlob(blob({name: 'My Agent'}))
      expect.fail('accepted a space')
    } catch (error) {
      expect(error).to.be.instanceOf(CastbotImportError)
    }
  })

  it('connects with the imported token and the environment cloud token', async () => {
    const name = agentName()
    names.push(name)
    const saved = await importCastbotBlob(blob({name}))
    const row = db.getDeploymentBySha(saved.id)
    const token = await resolveDeploymentAuthToken(row)
    expect(token).to.equal(TOKEN)
    const previous = process.env.DIGITALOCEAN_ACCESS_TOKEN
    process.env.DIGITALOCEAN_ACCESS_TOKEN = 'test-do-token'
    try {
      const result = await microvmProvider.connect!({
        agentName: name,
        deployment: row,
        url: row.deployment_url,
        token: token ?? undefined,
        log: () => {},
        warn: () => {},
        error: (message: string): never => {
          throw new Error(message)
        },
      })
      expect(result?.edgeToken).to.equal('test-do-token')
      expect(result?.token).to.equal(TOKEN)
    } finally {
      if (previous === undefined) delete process.env.DIGITALOCEAN_ACCESS_TOKEN
      else process.env.DIGITALOCEAN_ACCESS_TOKEN = previous
    }
  })

  it('sends the imported token to a local agent', async () => {
    const seen: {auth?: string; cast?: string; method?: string} = {}
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        seen.auth = req.headers.authorization
        const cast = req.headers['x-cast-authorization']
        seen.cast = Array.isArray(cast) ? cast[0] : cast
        seen.method = JSON.parse(Buffer.concat(chunks).toString('utf8')).method
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({jsonrpc: '2.0', id: 1, result: {parts: [{text: 'ok from agent'}]}}))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('no port')
      const client = new A2AClient(`http://127.0.0.1:${address.port}`, TOKEN, 'test-do-token')
      const reply = await client.sendMessage('hello')
      expect(reply.text).to.equal('ok from agent')
      expect(seen.method).to.equal('message/send')
      expect(seen.auth).to.equal('Bearer test-do-token')
      expect(seen.cast).to.equal(`Bearer ${TOKEN}`)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('refuses shutdown and upgrade before they touch the machine', async () => {
    const name = agentName()
    names.push(name)
    const saved = await importCastbotBlob(blob({name}))
    const shutdownModule = require('../../../typescript/cast-cli/src/commands/shutdown')
    const upgradeModule = require('../../../typescript/cast-cli/src/commands/upgrade')
    let destroyed = false
    let upgraded = false
    const originalDestroy = shutdownModule.PROVIDER_DESTROYERS.microvm
    const originalUpgrade = microvmProvider.upgrade
    shutdownModule.PROVIDER_DESTROYERS.microvm = async () => {
      destroyed = true
    }
    microvmProvider.upgrade = async () => {
      upgraded = true
    }
    try {
      const shutdown = new shutdownModule.default([], {color: false})
      shutdown.config = {runHook: async () => {}, name: 'shutdown', bin: 'cast'}
      shutdown.argv = [name]
      shutdown.parse = async () => ({args: {agent: name}, flags: {force: true}})
      shutdown.confirm = async () => true
      try {
        await shutdown.run()
        expect.fail('shutdown ran')
      } catch (error) {
        expect((error as Error).message).to.equal(castbotLifecycleMessage(name))
      }
      const upgrade = new upgradeModule.default([], {color: false})
      upgrade.config = {runHook: async () => {}, name: 'upgrade', bin: 'cast'}
      upgrade.argv = [name]
      upgrade.parse = async () => ({args: {agent: name, version: undefined}, flags: {'list-versions': false}})
      try {
        await upgrade.run()
        expect.fail('upgrade ran')
      } catch (error) {
        expect((error as Error).message).to.equal(castbotLifecycleMessage(name))
      }
      expect(destroyed).to.equal(false)
      expect(upgraded).to.equal(false)
      expect(db.getDeploymentBySha(saved.id).deleted_at).to.equal(null)
    } finally {
      shutdownModule.PROVIDER_DESTROYERS.microvm = originalDestroy
      microvmProvider.upgrade = originalUpgrade
    }
  })

  it('removes only the local castbot entry', async () => {
    const name = agentName()
    names.push(name)
    const saved = await importCastbotBlob(blob({name}))
    await removeCastbotImport(name)
    expect(db.getDeploymentBySha(saved.id)).to.equal(undefined)
    expect(await keychain.getDeploymentToken(saved.id)).to.equal(null)
    expect(db.getAgent(name)).to.exist

    const other = agentName()
    names.push(other)
    const otherId = Math.random().toString(16).slice(2, 8).padEnd(6, 'a')
    db.ensureAgent(other)
    db.createDeployment(otherId, other, 'docker', 'http://127.0.0.1:9', 'hash')
    try {
      await removeCastbotImport(other)
      expect.fail('removed a non-castbot row')
    } catch (error) {
      expect(error).to.be.instanceOf(CastbotImportError)
    }
    expect(db.getDeploymentBySha(otherId).provider).to.equal('docker')
  })
})
