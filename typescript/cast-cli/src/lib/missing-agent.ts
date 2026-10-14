/** Error text when a command needs an agent directory that is not on disk. */
export function missingAgentError(agentName: string, agentPath: string): string {
  return (
    `Agent '${agentName}' not found at ${agentPath}.\n` +
    `Create the agent first with: cast new`
  )
}
