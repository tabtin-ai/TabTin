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

describe('RuntimeCacheKey — layered rules', () => {
  it('normalizes custom and personal rules', () => {
    const key = createKey({
      customRules: '  agent rule  ',
      personalRules: '  personal rule  ',
    })
    expect(key.customRules).toBe('agent rule')
    expect(key.personalRules).toBe('personal rule')
  })

  it('invalidates a runtime when personal rules change', () => {
    expect(runtimeCacheKeysMatch(
      createKey({ personalRules: 'rule-a' }),
      createKey({ personalRules: 'rule-b' }),
    )).toBe(false)
  })

  it('treats blank rules as absent', () => {
    expect(runtimeCacheKeysMatch(
      createKey({ customRules: '  ', personalRules: '\n' }),
      createKey(),
    )).toBe(true)
  })
})
