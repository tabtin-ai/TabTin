import { describe, expect, it, vi } from 'vitest'

import { CliRequestContext, type EnvironmentPort } from '../src/transport/cli/cli-context.js'

function memoryEnvironment(initial: Record<string, string> = {}): EnvironmentPort {
  const values = new Map(Object.entries(initial))
  return {
    get: (name) => values.get(name),
    set: (name, value) => value === undefined ? void values.delete(name) : void values.set(name, value),
  }
}

describe('CliRequestContext instance isolation', () => {
  it('keeps mutable request state and environment fallback isolated per server', () => {
    const first = new CliRequestContext(memoryEnvironment({ TABTIN_ORGANIZATION_ID: 'org-env-a' }))
    const second = new CliRequestContext(memoryEnvironment({ TABTIN_ORGANIZATION_ID: 'org-env-b', TABTIN_SPACE_ID: 'space-env-b' }))
    const firstCancel = vi.fn(() => true)

    first.setSpaceId('space-a')
    first.setSubagentCancelResolver(firstCancel)
    first.setWsConnectionInfo({
      serverUrl: 'http://a', wsUrl: 'ws://a', credential: 'token-a',
      organizationId: 'org-a', userId: 'user-a', fingerprint: 'fp-a',
    })

    expect(first.getSpaceId()).toBe('space-a')
    expect(first.getOrganizationId()).toBe('org-a')
    expect(first.getSubagentCancelResolver()?.('child-a')).toBe(true)
    expect(second.getSpaceId()).toBe('space-env-b')
    expect(second.getOrganizationId()).toBe('org-env-b')
    expect(second.getSubagentCancelResolver()).toBeNull()
    expect(second.getWsConnectionInfo()).toBeNull()
  })

  it('updates only the injected environment instead of process.env', () => {
    const original = process.env.TABTIN_SPACE_ID
    const context = new CliRequestContext(memoryEnvironment())
    context.setSpaceId('isolated-space')
    expect(context.getSpaceId()).toBe('isolated-space')
    expect(process.env.TABTIN_SPACE_ID).toBe(original)
  })
})
