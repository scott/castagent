/**
 * Node 18 cannot require() an ESM package. chai 6 is ESM-only, so mocha's
 * require() fallback throws ERR_REQUIRE_ESM and the runner reports that as
 * "Unknown file extension .ts". Node 20+ can require() ESM natively.
 *
 * Bundle chai to CommonJS once, on Node 18 only, and serve that from
 * require('chai'). Tests stay on ts-node so sinon can still stub exports.
 */

'use strict'

const Module = require('module')
const path = require('path')

if (process.features && process.features.require_module) {
  module.exports = {}
} else {
  const esbuild = require('esbuild')
  const built = esbuild.buildSync({
    stdin: {
      contents: 'export {expect} from "chai"\n',
      loader: 'ts',
      resolveDir: path.resolve(__dirname, '../..'),
      sourcefile: 'chai-cjs-shim.ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    logLevel: 'silent',
  })
  const filename = path.join(__dirname, 'chai-cjs-shim.js')
  const compiled = new Module(filename)
  compiled.filename = filename
  compiled.paths = Module._nodeModulePaths(path.dirname(filename))
  compiled._compile(built.outputFiles[0].text, filename)

  const originalRequire = Module.prototype.require
  function requireWithChai(id) {
    if (id === 'chai') return compiled.exports
    return originalRequire.apply(this, arguments)
  }
  Module.prototype.require = requireWithChai
  module.exports = {}
}
