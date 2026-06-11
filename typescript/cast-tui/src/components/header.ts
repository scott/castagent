import {BoxRenderable, TextRenderable, StyledText, green, yellow, white} from '@opentui/core'

export type Mode = 'plan' | 'build'
export type UiMode = 'dev' | 'production'

export interface HeaderComponent {
  box: BoxRenderable
  setMode(mode: Mode): void
  setAgentName(name: string): void
  setUiMode(mode: UiMode): void
  setDeployedVersion(version: string | null): void
}

export function createHeader(
  ctx: any,
  agentName: string,
  initialMode: Mode,
  uiMode: UiMode,
  deployedVersion?: string | null,
): HeaderComponent {
  const isProduction = uiMode === 'production'
  const backgroundColor = isProduction ? '#10B981' : '#8B5CF6'
  let currentMode: Mode = initialMode
  let currentDeployedVersion: string | null = deployedVersion ?? null

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
    content: createNameStyledText(agentName, currentDeployedVersion),
  })

  const modeText = new TextRenderable(ctx, {
    content: createModeStyledText(initialMode, isProduction),
  })

  box.add(nameText)
  box.add(modeText)

  function setMode(mode: Mode) {
    currentMode = mode
    modeText.content = createModeStyledText(mode, isProduction)
  }

  function setAgentName(name: string) {
    nameText.content = createNameStyledText(name, currentDeployedVersion)
  }

  function setUiMode(newUiMode: UiMode) {
    const newIsProduction = newUiMode === 'production'
    // Note: Background color cannot be changed dynamically after creation
    // The mode text will still update to show [● LIVE] in production
    modeText.content = createModeStyledText(currentMode, newIsProduction)
  }

  function setDeployedVersion(version: string | null) {
    currentDeployedVersion = version
    nameText.content = createNameStyledText(agentName, version)
  }

  return {box, setMode, setAgentName, setUiMode, setDeployedVersion}
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

function createNameStyledText(agentName: string, deployedVersion: string | null): StyledText {
  const parts = [white('\u25cf '), white(agentName)]
  if (deployedVersion !== null) {
    parts.push(white(` (v${deployedVersion})`))
  }
  return new StyledText(parts)
}
