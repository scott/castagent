import {expect} from 'chai'
import {
  spriteAgentLaunchScript,
  spriteInstallServiceCommand,
  spriteStartServiceArgs,
} from '../../../../typescript/cast-cli/src/lib/deploy/sprites-service'

describe('sprite agent service', () => {
  const token = `sekret'$(reboot)'$HOME`

  it('runs the runtime in the foreground and quotes secrets', () => {
    const script = spriteAgentLaunchScript('demo-agent', token, {
      OPENROUTER_API_KEY: 'sk-or-v1-example',
      'not a name': 'skip',
    })

    expect(script).to.include('exec /opt/cast-agent/venv/bin/python -m cast.runtime')
    expect(script).to.include(`--host 0.0.0.0`)
    expect(script).to.not.include('nohup')
    expect(script).to.not.include('$!')
    expect(script).to.include(`export AUTH_TOKEN='sekret'\\''$(reboot)'\\''$HOME'`)
    expect(script).to.include(`export OPENROUTER_API_KEY='sk-or-v1-example'`)
    expect(script).to.not.include('not a name')
  })

  it('keeps the install script as one remote command', () => {
    const command = spriteInstallServiceCommand()

    expect(command).to.include('sudo tee /opt/cast-agent/start.sh >/dev/null')
    expect(command).to.include('sudo chmod 777 /opt/cast-agent/memory')
    expect(command).to.include('(/.sprite/bin/sprite-env services delete cast-agent >/dev/null 2>&1 || true)')
    expect(command).to.include('services create cast-agent --cmd /opt/cast-agent/start.sh --http-port 8080 --dir /opt/cast-agent --no-stream')
    expect(command).to.not.include('bash -c')
  })

  it('starts the service with separate argv so a shell cannot drop the name', () => {
    expect(spriteStartServiceArgs('cast-demo-agent')).to.deep.equal([
      'exec', '-s', 'cast-demo-agent', '--',
      '/.sprite/bin/sprite-env', 'services', 'start', 'cast-agent',
    ])
  })
})
