import { describe, expect, it } from 'vitest'
import {
  gateRestoreResultForScope,
  isRestoreGenerationCurrent,
} from '../restoreScope'

describe('restore scope generation', () => {
  const sessionA = {
    spaceId: 'space-1',
    scopeKey: 'conversation:session-a',
    scopeVersion: 1,
  } as const

  it('rejects a settled result from an older session scope', () => {
    const generation = {
      ...sessionA,
      sequence: 7,
    }

    expect(isRestoreGenerationCurrent(generation, {
      ...sessionA,
      scopeKey: 'conversation:session-b',
    })).toBe(false)
  })

  it('rejects a previously visited scope after a rapid switch back', () => {
    const generation = {
      ...sessionA,
      sequence: 7,
    }

    expect(isRestoreGenerationCurrent(generation, {
      ...sessionA,
      scopeVersion: 3,
    })).toBe(false)
  })

  it('hides stale surface and active-view decisions until the current scope settles', () => {
    const gated = gateRestoreResultForScope(
      {
        restoreSettled: true,
        desiredActiveViewId: 'view-a',
        activeSurface: 'desktop',
        generation: {
          ...sessionA,
          sequence: 7,
        },
        lastDecision: { activeSurface: 'desktop' } as never,
      },
      {
        ...sessionA,
        scopeKey: 'conversation:session-b',
      },
    )

    expect(gated.restoreSettled).toBe(false)
    expect(gated.desiredActiveViewId).toBeNull()
    expect(gated.activeSurface).toBe('real_tab')
    expect(gated.lastDecision).toBeNull()
    expect(gated.generation).toEqual({
      ...sessionA,
      scopeKey: 'conversation:session-b',
      sequence: 7,
    })
  })
})
