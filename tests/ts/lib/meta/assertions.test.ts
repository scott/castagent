import {expect} from 'chai'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  AssertionEngine,
  collectPreexistingPaths,
  resolveAssertionPath,
} from '../../../../typescript/cast-cli/src/lib/meta/assertions'
import {createMetaTestWorkspace, removeMetaTestWorkspace} from '../../../../typescript/cast-cli/src/lib/meta/harness'

const createSimpleAssertions = [
  {
    type: 'file_exists',
    path: '~/.cast/agents/email-agent/agent.yaml',
  },
  {
    type: 'yaml_contains',
    path: '~/.cast/agents/email-agent/agent.yaml',
    key: 'name',
    value: 'email-agent',
  },
]

describe('meta test assertions', () => {
  const homeAgentYaml = path.join(os.homedir(), '.cast', 'agents', 'email-agent', 'agent.yaml')

  it('rewrites ~/.cast/agents paths into the isolated directory', () => {
    const agentsDir = path.join(os.tmpdir(), 'cast-meta-example', 'agents')
    const resolved = resolveAssertionPath('~/.cast/agents/email-agent/agent.yaml', agentsDir)
    expect(resolved).to.equal(path.resolve(agentsDir, 'email-agent', 'agent.yaml'))
    expect(resolved.startsWith(path.join(os.homedir(), '.cast', 'agents'))).to.equal(false)
  })

  it('passes create-simple when this run created the agent', async () => {
    const workspace = createMetaTestWorkspace()
    const agentYaml = path.join(workspace.agentsDir, 'email-agent', 'agent.yaml')
    const preexisting = collectPreexistingPaths(createSimpleAssertions, workspace.agentsDir)
    fs.mkdirSync(path.dirname(agentYaml), {recursive: true})
    fs.writeFileSync(agentYaml, 'name: email-agent\n')
    const homeBefore = fs.existsSync(homeAgentYaml) ? fs.readFileSync(homeAgentYaml, 'utf8') : null

    try {
      expect(preexisting.size).to.equal(0)
      const results = await new AssertionEngine().run(createSimpleAssertions, {
        response: "Agent 'email-agent' created successfully",
        agentsDir: workspace.agentsDir,
        preexisting,
      })
      expect(results.every(result => result.passed)).to.equal(true)
      const homeAfter = fs.existsSync(homeAgentYaml) ? fs.readFileSync(homeAgentYaml, 'utf8') : null
      expect(homeAfter).to.equal(homeBefore)
    } finally {
      removeMetaTestWorkspace(workspace.root)
    }
  })

  it('fails create-simple when the agent file already existed', async () => {
    const workspace = createMetaTestWorkspace()
    const agentYaml = path.join(workspace.agentsDir, 'email-agent', 'agent.yaml')
    fs.mkdirSync(path.dirname(agentYaml), {recursive: true})
    fs.writeFileSync(agentYaml, 'name: email-agent\ndescription: planted\n')
    const preexisting = collectPreexistingPaths(createSimpleAssertions, workspace.agentsDir)

    try {
      const results = await new AssertionEngine().run(createSimpleAssertions, {
        response: "Agent 'email-agent' already exists",
        agentsDir: workspace.agentsDir,
        preexisting,
      })
      expect(results).to.have.length(2)
      for (const result of results) {
        expect(result.passed).to.equal(false)
        expect(result.message).to.include('was not created by this run')
        expect(result.message).to.include(agentYaml)
      }
      expect(fs.readFileSync(agentYaml, 'utf8')).to.include('planted')
    } finally {
      removeMetaTestWorkspace(workspace.root)
    }
  })

  it('still checks response text when the scenario does not create a file', async () => {
    const results = await new AssertionEngine().run(
      [{type: 'response_contains', value: 'haiku'}],
      {response: 'I recommend haiku for this.', preexisting: new Set()},
    )
    expect(results[0].passed).to.equal(true)
  })
})
