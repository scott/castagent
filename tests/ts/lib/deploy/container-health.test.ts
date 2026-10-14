import {expect} from 'chai'
import {
  classifyContainerHealth,
  containerHealthFailureMessage,
  waitForContainerHealth,
} from '../../../../typescript/cast-cli/src/lib/deploy/container-health'

describe('Docker container readiness', () => {
  it('treats an exited container as failed even when docker run returned success', () => {
    expect(classifyContainerHealth({
      status: 'exited',
      logs: 'ModuleNotFoundError: No module named \'git\'',
    })).to.equal('failed')
  })

  it('treats a running container as ready only after Agent ready', () => {
    expect(classifyContainerHealth({status: 'running', logs: 'starting'})).to.equal('pending')
    expect(classifyContainerHealth({
      status: 'running',
      logs: 'Agent ready on port 8080',
    })).to.equal('ready')
  })

  it('fails immediately when the container has exited', async () => {
    let slept = 0
    const result = await waitForContainerHealth(
      async () => ({status: 'exited', logs: 'ModuleNotFoundError: No module named \'git\''}),
      {
        timeoutMs: 30_000,
        now: () => 0,
        sleep: async () => {
          slept += 1
        },
      },
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) {
      expect(result.reason).to.equal('exited')
      expect(result.logs).to.include('No module named')
    }
    expect(slept).to.equal(0)
  })

  it('returns ready once the runtime prints Agent ready', async () => {
    let calls = 0
    let nowMs = 0
    const result = await waitForContainerHealth(async () => {
      calls += 1
      if (calls === 1) return {status: 'running', logs: ''}
      return {status: 'running', logs: 'Agent ready on port 8080\n'}
    }, {
      timeoutMs: 5_000,
      intervalMs: 500,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms
      },
    })
    expect(result).to.deep.equal({ok: true})
    expect(calls).to.equal(2)
  })

  it('times out when the container never becomes ready', async () => {
    let nowMs = 0
    const result = await waitForContainerHealth(
      async () => ({status: 'running', logs: 'still importing'}),
      {
        timeoutMs: 1_000,
        intervalMs: 500,
        now: () => nowMs,
        sleep: async (ms) => {
          nowMs += ms
        },
      },
    )
    expect(result.ok).to.equal(false)
    if (!result.ok) {
      expect(result.reason).to.equal('timeout')
      expect(result.status).to.equal('running')
    }
  })

  it('describes the failure without claiming success', () => {
    const message = containerHealthFailureMessage('cast-bb2-chat', {
      status: 'exited',
      logs: 'File "/app/cast/tools/git.py", line 5\nModuleNotFoundError: No module named \'git\'',
      reason: 'exited',
    })
    expect(message).to.include('cast-bb2-chat')
    expect(message).to.include('exited before the runtime was ready')
    expect(message).to.include('ModuleNotFoundError')
    expect(message).to.include('docker logs cast-bb2-chat')
    expect(message).to.not.include('Successful')
  })
})
