import fs from 'node:fs'
import path from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const providersDir = path.join(here, '../providers')

let loaded = null

export async function loadProviders() {
  if (loaded) return loaded
  const names = fs.readdirSync(providersDir).filter(name => name.endsWith('.mjs')).sort()
  const modules = []
  for (const name of names) {
    const imported = await import(pathToFileURL(path.join(providersDir, name)).href)
    modules.push(imported)
  }
  loaded = modules
  return modules
}

export function providerShims(modules) {
  const names = new Set()
  for (const mod of modules) {
    for (const name of mod.shims || []) names.add(name)
  }
  return [...names]
}

export function providerCases(modules) {
  return modules.flatMap(mod => mod.cases || [])
}

export function providerHttpHandlers(modules) {
  return modules.map(mod => mod.handleHttp).filter(handler => typeof handler === 'function')
}
