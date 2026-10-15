export type TuiCliMode = 'dev' | 'production' | 'on-host'

export interface TuiCliOptions {
  agent: string
  url: string
  token?: string
  edgeToken?: string
  mode: TuiCliMode
  welcome?: string
  session?: string
}

const CREDENTIAL_FLAGS = new Set(['--token', '--edge-token'])

/**
 * Flags for a cast-tui process. Bearer and edge credentials come from the
 * environment (AUTH_TOKEN, CAST_EDGE_TOKEN). They are refused on argv
 * because /proc/pid/cmdline is world-readable.
 */
export function parseTuiLaunchOptions(argv: readonly string[], env: NodeJS.ProcessEnv): TuiCliOptions {
  const options: TuiCliOptions = {
    agent: 'unknown',
    url: '',
    mode: 'dev',
  }

  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (CREDENTIAL_FLAGS.has(flag)) {
      throw new Error(`${flag} is not accepted on the command line. Set the credential in the environment.`)
    }
    switch (flag) {
      case '--agent':
        options.agent = value
        break
      case '--url':
        options.url = value
        break
      case '--mode':
        if (value === 'dev' || value === 'production' || value === 'on-host') {
          options.mode = value
        }
        break
      case '--welcome':
        options.welcome = value
        break
      case '--session':
        options.session = value
        break
      default:
        break
    }
  }

  if (env.AUTH_TOKEN) {
    options.token = env.AUTH_TOKEN
  }
  if (env.CAST_EDGE_TOKEN) {
    options.edgeToken = env.CAST_EDGE_TOKEN
  }
  return options
}
