import { describe, expect, it } from 'vitest'
import { resolveContextNavigationStorageKey } from '../useSpaceContextNavigation'

describe('resolveContextNavigationStorageKey', () => {
  it('优先使用显式 tabScopeKey，避免 desktop/conversation 串桶', () => {
    expect(resolveContextNavigationStorageKey(
      'execution-space-1',
      'desktop:organization:org-1:user:u-1',
    )).toBe('desktop:organization:org-1:user:u-1')

    expect(resolveContextNavigationStorageKey(
      'execution-space-1',
      'conversation:session-1',
    )).toBe('conversation:session-1')
  })

  it('缺省时回落 execution spaceId（兼容旧调用）', () => {
    expect(resolveContextNavigationStorageKey('execution-space-1')).toBe('execution-space-1')
    expect(resolveContextNavigationStorageKey('execution-space-1', null)).toBe('execution-space-1')
    expect(resolveContextNavigationStorageKey('execution-space-1', '')).toBe('execution-space-1')
  })
})
