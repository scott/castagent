/**
 * Mocha preload: give tests a keytar stand-in.
 *
 * keytar's native binding dlopens libsecret-1.so.0 as soon as the module is
 * loaded. GitHub-hosted Ubuntu runners do not ship that library, so mocha
 * aborted while importing keychain code — before any test ran. Installing
 * libsecret would only move the failure: the runner also has no Secret
 * Service, and the prebuild is tied to a Node ABI and a soname.
 *
 * The suite never calls the real keychain. It stubs getPassword, setPassword,
 * deletePassword, and findCredentials. This hook returns one shared object
 * for every require('keytar'), which is what those stubs replace. TypeScript's
 * `import * as keytar` reads the methods through live getters, so a stub
 * installed on require('keytar') is the function production code calls.
 *
 * Loaded from .mocharc.json after ts-node/register and before test files.
 */

'use strict'

const Module = require('module')

const MARKER = Symbol.for('cast.testKeytar')
const HOOK = Symbol.for('cast.testKeytarHook')

const keytarMock = {
  async getPassword() {
    return null
  },
  async setPassword() {},
  async deletePassword() {
    return false
  },
  async findPassword() {
    return null
  },
  async findCredentials() {
    return []
  },
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

module.exports = keytarMock
