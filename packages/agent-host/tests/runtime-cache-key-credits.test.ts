import { describe, expect, it } from 'vitest'
import {
  createRuntimeCacheKey,
  runtimeCacheKeysMatch,
  type CreateRuntimeCacheKeyInput,
} from '../src/runtime/runtime-cache-key.js'

const owner = {
  userId: 'user-1',
  organizationId: 'organization-1',
  agentId: 'agent-1',
}

function createKey(overrides: Partial<CreateRuntimeCacheKeyInput> = {}) {
  return createRuntimeCacheKey({
    modelId: 'model-1',
    workspaceRoot: '/workspace',
    owner,
    spaceId: 'space-1',
    ...overrides,
  })
}

describe('RuntimeCacheKey — max credits', () => {
  it('stores the normalized max credits supplied by the host', () => {
    const key = createKey({ maxCreditsPerRun: 12.5 })
    expect(key.maxCreditsPerRun).toBe(12.5)
  })

  it('invalidates a runtime when max credits changes', () => {
    expect(runtimeCacheKeysMatch(
      createKey({ maxCreditsPerRun: 10 }),
      createKey({ maxCreditsPerRun: 20 }),
    )).toBe(false)
  })

  it('treats two absent limits as the same cache key', () => {
    expect(runtimeCacheKeysMatch(createKey(), createKey())).toBe(true)
  })
})
