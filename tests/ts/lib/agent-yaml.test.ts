import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {AgentYamlError, loadAgentYaml} from '../../../typescript/cast-cli/src/lib/agent-yaml'

describe('agent.yaml load', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cast-agent-yaml-'))
  })

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })

  function write(text: string): string {
    const yamlPath = path.join(dir, 'agent.yaml')
    fs.writeFileSync(yamlPath, text)
    return yamlPath
  }

  it('loads a mapping', () => {
    write('name: demo\nbrain:\n  model: openrouter/openai/gpt-4\n')
    expect(loadAgentYaml(dir)).to.deep.equal({
      name: 'demo',
      brain: {model: 'openrouter/openai/gpt-4'},
    })
  })

  it('uses an empty document when the file is missing or blank', () => {
    expect(loadAgentYaml(dir)).to.deep.equal({})
    write('')
    expect(loadAgentYaml(dir)).to.deep.equal({})
    write('null\n')
    expect(loadAgentYaml(dir)).to.deep.equal({})
  })

  it('throws the parse error, including the file and the line', () => {
    const yamlPath = write('name: demo\nbrain: [unclosed\n')
    expect(() => loadAgentYaml(dir)).to.throw(AgentYamlError, /agent\.yaml could not be parsed/)
    try {
      loadAgentYaml(dir)
      expect.fail('load should throw')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include(`${yamlPath}:2)`)
      expect(message).to.not.include(`${yamlPath}:3)`)
      expect(message).to.include('brain: [unclosed')
    }
  })

  it('reports the quoted line, not the blank line after an unclosed token', () => {
    const lines = ['name: demo']
    for (let i = 0; i < 20; i++) lines.push(`key${i}: value`)
    lines.push('brain: [unclosed')
    expect(lines).to.have.length(22)
    const yamlPath = write(`${lines.join('\n')}\n`)
    try {
      loadAgentYaml(dir)
      expect.fail('load should throw')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include(`${yamlPath}:22)`)
      expect(message).to.not.include(`${yamlPath}:23)`)
      expect(message).to.include('brain: [unclosed')
    }
  })

  it('rejects a document that is not a mapping', () => {
    const yamlPath = write('- just\n- a\n- list\n')
    try {
      loadAgentYaml(dir)
      expect.fail('load should throw')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      expect(message).to.include('agent.yaml could not be validated')
      expect(message).to.include(yamlPath)
      expect(message).to.include('expected a mapping')
    }
  })
})
