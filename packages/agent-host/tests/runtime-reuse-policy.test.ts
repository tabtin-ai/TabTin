import { describe, expect, it } from 'vitest'
import { decideRuntimeReuse } from '../src/runtime/runtime-reuse-policy.js'

describe('decideRuntimeReuse', () => {
  it('rebuilds when no existing session', () => {
    expect(
      decideRuntimeReuse({
        hasExisting: false,
        bakedFieldsMatch: true,
        agentModeMatches: true,
        softReconfigureAllowed: true,
      }),
    ).toEqual({ kind: 'rebuild' })
  })

  it('reuses when baked fields and agentMode match', () => {
    expect(
      decideRuntimeReuse({
        hasExisting: true,
        bakedFieldsMatch: true,
        agentModeMatches: true,
        softReconfigureAllowed: false,
      }),
    ).toEqual({ kind: 'reuse' })
  })

  it('soft-reconfigures when only mode changed and host allows it', () => {
    expect(
      decideRuntimeReuse({
        hasExisting: true,
        bakedFieldsMatch: true,
        agentModeMatches: false,
        softReconfigureAllowed: true,
      }),
    ).toEqual({ kind: 'soft-reconfigure' })
  })

  it('rebuilds on mode change when soft-reconfigure is disallowed', () => {
    expect(
      decideRuntimeReuse({
        hasExisting: true,
        bakedFieldsMatch: true,
        agentModeMatches: false,
        softReconfigureAllowed: false,
      }),
    ).toEqual({ kind: 'rebuild' })
  })

  it('rebuilds when baked fields or extra host fields mismatch', () => {
    expect(
      decideRuntimeReuse({
        hasExisting: true,
        bakedFieldsMatch: false,
        agentModeMatches: true,
        softReconfigureAllowed: true,
      }),
    ).toEqual({ kind: 'rebuild' })

    expect(
      decideRuntimeReuse({
        hasExisting: true,
        bakedFieldsMatch: true,
        agentModeMatches: true,
        softReconfigureAllowed: true,
        extraFieldsMatch: false,
      }),
    ).toEqual({ kind: 'rebuild' })
  })
})
