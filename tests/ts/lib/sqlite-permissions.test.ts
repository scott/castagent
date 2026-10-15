import {expect} from 'chai'
import Database from 'better-sqlite3'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import sinon from 'sinon'
import {CastDatabase} from '../../../typescript/cast-cli/src/lib/sqlite'

describe('sqlite file modes', () => {
  let sandbox: sinon.SinonSandbox

  beforeEach(() => {
    sandbox = sinon.createSandbox()
  })

  afterEach(() => {
    sandbox.restore()
  })

  it('creates the database mode 0600 and its directory mode 0700 under umask 022', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-db-perm-'))
    const dir = path.join(root, 'nested')
    const dbPath = path.join(dir, 'cast.db')
    const births: number[] = []
    const dirBirths: number[] = []
    const chmodmed: string[] = []
    const realOpen = fs.openSync
    const realMkdir = fs.mkdirSync
    const realChmod = fs.chmodSync
    sandbox.stub(fs, 'openSync').callsFake((...args: unknown[]) => {
      const fd = (realOpen as (...openArgs: unknown[]) => number).apply(fs, args)
      if (args[0] === dbPath) births.push(fs.fstatSync(fd).mode & 0o777)
      return fd
    })
    sandbox.stub(fs, 'mkdirSync').callsFake((...args: unknown[]) => {
      const created = (realMkdir as (...mkdirArgs: unknown[]) => unknown).apply(fs, args)
      const createdDir = typeof args[0] === 'string' ? args[0] : ''
      if (createdDir && fs.existsSync(createdDir) && fs.statSync(createdDir).isDirectory()) {
        dirBirths.push(fs.statSync(createdDir).mode & 0o777)
      }
      return created
    })
    sandbox.stub(fs, 'chmodSync').callsFake((file: fs.PathLike, mode: fs.Mode) => {
      chmodmed.push(String(file))
      return realChmod(file, mode)
    })
    const previous = process.umask(0o022)
    let db: CastDatabase | null = null
    try {
      db = new CastDatabase(dbPath)
      expect(births.length).to.be.greaterThan(0)
      expect(births.every(mode => mode === 0o600)).to.equal(true)
      expect(dirBirths.length).to.be.greaterThan(0)
      expect(dirBirths.every(mode => mode === 0o700)).to.equal(true)
      expect(fs.statSync(dbPath).mode & 0o777).to.equal(0o600)
      expect(fs.statSync(dir).mode & 0o777).to.equal(0o700)
      expect(chmodmed.includes(dbPath)).to.equal(false)
      const during = process.umask(0o022)
      expect(during).to.equal(0o022)
      db.createAgent('perm-agent', '/tmp/agent.yaml')
      expect(db.getAgent('perm-agent').name).to.equal('perm-agent')
    } finally {
      process.umask(previous)
      db?.close()
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('tightens an existing database that was created mode 0644', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-db-loose-'))
    const dbPath = path.join(root, 'cast.db')
    const previous = process.umask(0o022)
    let db: CastDatabase | null = null
    try {
      const raw = new Database(dbPath)
      raw.exec('CREATE TABLE kept (id INTEGER)')
      raw.prepare('INSERT INTO kept (id) VALUES (7)').run()
      raw.close()
      fs.chmodSync(dbPath, 0o644)
      fs.chmodSync(root, 0o755)
      const tmpMode = fs.statSync(root).mode
      db = new CastDatabase(dbPath)
      expect(fs.statSync(dbPath).mode & 0o777).to.equal(0o600)
      expect(fs.statSync(root).mode).to.equal(tmpMode)
      db.close()
      db = null
      const check = new Database(dbPath, {readonly: true})
      const row = check.prepare('SELECT id FROM kept').get() as {id: number}
      check.close()
      expect(row.id).to.equal(7)
    } finally {
      process.umask(previous)
      db?.close()
      fs.rmSync(root, {recursive: true, force: true})
    }
  })

  it('tightens ~/.cast when the database lives there', () => {
    const home = path.join(os.homedir(), '.cast')
    const homeExisted = fs.existsSync(home)
    const homeMode = homeExisted ? fs.statSync(home).mode & 0o777 : null
    const dir = path.join(home, `db-perm-${process.pid}`)
    const dbPath = path.join(dir, 'cast.db')
    const previous = process.umask(0o022)
    let db: CastDatabase | null = null
    try {
      fs.mkdirSync(home, {recursive: true})
      fs.chmodSync(home, 0o755)
      fs.mkdirSync(dir)
      fs.chmodSync(dir, 0o755)
      db = new CastDatabase(dbPath)
      expect(fs.statSync(home).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(dir).mode & 0o777).to.equal(0o700)
      expect(fs.statSync(dbPath).mode & 0o777).to.equal(0o600)
    } finally {
      process.umask(previous)
      db?.close()
      fs.rmSync(dir, {recursive: true, force: true})
      if (!homeExisted) {
        fs.rmSync(home, {recursive: true, force: true})
      } else if (homeMode !== null) {
        fs.chmodSync(home, homeMode)
      }
    }
  })
})
