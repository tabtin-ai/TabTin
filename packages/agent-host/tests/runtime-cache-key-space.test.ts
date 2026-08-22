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

describe('RuntimeCacheKey — spaceId', () => {
  it('keeps spaceId in the normalized cache key', () => {
    expect(createKey().spaceId).toBe('space-1')
  })

  it('invalidates a runtime when the active Space changes', () => {
    expect(runtimeCacheKeysMatch(
      createKey(),
      createKey({ spaceId: 'space-2' }),
    )).toBe(false)
  })

  it('reuses a runtime when all baked fields are unchanged', () => {
    expect(runtimeCacheKeysMatch(createKey(), createKey())).toBe(true)
  })
})
