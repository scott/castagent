import {BoxRenderable, TextRenderable} from '@opentui/core'
import type {CliRenderer} from '@opentui/core'

export async function showWelcomeScreen(renderer: CliRenderer, agentName: string): Promise<void> {
  return new Promise((resolve) => {
    for (const child of renderer.root.getChildren()) {
      renderer.root.remove(child.id)
    }

    const box = new BoxRenderable(renderer, {
      width: '100%',
      height: '100%',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 1,
    })

    const logo = new TextRenderable(renderer, {
      content: [
        '   ____      _     ',
        '  / ___|___ | |_  ',
        ' | |   / _ \\| __| ',
        ' | |__| (_) | |_  ',
        '  \\____\\___/ \\__| ',
      ].join('\n'),
    })

    const creating = new TextRenderable(renderer, {
      content: `Creating: ${agentName}`,
    })

    const prompt = new TextRenderable(renderer, {
      content: 'Press any key to start...',
    })

    box.add(logo)
    box.add(creating)
    box.add(prompt)
    renderer.root.add(box)

    let resolved = false
    const timer = setTimeout(() => done(), 2000)

    const onKey = () => done()
    renderer.keyInput.on('keypress', onKey)

    function done() {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      renderer.keyInput.off('keypress', onKey)
      resolve()
    }
  })
}
