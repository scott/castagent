/**
 * Child process for --body - tests. Uses the real oclif parser so stdin
 * is a pipe, the same way `echo body | cast skills add ... --body -` runs.
 */
import * as path from 'path'

const which = process.argv[2]
const argv = process.argv.slice(3)

async function main(): Promise<void> {
  const commandPath = which === 'builder-skills'
    ? path.join(__dirname, '../../../typescript/cast-cli/src/commands/builder-skills.ts')
    : path.join(__dirname, '../../../typescript/cast-cli/src/commands/skills.ts')
  const Cmd = require(commandPath).default
  const instance = new Cmd(argv, {
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
