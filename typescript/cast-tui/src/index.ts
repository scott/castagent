import {createCliRenderer} from '@opentui/core'
import type {CliRenderer} from '@opentui/core'
import {fileURLToPath} from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {showWelcomeScreen} from './screens/welcome.js'
import {showChatScreen} from './screens/chat.js'
import type {UiMode} from './components/header.js'

// Log file for crash diagnostics (written synchronously so it survives
// terminal mode switches and process.exit).
const CRASH_LOG = path.join(os.tmpdir(), 'cast-tui-crash.log')
function logCrash(msg: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] ${msg}: ${err instanceof Error ? err.stack || err.message : String(err)}\n`
  try { fs.writeFileSync(CRASH_LOG, line, {flag: 'a'}) } catch {}
  try { process.stderr.write(line) } catch {}
}

interface TuiOptions {
  agent: string
  url: string
  token?: string
  edgeToken?: string
  mode?: UiMode
  welcome?: string
  session?: string
}

export async function startTui(options: TuiOptions): Promise<void> {
  let renderer: CliRenderer | null = null
  try {
    renderer = await createCliRenderer({exitOnCtrlC: false})
    if (!renderer.isRunning) {
      renderer.start()
    }

    if (options.mode !== 'on-host') {
      await showWelcomeScreen(renderer, options.agent)
    }
    await showChatScreen(renderer, options.agent, options.url, options.token, options.mode, options.welcome, options.session, options.edgeToken)
  } catch (err) {
    logCrash('TUI error', err)
  } finally {
    if (renderer && !renderer.isDestroyed) {
      renderer.destroy()
    }
  }
}

const __filename = fileURLToPath(import.meta.url)
const isMain = process.argv[1] === __filename || (process.argv[1] !== undefined && __filename.endsWith(process.argv[1]))

if (isMain) {
  const args = process.argv.slice(2)
  const options: TuiOptions = {
    agent: 'unknown',
    url: '',
    mode: 'dev',
  }

  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]
    const value = args[i + 1]

    switch (flag) {
      case '--agent':
        options.agent = value
        break
      case '--url':
        options.url = value
        break
      case '--token':
        options.token = value
        break
      case '--edge-token':
        options.edgeToken = value
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
    }
  }

  // Fall back to AUTH_TOKEN env var if no --token was provided
  // (used in on-host mode where the token is inherited from the container)
  if (!options.token && process.env.AUTH_TOKEN) {
    options.token = process.env.AUTH_TOKEN
  }

  if (!options.url) {
    console.error('Error: --url is required')
    process.exit(1)
  }

  // Global error handlers ensure we log any crash before exit, even if
  // the terminal renderer is in a bad state.
  process.on('unhandledRejection', (err: unknown) => {
    logCrash('TUI unhandled rejection', err)
  })
  process.on('uncaughtException', (err: Error) => {
    logCrash('TUI uncaught exception', err)
  })

  startTui(options).catch((err: unknown) => {
    logCrash('Fatal TUI error', err)
    process.exit(1)
  })
}
