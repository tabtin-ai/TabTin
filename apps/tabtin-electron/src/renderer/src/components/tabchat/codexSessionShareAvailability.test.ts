import { describe, expect, it } from 'vitest'
import { isCodexSessionShareAvailable } from './codexSessionShareAvailability'

describe('isCodexSessionShareAvailable', () => {
  it.each([
    ['a9be9847-285c-485e-80a3-dab592b0775d', true],
    ['c4780efc-8059-4b59-a914-e838a114cfeb', true],
    ['self-hosted-organization', true],
    ['', false],
    ['   ', false],
    [null, false],
  ])('allows any valid organization %s', (organizationId, expected) => {
    expect(isCodexSessionShareAvailable(organizationId)).toBe(expected)
  })
})
