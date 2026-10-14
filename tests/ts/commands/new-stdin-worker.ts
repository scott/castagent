/**
 * Child process for `cast new` stdin tests. Stdin is a pipe, the same
 * way `echo "..." | cast new` runs when there is no terminal.
 */
import * as path from 'path'

async function main(): Promise<void> {
  const commandPath = path.join(__dirname, '../../../typescript/cast-cli/src/commands/new.ts')
  const Cmd = require(commandPath).default
  const instance = new Cmd([], {
    runHook: async () => ({successes: [], failures: []}),
  })
  instance.log = (msg?: string) => {
    process.stdout.write(`${msg ?? ''}\n`)
  }
  instance.warn = (msg?: string) => {
    process.stderr.write(`warn:${msg ?? ''}\n`)
  }
  instance.error = (msg: string | Error) => {
    const text = typeof msg === 'string' ? msg : msg.message
    process.stderr.write(`${text}\n`)
    process.exit(1)
  }
  instance.exit = (code?: number) => {
    process.exit(code ?? 0)
  }
  await instance.run()
}

main().catch((err: unknown) => {
  const text = err instanceof Error ? err.stack ?? err.message : String(err)
  process.stderr.write(`${text}\n`)
  process.exit(1)
})
