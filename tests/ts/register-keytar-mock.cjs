/**
 * Mocha preload: give tests a keytar stand-in.
 *
 * keytar's native binding dlopens libsecret-1.so.0 as soon as the module is
 * loaded. GitHub-hosted Ubuntu runners do not ship that library, so mocha
 * aborted while importing keychain code — before any test ran. Installing
 * libsecret would only move the failure: the runner also has no Secret
 * Service, and the prebuild is tied to a Node ABI and a soname.
 *
 * Tests that stub getPassword, setPassword, deletePassword, and findCredentials
 * replace the methods on one shared object. TypeScript's `import * as keytar`
 * reads those methods through live getters, so the stub is what production
 * code calls. Tests that do not stub get a memory-backed keychain, because a
 * method that resolves without storing a password drops tokens on the floor.
 *
 * Loaded from .mocharc.json after ts-node/register and before test files.
 */

'use strict'

const Module = require('module')

const MARKER = Symbol.for('cast.testKeytar')
const HOOK = Symbol.for('cast.testKeytarHook')

const passwords = new Map()

function accountKey(service, account) {
  return `${service}\0${account}`
}

const keytarMock = {
  async getPassword(service, account) {
    return passwords.has(accountKey(service, account)) ? passwords.get(accountKey(service, account)) : null
  },
  async setPassword(service, account, password) {
    passwords.set(accountKey(service, account), password)
  },
  async deletePassword(service, account) {
    return passwords.delete(accountKey(service, account))
  },
  async findPassword(service) {
    const prefix = `${service}\0`
    for (const [key, password] of passwords) {
      if (key.startsWith(prefix)) return password
    }
    return null
  },
  async findCredentials(service) {
    const prefix = `${service}\0`
    const found = []
    for (const [key, password] of passwords) {
      if (key.startsWith(prefix)) found.push({account: key.slice(prefix.length), password})
    }
    return found
  },
}

function resetKeytarMock() {
  passwords.clear()
}

Object.defineProperty(keytarMock, MARKER, {value: true})

if (!Module.prototype.require[HOOK]) {
  const originalRequire = Module.prototype.require
  function requireWithKeytarMock(id) {
    if (id === 'keytar') return keytarMock
    return originalRequire.apply(this, arguments)
  }
  Object.defineProperty(requireWithKeytarMock, HOOK, {value: true})
  Module.prototype.require = requireWithKeytarMock
}

// Drop stored passwords between tests. Sinon stubs replace the methods for
// one test and are restored by that test's sandbox. mochaHooks has to be
// this file's exports; the require('keytar') object stays the mock itself.
module.exports = {
  mochaHooks: {
    beforeEach() {
      resetKeytarMock()
    },
  },
}
