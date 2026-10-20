#!/usr/bin/env node
// Dispatches a provider CLI basename to the module that owns it.
import {handleBuiltinShim} from './builtin-shims.mjs'
import {loadProviders} from './discover.mjs'
import {createShimApi} from './shim-api.mjs'

const api = createShimApi()
if (await handleBuiltinShim(api)) {
  // builtins call finish(), which exits
}
const modules = await loadProviders()
for (const mod of modules) {
  if (typeof mod.handleShim === 'function' && await mod.handleShim(api)) {
    // Long-lived stand-in (ssh -N, sprite proxy). Do not exit.
    await new Promise(() => {})
  }
}
api.finish(1, '', `e2e shim: unhandled ${api.bin} ${api.joined}\n`)
