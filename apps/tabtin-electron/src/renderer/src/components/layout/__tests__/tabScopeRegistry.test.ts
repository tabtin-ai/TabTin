import { describe, expect, it } from 'vitest'
import { isPersistedWorkspaceScopeKey } from '../tabScopeRegistry'

describe('tabScopeRegistry', () => {
  it('retains desktop, conversation, im, and cloud-docs persisted scopes', () => {
    expect(isPersistedWorkspaceScopeKey('desktop:organization:org-1:user:user-1')).toBe(true)
    expect(isPersistedWorkspaceScopeKey('conversation:session-1')).toBe(true)
    expect(isPersistedWorkspaceScopeKey('im:conv-1')).toBe(true)
    expect(isPersistedWorkspaceScopeKey('cloud-docs:organization:org-1:user:user-1')).toBe(true)
    expect(isPersistedWorkspaceScopeKey('space-uuid-only')).toBe(false)
  })
})
