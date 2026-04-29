import {Args, Command, Flags} from '@oclif/core'
import {db} from '../lib/sqlite'

export default class Stop extends Command {
  static description = 'Stop a running agent'

  static examples = [
    '<%= config.bin %> <%= command.id %> email-agent',
    '<%= config.bin %> <%= command.id %> email-agent --force',
  ]

  static flags = {
    force: Flags.boolean({description: 'Force kill (SIGKILL instead of SIGTERM)'}),
  }

  static args = {
    agent: Args.string({description: 'Agent name', required: true}),
  }

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Stop)
    const agentName = args.agent

    // Check if agent is running
    const localAgent = db.getLocalAgent(agentName)

    if (!localAgent) {
      this.log(`Agent '${agentName}' is not currently running.`)
      return
    }

    const {pid, port} = localAgent

    this.log(`Stopping agent '${agentName}' (PID: ${pid}, port: ${port})...`)

    try {
      // Check if process actually exists
      try {
        process.kill(pid, 0)
      } catch {
        this.log(`Process ${pid} is not running. Cleaning up database entry.`)
        db.removeLocalAgent(agentName)
        return
      }

      // Send shutdown signal
      const signal = flags.force ? 'SIGKILL' : 'SIGTERM'
      process.kill(pid, signal)

      // Wait for process to exit (up to 5 seconds)
      let stopped = false
      for (let i = 0; i < 50; i++) {
        try {
          process.kill(pid, 0)
          // Process still exists, wait a bit
          await new Promise(resolve => setTimeout(resolve, 100))
        } catch {
          // Process is gone
          stopped = true
          break
        }
      }

      if (stopped) {
        db.removeLocalAgent(agentName)
        this.log(`✓ Agent '${agentName}' stopped successfully.`)
      } else {
        this.warn(`Agent '${agentName}' did not stop gracefully.`)
        if (!flags.force) {
          this.log('Use --force to kill it immediately.')
        }
      }
    } catch (error) {
      this.error(`Failed to stop agent: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
