import {BoxRenderable, TextRenderable, StyledText, green, yellow, white} from '@opentui/core'

export type Mode = 'plan' | 'build'
export type UiMode = 'dev' | 'production'

export interface HeaderComponent {
  box: BoxRenderable
  setMode(mode: Mode): void
  setAgentName(name: string): void
}

export function createHeader(ctx: any, agentName: string, initialMode: Mode, uiMode: UiMode): HeaderComponent {
  const isProduction = uiMode === 'production'
  const backgroundColor = isProduction ? '#10B981' : '#8B5CF6'

  const box = new BoxRenderable(ctx, {
    width: '100%',
    height: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexShrink: 0,
    paddingLeft: 1,
    paddingRight: 1,
    backgroundColor,
  })

  const nameText = new TextRenderable(ctx, {
    content: new StyledText([white('\u25cf '), white(agentName)]),
  })

  const modeText = new TextRenderable(ctx, {
    content: createModeStyledText(initialMode, isProduction),
  })

  box.add(nameText)
  box.add(modeText)

  function setMode(mode: Mode) {
    modeText.content = createModeStyledText(mode, isProduction)
  }

  function setAgentName(name: string) {
    nameText.content = new StyledText([white('\u25cf '), white(name)])
  }

  return {box, setMode, setAgentName}
}

function createModeStyledText(mode: Mode, isProduction: boolean): StyledText {
  if (isProduction) {
    return new StyledText([white('[\u25cf LIVE]')])
  }

  if (mode === 'plan') {
    return new StyledText([green('[PLAN]')])
  }

  return new StyledText([yellow('[BUILD]')])
}
