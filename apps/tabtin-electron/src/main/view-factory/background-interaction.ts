import type { ViewFactoryConfig } from './types'

export const AGENT_BACKGROUND_INTERACTIVE_BOUNDS = { x: -10000, y: -10000, width: 1280, height: 720 } as const

export function withAgentBackgroundInteraction(config: ViewFactoryConfig): Partial<ViewFactoryConfig> {
  if (!config.runId) {
    return {}
  }

  return {
    bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS,
    metadata: {
      ...config.metadata,
      agentBackgroundInteractive: true,
    },
  }
}

export function shouldHideAgentBackgroundInteraction(
  config: Pick<ViewFactoryConfig, 'autoClose' | 'bounds' | 'metadata'>,
  currentBounds: ViewFactoryConfig['bounds'] = config.bounds,
): boolean {
  return (
    config.autoClose === false &&
    config.metadata?.agentBackgroundInteractive === true &&
    sameBounds(currentBounds, AGENT_BACKGROUND_INTERACTIVE_BOUNDS)
  )
}

function sameBounds(
  bounds: ViewFactoryConfig['bounds'],
  expected: typeof AGENT_BACKGROUND_INTERACTIVE_BOUNDS,
): boolean {
  return (
    bounds?.x === expected.x &&
    bounds?.y === expected.y &&
    bounds?.width === expected.width &&
    bounds?.height === expected.height
  )
}
