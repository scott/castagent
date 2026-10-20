/**
 * Child process for the session append seam test.
 *
 * The parent sets HOME to a temporary directory that already holds a
 * sessions database without topic columns and a stale ~/.cast/python.
 * This process then calls the real CLI or TUI append helper.
 */
import * as fs from 'fs'
import * as path from 'path'
import * as vm from 'vm'
import ts from 'typescript'

const repo = path.resolve(__dirname, '../../..')

function loadTuiAppend(): (sessionId: string, role: 'user' | 'agent', text: string) => Promise<void> {
  const cache = new Map<string, any>()

  function load(file: string): any {
    const cached = cache.get(file)
    if (cached) return cached
    const source = fs.readFileSync(file, 'utf8')
    let js = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText
    js = js.replace(/import\.meta\.url/g, JSON.stringify(pathToFileURL(file)))
    const module = {exports: {} as any}
    const localRequire = (id: string) => {
      // appendMessage does not open the database. Skip db.ts, which
      // uses import.meta and a local `require` binding the vm cannot host.
      if (id === './db.js') return {getDb: async () => null}
      if (id.startsWith('.')) return load(resolveLocal(file, id))
      return require(id)
    }
    const sandbox: any = {
      exports: module.exports,
      module,
      require: localRequire,
      console,
      process,
      Buffer,
      __dirname: path.dirname(file),
      __filename: file,
    }
    vm.createContext(sandbox)
    vm.runInContext(js, sandbox)
    cache.set(file, module.exports)
    return module.exports
  }

  const sessions = load(path.join(repo, 'typescript/cast-tui/src/lib/sessions.ts'))
  return sessions.appendMessage
}

function resolveLocal(fromFile: string, spec: string): string {
  const base = path.resolve(path.dirname(fromFile), spec)
  const swapped = base.endsWith('.js') ? base.slice(0, -3) + '.ts' : base
  if (fs.existsSync(swapped)) return swapped
  if (fs.existsSync(base + '.ts')) return base + '.ts'
  if (fs.existsSync(base)) return base
  throw new Error(`Cannot resolve ${spec} from ${fromFile}`)
}

function pathToFileURL(file: string): string {
  return require('url').pathToFileURL(file).href
}

async function main(): Promise<void> {
  const [which, sessionId, text] = process.argv.slice(2)
  if (which === 'cli') {
    const {appendMessage} = require(path.join(repo, 'typescript/cast-cli/src/lib/sessions.ts'))
    await appendMessage({sessionId, role: 'user', text})
    return
  }
  if (which === 'tui') {
    await loadTuiAppend()(sessionId, 'user', text)
    return
  }
  throw new Error(`Unknown helper ${which}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
