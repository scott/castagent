import {createCliRenderer} from '@opentui/core'
import type {CliRenderer} from '@opentui/core'
import clipboardy from 'clipboardy'
import {fileURLToPath} from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import {showChatScreen} from './screens/chat.js'
import {parseTuiLaunchOptions, type TuiCliOptions} from './lib/cli-args.js'
import {copyHighlightedText} from './lib/selection-clipboard.js'

// Log file for crash diagnostics (written synchronously so it survives
// terminal mode switches and process.exit).
const CRASH_LOG = path.join(os.tmpdir(), 'cast-tui-crash.log')
function logCrash(msg: string, err: unknown): void {
  const line = `[${new Date().toISOString()}] ${msg}: ${err instanceof Error ? err.stack || err.message : String(err)}\n`
  try { fs.writeFileSync(CRASH_LOG, line, {flag: 'a'}) } catch {}
  try { process.stderr.write(line) } catch {}
}

export async function startTui(options: TuiCliOptions): Promise<void> {
  let renderer: CliRenderer | null = null
  try {
    renderer = await createCliRenderer({exitOnCtrlC: false})
    if (!renderer.isRunning) {
      renderer.start()
    }

    // finishSelection emits "selection" once on mouse-up, not on drag frames.
    renderer.on('selection', (selection) => {
      if (!renderer) return
      copyHighlightedText(selection.getSelectedText(), {
        osc52: renderer.copyToClipboardOSC52.bind(renderer),
        write: clipboardy.write.bind(clipboardy),
      })
    })

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
  let options: TuiCliOptions
  try {
    options = parseTuiLaunchOptions(args, process.env)
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
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
