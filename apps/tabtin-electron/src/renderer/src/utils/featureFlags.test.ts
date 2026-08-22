import { describe, expect, it } from 'vitest'
import { isRuntimeVersionDetailsEnabled } from './featureFlags'

describe('isRuntimeVersionDetailsEnabled', () => {
  it.each(['development', 'preprod'])('keeps runtime details for %s builds', (profile) => {
    expect(isRuntimeVersionDetailsEnabled(profile)).toBe(true)
  })

  it('hides runtime details for production builds', () => {
    expect(isRuntimeVersionDetailsEnabled('production')).toBe(false)
  })
})
