import { describe, expect, it } from 'vitest'

import { resolveSentryEnvironment } from './sentry-environment'

describe('resolveSentryEnvironment', () => {
  it.each(['development', 'local', 'preprod'] as const)('%s profile reports to test-new', (profile) => {
    expect(resolveSentryEnvironment(profile)).toBe('test-new')
  })

  it('production profile reports to production', () => {
    expect(resolveSentryEnvironment('production')).toBe('production')
  })
})
