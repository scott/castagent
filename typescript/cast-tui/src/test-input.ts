import {createCliRenderer} from '@opentui/core'

async function test() {
  const renderer = await createCliRenderer({exitOnCtrlC: false})
  renderer.start()

  console.error('[TEST] TUI started. Press keys. Ctrl+C to exit.')

  renderer.keyInput.on('keypress', (key: any) => {
    console.error(`[TEST KEY] name=${key.name} ctrl=${key.ctrl} shift=${key.shift} meta=${key.meta} char=${key.char}`)
    if (key.ctrl && key.name === 'c') {
      renderer.destroy()
      process.exit(0)
    }
  })

  // Keep alive
  await new Promise(() => {})
}

test().catch(console.error)
