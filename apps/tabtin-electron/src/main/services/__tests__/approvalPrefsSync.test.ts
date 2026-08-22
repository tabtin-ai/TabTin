/**
 * SIA-4 集成回归：审批偏好 WS 解包 → ApprovalScopeCache.syncFromRemote 端到端契约。
 *
 * 光锁信封形态（见 src/shared/__tests__/approval-prefs-envelope.test.ts）还不够——真正的
 * no-op 点是「解包出来的 map 能不能通过 syncFromRemote 逐项 approved:boolean 过滤、真正
 * 写进 always 缓存」。这里把 unwrapApprovalPreferences 的输出喂进真实 ApprovalScopeCache，
 * 断言其落盘副作用（persistedCount 增加 / isApproved 命中），钉死「修复确实接通了 WS 实时
 * 同步」这个真正的修复点。
 *
 * ApprovalScopeCache → ConfigService 在模块加载即 import electron，故用内存版 configService
 * 替身（仅 get/set——ApprovalScopeCache 只用这两个），让 syncFromRemote 真正读写、可断言。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { unwrapApprovalPreferences } from '@shared/approval-prefs-envelope'

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}))

vi.mock('../ConfigService', () => {
  const store: Record<string, unknown> = {}
  return {
    configService: {
      get: (key: string) => store[key],
      set: (key: string, value: unknown) => {
        store[key] = value
      },
    },
  }
})

import { approvalScopeCache, type ScopeEntry } from '../ApprovalScopeCache'

describe('SIA-4 集成：approval WS unwrap → syncFromRemote 契约', () => {
  beforeEach(() => {
    approvalScopeCache.clearAll()
  })

  it('解包出的扁平 preferences 通过 approved:boolean 过滤并真正写入 always 缓存（merged>0）', () => {
    // 模拟后端 _broadcast_approval_preferences_changed 的 WS 信封：
    // build_envelope("approval_preferences_changed", id, {"data": preferences})
    const envelope = {
      type: 'approval_preferences_changed',
      payload: {
        data: {
          execute_in_terminal: { approved: true, updatedAt: Date.now() },
          'write_file:src/components': { approved: true, updatedAt: Date.now() },
        },
      },
    }

    const preferences = unwrapApprovalPreferences(envelope)
    expect(preferences).not.toBeNull()

    // 喂进真实 ApprovalScopeCache.syncFromRemote（返回 void，断言其落盘副作用）。
    const before = approvalScopeCache.getStats().persistedCount
    approvalScopeCache.syncFromRemote(preferences as Record<string, ScopeEntry>)
    const after = approvalScopeCache.getStats().persistedCount

    // merged>0：两条 approved=true 条目真正落进 always 缓存——实时同步接通的直接证据。
    expect(after - before).toBe(2)
    expect(approvalScopeCache.isApproved('execute_in_terminal')).toBe(true)
    expect(approvalScopeCache.getAlwaysPreferences()['write_file:src/components']?.approved).toBe(true)
  })

  it('对照（旧 bug 形态）：多包一层的 {data:preferences} 被逐项 approved 校验全拒（merged=0，复现 no-op）', () => {
    // 旧 `envelope.data ?? envelope.payload` 取到的正是这个 {data: preferences}——它唯一的
    // key 'data' 的 value 没有 approved:boolean，syncFromRemote 整条 continue 跳过 → 不写缓存。
    const doubleWrapped = {
      data: {
        execute_in_terminal: { approved: true, updatedAt: Date.now() },
      },
    }
    const before = approvalScopeCache.getStats().persistedCount
    approvalScopeCache.syncFromRemote(doubleWrapped as unknown as Record<string, ScopeEntry>)
    const after = approvalScopeCache.getStats().persistedCount

    expect(after - before).toBe(0)
    expect(approvalScopeCache.isApproved('execute_in_terminal')).toBe(false)
  })
})
