/**
 * Child preload: make require('keytar') fail the way a host without
 * libsecret fails. The CLI must catch ERR_DLOPEN_FAILED and use the file.
 */
'use strict'

const Module = require('module')
const original = Module.prototype.require

Module.prototype.require = function requireWithoutKeytar(id) {
  if (id === 'keytar') {
    const error = new Error('libsecret-1.so.0: cannot open shared object file')
    error.code = 'ERR_DLOPEN_FAILED'
    throw error
  }
  return original.apply(this, arguments)
}
