import {expect} from 'chai'
import * as fs from 'fs'
import * as path from 'path'

const repoRoot = path.resolve(__dirname, '../../..')

function read(relative: string): string {
  return fs.readFileSync(path.join(repoRoot, relative), 'utf8')
}

/**
 * Issue #123: tools.custom is a string or a path object. cast describe
 * prints that label. The runtime loads tools.builtin and leaves
 * tools.custom unloaded.
 */
describe('tools.custom docs', () => {
  const anatomy = read('docs-site/content/building-agents/anatomy.md')
  const customTools = read('docs-site/content/configuration/custom-tools.md')
  const settings = read('docs-site/content/getting-started/global-settings.md')
  const inspect = read('docs-site/content/building-agents/inspect.md')
  const describeSource = read('typescript/cast-cli/src/commands/describe.ts')
  const runtimeSource = read('python/cast/agent/runtime.py')

  it('documents string and path entries', () => {
    for (const page of [anatomy, customTools, settings]) {
      expect(page).to.include('email_tools')
      expect(page).to.match(/path: tools\//)
    }
    expect(anatomy).to.not.include('list of `tools/*.py` modules to load')
    expect(customTools).to.not.include('There is no registration step')
    expect(customTools).to.not.include('Cast loads all `.py` files')
    expect(customTools).to.include('Custom: email_tools, tools/summarize_thread.py')
  })

  it('says the runtime loads tools.builtin and leaves tools.custom unloaded', () => {
    const flat = [anatomy, customTools, inspect].join('\n').replace(/\s+/g, ' ')
    expect(flat).to.include('loads only `tools.builtin`')
    expect(flat).to.include('leaves `tools.custom` on the config')
    expect(flat).to.include('leaves `tools.custom` unloaded')
    expect(runtimeSource).to.include('builtin_tool_names = self.config.tools.get("builtin", [])')
    expect(runtimeSource).to.not.include('tools.custom')
    expect(runtimeSource).to.not.include('"custom"')
  })

  it('prints string entries from describe instead of reading only path', () => {
    expect(describeSource).to.include('customToolLabels')
    expect(describeSource).to.include("typeof entry === 'string'")
    expect(describeSource).to.not.include('.map((c: any) => c.path)')
    expect(inspect).to.include('the Custom line prints that string or path')
  })
})