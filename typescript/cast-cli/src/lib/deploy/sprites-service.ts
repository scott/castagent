/** Sprite service that keeps the Cast agent listening on port 8080. */

export const SPRITE_AGENT_DIR = '/opt/cast-agent'
export const SPRITE_SERVICE_NAME = 'cast-agent'
export const SPRITE_ENV = '/.sprite/bin/sprite-env'

/** Quote a value for a remote bash assignment. The script is not parsed by the local shell. */
export function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Foreground launch script. A sprite service treats an exiting command as
 * stopped, so this must not nohup or background the runtime.
 */
export function spriteAgentLaunchScript(
  agentName: string,
  authToken: string,
  env: Record<string, string>,
): string {
  const lines = [
    '#!/bin/bash',
    `cd ${SPRITE_AGENT_DIR}`,
    `export PYTHONPATH=${SPRITE_AGENT_DIR}/.cast-runtime`,
    `export CAST_AGENT_NAME=${shellSingleQuote(agentName)}`,
    `export CAST_AGENT_PATH=${SPRITE_AGENT_DIR}`,
    `export AUTH_TOKEN=${shellSingleQuote(authToken)}`,
  ]
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    lines.push(`export ${key}=${shellSingleQuote(value)}`)
  }
  lines.push(
    `exec ${SPRITE_AGENT_DIR}/venv/bin/python -m cast.runtime --agent-path ${SPRITE_AGENT_DIR} --port 8080 --host 0.0.0.0`,
  )
  return `${lines.join('\n')}\n`
}

/**
 * Remote script that installs and starts the service.
 * Pass it as the single argument to `bash -c`, with the launch script on stdin.
 * `sprite exec` must be spawned with `shell: false`. A shell join makes the
 * remote `bash -c` run only the first word, so the agent never listens and
 * the local proxy resets the chat stream.
 */
export function spriteInstallServiceCommand(): string {
  const script = `${SPRITE_AGENT_DIR}/start.sh`
  return [
    `sudo tee ${script} >/dev/null`,
    `sudo chmod 755 ${script}`,
    `sudo chmod 777 ${SPRITE_AGENT_DIR}/memory`,
    `(${SPRITE_ENV} services delete ${SPRITE_SERVICE_NAME} >/dev/null 2>&1 || true)`,
    `${SPRITE_ENV} services create ${SPRITE_SERVICE_NAME} --cmd ${script} --http-port 8080 --dir ${SPRITE_AGENT_DIR} --no-stream`,
  ].join(' && ')
}

/** argv after `sprite`. `services start` leaves an already-running service on its current pid. */
export function spriteStartServiceArgs(spriteName: string): string[] {
  return ['exec', '-s', spriteName, '--', SPRITE_ENV, 'services', 'start', SPRITE_SERVICE_NAME]
}

export function spriteServiceStatusArgs(spriteName: string): string[] {
  return ['exec', '-s', spriteName, '--', SPRITE_ENV, 'services', 'get', SPRITE_SERVICE_NAME]
}
