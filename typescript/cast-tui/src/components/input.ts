import {BoxRenderable, TextRenderable, TextareaRenderable, StyledText, blue} from '@opentui/core'

export interface InputComponent {
  box: BoxRenderable
  input: TextareaRenderable
}

export function createInput(ctx: any, onSubmit: (text: string) => void): InputComponent {
  const box = new BoxRenderable(ctx, {
    width: '100%',
    height: 'auto',
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
    paddingTop: 1,
    paddingBottom: 1,
    paddingLeft: 0,
    paddingRight: 0,
    marginLeft: 1,
    marginRight: 1,
    marginBottom: 1,
    backgroundColor: '#333333',
  })

  const prompt = new TextRenderable(ctx, {
    content: new StyledText([blue('\u25b8 ')]),
  })

  const input = new TextareaRenderable(ctx, {
    flexGrow: 1,
    placeholder: 'Type a message...',
    wrapMode: 'word',
    keyBindings: [
      {name: 'return', action: 'submit'},
      {name: 'linefeed', action: 'submit'},
    ],
    onSubmit: () => {
      const text = input.plainText.trim()
      if (text) {
        onSubmit(text)
        input.setText('')
      }
    },
  })

  box.add(prompt)
  box.add(input)

  return {box, input}
}
