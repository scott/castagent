import {BoxRenderable, TextRenderable, InputRenderable, StyledText, blue} from '@opentui/core'

export interface InputComponent {
  box: BoxRenderable
  input: InputRenderable
}

export function createInput(ctx: any, onSubmit: (text: string) => void): InputComponent {
  const box = new BoxRenderable(ctx, {
    width: '100%',
    height: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
  })

  const prompt = new TextRenderable(ctx, {
    content: new StyledText([blue('\u25b8 ')]),
  })

  const input = new InputRenderable(ctx, {
    flexGrow: 1,
    placeholder: 'Type a message...',
  })

  input.on('enter', (value: string) => {
    const text = value.trim()
    if (text) {
      onSubmit(text)
      input.value = ''
    }
  })

  box.add(prompt)
  box.add(input)

  return {box, input}
}
