import { describe, expect, it } from 'vitest'

import { resolveTabTinResourceScheme } from '../src/environment.js'

describe('resolveTabTinResourceScheme', () => {
  it.each([
    ['https://api.example.com/api', 'production', 'tabtin'],
    ['https://api-test.example.com/api', 'preprod', 'tabtin-preprod'],
    ['https://api-test.example.com/api', 'development', 'tabtin-preprod'],
    ['http://127.0.0.1:6060/api', 'development', 'tabtin-dev'],
    ['http://localhost:6060/api', 'development', 'tabtin-dev'],
    ['http://[::1]:6060/api', 'development', 'tabtin-dev'],
    ['http://192.168.1.20:6060/api', 'local', 'tabtin-dev'],
    ['https://custom.example.com/api', 'preprod', 'tabtin-preprod'],
    ['https://custom.example.com/api', 'production', 'tabtin'],
  ] as const)(
    'maps data source %s with profile %s to %s',
    (apiBaseUrl, buildProfile, expected) => {
      expect(resolveTabTinResourceScheme({ apiBaseUrl, buildProfile })).toBe(
        expected,
      )
    },
  )

  it('never emits the local package protocol', () => {
    expect(
      resolveTabTinResourceScheme({
        apiBaseUrl: 'http://127.0.0.1:6060/api',
        buildProfile: 'local',
      }),
    ).not.toBe('tabtin-local')
  })
})
