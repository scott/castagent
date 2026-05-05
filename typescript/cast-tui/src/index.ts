import {createCliRenderer} from '@opentui/core'
import type {CliRenderer} from '@opentui/core'
import {fileURLToPath} from 'node:url'
import {showWelcomeScreen} from './screens/welcome.js'
import {showChatScreen} from './screens/chat.js'
import type {UiMode} from './components/header.js'

interface TuiOptions {
  agent: string
  url: string
  token?: string
  mode?: UiMode
  welcome?: string
}

export async function startTui(options: TuiOptions): Promise<void> {
  const renderer: CliRenderer = await createCliRenderer({exitOnCtrlC: false})
  if (!renderer.isRunning) {
    renderer.start()
  }

  try {
    await showWelcomeScreen(renderer, options.agent)
    await showChatScreen(renderer, options.agent, options.url, options.token, options.mode, options.welcome)
  } catch (err) {
    console.error('TUI error:', err)
  } finally {
    if (!renderer.isDestroyed) {
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
      case '--mode':
        if (value === 'dev' || value === 'production') {
          options.mode = value
        }
        break
      case '--welcome':
        options.welcome = value
        break
    }
  }

  if (!options.url) {
    console.error('Error: --url is required')
    process.exit(1)
  }

  startTui(options)
}
