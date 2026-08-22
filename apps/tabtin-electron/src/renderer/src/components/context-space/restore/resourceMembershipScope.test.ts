import { describe, expect, it } from 'vitest'
import { resolveRestoreResourceMembershipCacheKey } from './resourceMembershipScope'

describe('resolveRestoreResourceMembershipCacheKey', () => {
  it('桌面工作台使用组织级资源索引，避免跨 Space 资源被误判为 stale', () => {
    expect(resolveRestoreResourceMembershipCacheKey(
      'desktop:organization:org-1:user:user-1',
      'execution-space-1',
    )).toBe('execution-space-1:organization')
  })

  it('云文档一级域同样使用组织级资源索引', () => {
    expect(resolveRestoreResourceMembershipCacheKey(
      'cloud-docs:organization:org-1:user:user-1',
      'execution-space-1',
    )).toBe('execution-space-1:organization')
  })

  it('会话 / IM 隔离桶使用组织级资源索引', () => {
    expect(resolveRestoreResourceMembershipCacheKey(
      'conversation:session-1',
      'execution-space-1',
    )).toBe('execution-space-1:organization')
    expect(resolveRestoreResourceMembershipCacheKey(
      'conversation:draft:execution-space-1',
      'execution-space-1',
    )).toBe('execution-space-1:organization')
    expect(resolveRestoreResourceMembershipCacheKey(
      'im:conversation-42',
      'execution-space-1',
    )).toBe('execution-space-1:organization')
  })

  it('非桌面 / 非云文档 / 非隔离桶仍用执行 Space 索引', () => {
    expect(resolveRestoreResourceMembershipCacheKey(
      'space-execution-1',
      'execution-space-1',
    )).toBe('execution-space-1')
  })
})
