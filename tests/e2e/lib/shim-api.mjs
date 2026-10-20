import path from 'node:path'
import {faultHit, readWorld, recordRequest, updateWorld} from './state.mjs'

export function createShimApi() {
  const stateDir = process.env.CAST_E2E_STATE
  if (!stateDir) {
    process.stderr.write('e2e shim: CAST_E2E_STATE is not set\n')
    process.exit(2)
  }
  const bin = path.basename(process.argv[1] || '')
  const args = process.argv.slice(2)
  const joined = args.join(' ')

  function envFlags() {
    return {
      SPRITE_TOKEN: Boolean(process.env.SPRITE_TOKEN),
      SPRITES_TOKEN: Boolean(process.env.SPRITES_TOKEN),
      FLY_API_TOKEN: Boolean(process.env.FLY_API_TOKEN),
      DIGITALOCEAN_ACCESS_TOKEN: Boolean(process.env.DIGITALOCEAN_ACCESS_TOKEN),
    }
  }

  function remoteOf(argv) {
    const dash = argv.indexOf('--')
    if (dash !== -1) return argv.slice(dash + 1).join(' ')
    const at = argv.findIndex(arg => arg.startsWith('root@'))
    if (at !== -1) return argv.slice(at + 1).join(' ')
    return ''
  }

  const remote = remoteOf(args)

  function finish(code, stdout = '', stderr = '') {
    recordRequest(stateDir, {bin, argv: args, remote, cwd: process.cwd(), env: envFlags()})
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    process.exit(code)
  }

  async function readStdin() {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8')
  }

  function appFlag() {
    const index = args.indexOf('--app')
    if (index !== -1 && args[index + 1]) return args[index + 1]
    return ''
  }

  return {
    stateDir,
    bin,
    args,
    joined,
    remote,
    finish,
    readStdin,
    appFlag,
    envFlags,
    updateWorld,
    readWorld,
    faultHit,
    recordRequest,
  }
}
