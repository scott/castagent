/**
 * Arguments for `python -m cast.runtime`.
 * The bearer token is the AUTH_TOKEN environment variable.
 * This list has no slot for a secret.
 */
export function runtimeProcessArgs(input: {
  agentPath: string
  port: number | string
  host?: string
}): string[] {
  const args = [
    '-m', 'cast.runtime',
    '--agent-path', input.agentPath,
    '--port', String(input.port),
  ]
  if (input.host !== undefined) {
    args.push('--host', input.host)
  }
  return args
}

/** Exec-form Dockerfile CMD. The shell does not expand it. */
export function runtimeDockerfileCmd(input?: {
  agentPath?: string
  port?: number | string
  host?: string
}): string {
  const args = [
    'python',
    ...runtimeProcessArgs({
      agentPath: input?.agentPath ?? '/app/agent',
      port: input?.port ?? 8080,
      host: input?.host ?? '0.0.0.0',
    }),
  ]
  return `CMD [${args.map(arg => JSON.stringify(arg)).join(', ')}]`
}
