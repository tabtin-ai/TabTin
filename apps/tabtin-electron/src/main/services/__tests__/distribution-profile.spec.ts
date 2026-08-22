import { describe, expect, it } from 'vitest'

import { resolveDistributionProfile } from '../distribution-profile'

describe('distribution profile', () => {
  it('community trusts only its declared API and disables updater by default', () => {
    const profile = resolveDistributionProfile({
      kind: 'community',
      apiBaseUrl: 'https://api.example.org/api',
    })

    expect(profile.apiOrigins).toEqual(['https://api.example.org'])
    expect(profile.updater).toEqual({ enabled: false })
  })

  it('community updater trusts only the feed origin declared at build time', () => {
    const profile = resolveDistributionProfile({
      kind: 'community',
      apiBaseUrl: 'https://api.example.org/api',
      updateFeedUrl: 'https://downloads.example.org/desktop/stable',
    })

    expect(profile.updater).toEqual({
      enabled: true,
      feedOrigin: 'https://downloads.example.org',
    })
  })

  it.each([
    'file:///etc/passwd',
    'https://user:password@api.example.org/api', // open-source-audit: allow credential-url
    'http://169.254.169.254/latest/meta-data',
    'http://metadata.google.internal/computeMetadata/v1',
  ])('rejects blocked origin %s', (apiBaseUrl) => {
    expect(() => resolveDistributionProfile({ kind: 'community', apiBaseUrl }))
      .toThrow(/blocked origin/)
  })

  it('allows a private self-hosted API only when it is the declared community API', () => {
    const profile = resolveDistributionProfile({
      kind: 'community',
      apiBaseUrl: 'http://192.168.1.20:6060/api',
    })

    expect(profile.apiOrigins).toEqual(['http://192.168.1.20:6060'])
  })
})
