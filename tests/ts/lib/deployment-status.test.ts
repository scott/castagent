import {expect} from 'chai'
import Status from '../../../typescript/cast-cli/src/commands/status'
import {
  collectDeploymentStatus,
  type DeploymentStatusDeps,
  type StatusDeployment,
} from '../../../typescript/cast-cli/src/lib/deployment-status'
import {flyStatusArgs} from '../../../typescript/cast-cli/src/lib/deploy/fly'

function deployment(overrides: Partial<StatusDeployment> = {}): StatusDeployment {
  return {
    id: 'abc123',
    agent_name: 'mail',
    provider: 'fly',
    deployment_url: 'https://cast-mail.fly.dev',
    ...overrides,
  }
}

function deps(overrides: Partial<DeploymentStatusDeps> = {}): DeploymentStatusDeps {
  return {
    getDeploymentBySha: () => null,
    listDeployments: () => [],
    flyStatus: async () => ({stdout: '', stderr: '', exitCode: 0}),
    ...overrides,
  }
}

describe('deployment status', () => {
  it('describes status as Fly machine status with a registry fallback', () => {
    expect(Status.description).to.equal('Show Fly.io machine status, or the registry row for another provider')
    expect(Status.args.agent.required).to.equal(true)
  })

  it('prints flyctl status for a Fly deployment', async () => {
    const calls: string[][] = []
    const result = await collectDeploymentStatus('mail', deps({
      listDeployments: () => [deployment()],
      flyStatus: async (appName) => {
        calls.push(flyStatusArgs(appName))
        return {stdout: 'App\n  Name = cast-mail\n', stderr: '', exitCode: 0}
      },
    }))

    expect(result.status).to.equal('ok')
    expect(result.text).to.include('Name = cast-mail')
    expect(calls).to.deep.equal([flyStatusArgs('cast-mail')])
  })

  it('reports a Fly status failure', async () => {
    const result = await collectDeploymentStatus('abc123', deps({
      getDeploymentBySha: () => deployment(),
      flyStatus: async () => ({stdout: '', stderr: 'Error: Could not find App\n', exitCode: 1}),
    }))

    expect(result.status).to.equal('error')
    expect(result.text).to.include('Could not find App')
    expect(result.text).to.not.include('has been destroyed')
  })

  it('prints the registry row for a provider without live status', async () => {
    let called = false
    const result = await collectDeploymentStatus('mail', deps({
      listDeployments: () => [deployment({
        provider: 'railway',
        deployment_url: 'https://mail.up.railway.app',
        deployed_version: '1.2.0',
      })],
      flyStatus: async () => {
        called = true
        return {stdout: '', stderr: '', exitCode: 0}
      },
    }))

    expect(called).to.equal(false)
    expect(result.status).to.equal('ok')
    expect(result.text).to.include('Provider: railway')
    expect(result.text).to.include('Version: 1.2.0')
    expect(result.text).to.include('This deployment is railway')
  })

  it('says when nothing is deployed', async () => {
    const result = await collectDeploymentStatus('mail', deps())
    expect(result.status).to.equal('error')
    expect(result.text).to.include('No deployment found')
  })
})
