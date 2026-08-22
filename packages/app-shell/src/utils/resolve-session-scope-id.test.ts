import { describe, expect, it } from 'vitest'
import { resolveSessionScopeId } from './resolve-session-scope-id.js'

describe('resolveSessionScopeId', () => {
  it('prefers workspace_id when both present', () => {
    expect(
      resolveSessionScopeId({ space_id: 'space-1', workspace_id: 'ws-1' }),
    ).toBe('ws-1')
  })

  it('falls back to space_id when workspace_id absent', () => {
    expect(resolveSessionScopeId({ space_id: 'space-1' })).toBe('space-1')
    expect(resolveSessionScopeId({ workspace_id: null, space_id: 'space-2' })).toBe('space-2')
  })

  it('uses workspace_id alone', () => {
    expect(resolveSessionScopeId({ workspace_id: 'ws-1' })).toBe('ws-1')
    expect(resolveSessionScopeId({ space_id: null, workspace_id: 'ws-2' })).toBe('ws-2')
  })

  it('returns null for empty session', () => {
    expect(resolveSessionScopeId(null)).toBeNull()
    expect(resolveSessionScopeId(undefined)).toBeNull()
    expect(resolveSessionScopeId({})).toBeNull()
    expect(resolveSessionScopeId({ space_id: null, workspace_id: null })).toBeNull()
  })
})
