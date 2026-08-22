import { describe, expect, it } from 'vitest'

import {
  AGENT_BACKGROUND_INTERACTIVE_BOUNDS,
  shouldHideAgentBackgroundInteraction,
  withAgentBackgroundInteraction,
} from '../background-interaction'

describe('agent background interaction', () => {
  it('adds offscreen interactive bounds only for a run view', () => {
    expect(withAgentBackgroundInteraction({ id: 'run-view', profile: 'agent-workspace', runId: 'run-1' })).toMatchObject({
      bounds: { x: -10000, y: -10000, width: 1280, height: 720 },
      metadata: { agentBackgroundInteractive: true },
    })
    expect(withAgentBackgroundInteraction({ id: 'normal-view', profile: 'agent-workspace' })).toEqual({})
    expect(withAgentBackgroundInteraction({ id: 'empty-run-view', profile: 'agent-workspace', runId: '' })).toEqual({})
  })

  it('preserves existing metadata when enabling background interaction', () => {
    const config = {
      id: 'view-1',
      profile: 'agent-workspace',
      runId: 'run-1',
      metadata: { crawlspaceId: 'cs-1' },
    } as const

    expect(withAgentBackgroundInteraction(config)).toEqual({
      bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS,
      metadata: {
        crawlspaceId: 'cs-1',
        agentBackgroundInteractive: true,
      },
    })
  })

  it('hides only marked non-auto-closing views with the dedicated bounds', () => {
    expect(shouldHideAgentBackgroundInteraction({ autoClose: false, bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS, metadata: { agentBackgroundInteractive: true } })).toBe(true)
    expect(shouldHideAgentBackgroundInteraction({ autoClose: false, bounds: { x: 0, y: 0, width: 1280, height: 720 }, metadata: { agentBackgroundInteractive: true } })).toBe(false)
    expect(shouldHideAgentBackgroundInteraction({ autoClose: false, bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS })).toBe(false)
    expect(shouldHideAgentBackgroundInteraction({ autoClose: false, bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS, metadata: { agentBackgroundInteractive: false } })).toBe(false)
    expect(shouldHideAgentBackgroundInteraction({ autoClose: true, bounds: AGENT_BACKGROUND_INTERACTIVE_BOUNDS, metadata: { agentBackgroundInteractive: true } })).toBe(false)
    expect(shouldHideAgentBackgroundInteraction({ autoClose: false, bounds: { x: -10000, y: -9999, width: 1280, height: 720 }, metadata: { agentBackgroundInteractive: true } })).toBe(false)
    expect(shouldHideAgentBackgroundInteraction({ autoClose: false, bounds: { x: -10000, y: -10000, width: 1279, height: 720 }, metadata: { agentBackgroundInteractive: true } })).toBe(false)
    expect(shouldHideAgentBackgroundInteraction({ autoClose: false, bounds: { x: -10000, y: -10000, width: 1280, height: 719 }, metadata: { agentBackgroundInteractive: true } })).toBe(false)
  })
})
