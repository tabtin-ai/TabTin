import { describe, expect, it } from 'vitest'
import {
  canSoftReconfigureByShellTier,
  disabledAppsExtraKeysMatch,
  executionOwnerScopeId,
  normalizeDisabledAppsExtraKey,
} from '../src/runtime/index.js'

describe('runtime parity policies', () => {
  it('allows soft-reconfigure within the same shell tier', () => {
    expect(canSoftReconfigureByShellTier('plan', 'study')).toBe(true)
    expect(canSoftReconfigureByShellTier('agent', 'yolo')).toBe(true)
    expect(canSoftReconfigureByShellTier('group', 'agent')).toBe(true)
  })

  it('requires rebuild when shell restriction tier changes', () => {
    expect(canSoftReconfigureByShellTier('ask', 'agent')).toBe(false)
    expect(canSoftReconfigureByShellTier('agent', 'plan')).toBe(false)
    expect(canSoftReconfigureByShellTier('study', 'yolo')).toBe(false)
  })

  it('matches disabledApps extra keys for Electron/Daemon parity', () => {
    expect(
      disabledAppsExtraKeysMatch(
        normalizeDisabledAppsExtraKey(['tabdoc'], ['tabdoc.']),
        normalizeDisabledAppsExtraKey(['tabdoc'], ['tabdoc.']),
      ),
    ).toBe(true)
    expect(
      disabledAppsExtraKeysMatch(
        normalizeDisabledAppsExtraKey(['tabdoc'], []),
        normalizeDisabledAppsExtraKey([], ['tabdoc.']),
      ),
    ).toBe(false)
    expect(
      disabledAppsExtraKeysMatch(undefined, normalizeDisabledAppsExtraKey()),
    ).toBe(true)
  })

  it('derives owner scope id as `userId|organizationId` (agentId is not part of the barrier)', () => {
    // 契约锁死：owner scope id 是 host lifecycle 与 runtime factory / delivery outbox
    // 共享的账号闸门 key。任何一端把 agentId 拼进 scope id 都会让"账号级
    // reset / quiesce"错杀 agent，或反过来漏杀。两端 host 都必须走本函数派生。
    expect(executionOwnerScopeId({
      userId: 'user-1', organizationId: 'org-1', agentId: 'agent-1',
    })).toBe('user-1|org-1')
    expect(executionOwnerScopeId({
      userId: 'user-1', organizationId: 'org-1', agentId: 'agent-2',
    })).toBe('user-1|org-1')
    // agentId 缺失也一样：owner scope 与 agent 无关。
    expect(executionOwnerScopeId({
      userId: 'user-1', organizationId: 'org-1', agentId: undefined,
    })).toBe('user-1|org-1')
    // 换 organization 立即换 scope（跨租户隔离）。
    expect(executionOwnerScopeId({
      userId: 'user-1', organizationId: 'org-2', agentId: 'agent-1',
    })).toBe('user-1|org-2')
  })
})
