import {createCliRenderer, BoxRenderable, TextRenderable, InputRenderable} from '@opentui/core'

async function test() {
  const renderer = await createCliRenderer({exitOnCtrlC: true})
  renderer.start()

  const box = new BoxRenderable(renderer, {
    width: '100%',
    height: '100%',
    flexDirection: 'column',
  })

  const prompt = new TextRenderable(renderer, {
    content: 'Type something and press Enter:',
  })
  box.add(prompt)

  const input = new InputRenderable(renderer, {
    placeholder: 'Type here...',
    onSubmit: () => {
      console.error(`[SUBMIT] value="${input.value}"`)
      input.value = ''
    },
  })
  box.add(input)

  renderer.root.add(box)
  input.focus()

  console.error('[TEST] Input focused. Type and press Enter. Ctrl+C to exit.')

  await new Promise(() => {})
}

test().catch(console.error)
