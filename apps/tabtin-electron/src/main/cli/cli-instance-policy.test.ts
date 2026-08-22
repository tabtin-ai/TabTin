import { describe, expect, it } from 'vitest'

import { resolveCLIInstancePolicy } from './cli-instance-policy'

describe('resolveCLIInstancePolicy', () => {
  it('keeps the primary dev instance globally discoverable', () => {
    expect(resolveCLIInstancePolicy({ isDev: true })).toEqual({
      socketName: 'cli.sock',
      publishGlobalDiscovery: true,
    })
  })

  it('isolates a secondary dev instance without replacing global discovery', () => {
    expect(resolveCLIInstancePolicy({ isDev: true, instanceId: 'im-2' })).toEqual({
      socketName: 'cli-im-2.sock',
      publishGlobalDiscovery: false,
    })
  })

  it('keeps packaged runtimes on the production CLI channel', () => {
    expect(resolveCLIInstancePolicy({ isDev: false, instanceId: 'ignored' })).toEqual({
      socketName: 'electron-cli.sock',
      publishGlobalDiscovery: true,
    })
  })
})
