/**
 * ：生效审批档进程内共享上下文单测。
 *
 * 覆盖三个易错边界：
 * 1. 三档旁路语义——普通 confirm（auto/full 旁路）与本机安全底线（仅 full 旁路）分层。
 * 2. thread 别名归一——host 写 sessionId、消费方读 `_thread_id`（带/不带
 *    `chat-session-` 前缀）要能互相命中。
 * 3. 空值与生命周期——undefined/空串不旁路；clear 后回到不旁路。
 */
import { describe, expect, it, beforeEach } from 'vitest'
import {
  setThreadEffectiveApprovalMode,
  clearThreadEffectiveApprovalMode,
  getThreadEffectiveApprovalMode,
  shouldBypassConfirmApproval,
  shouldBypassSecurityFloorApproval,
} from '../approval-mode-context'

const THREAD = 'thread-approval-ctx-test'

describe('approval-mode-context', () => {
  beforeEach(() => {
    clearThreadEffectiveApprovalMode(THREAD)
  })

  describe('三档旁路语义', () => {
    it('always_ask：confirm 与安全底线均不旁路', () => {
      setThreadEffectiveApprovalMode(THREAD, 'always_ask')
      expect(shouldBypassConfirmApproval(THREAD)).toBe(false)
      expect(shouldBypassSecurityFloorApproval(THREAD)).toBe(false)
    })

    it('auto：旁路普通 confirm，但不旁路安全底线（judge「risk 级 auto 转 ask」同款）', () => {
      setThreadEffectiveApprovalMode(THREAD, 'auto')
      expect(shouldBypassConfirmApproval(THREAD)).toBe(true)
      expect(shouldBypassSecurityFloorApproval(THREAD)).toBe(false)
    })

    it('full_access：confirm 与安全底线均旁路', () => {
      setThreadEffectiveApprovalMode(THREAD, 'full_access')
      expect(shouldBypassConfirmApproval(THREAD)).toBe(true)
      expect(shouldBypassSecurityFloorApproval(THREAD)).toBe(true)
    })
  })

  describe('thread 别名归一', () => {
    it('写带 chat-session- 前缀，读裸 id 命中', () => {
      setThreadEffectiveApprovalMode(`chat-session-${THREAD}`, 'auto')
      expect(getThreadEffectiveApprovalMode(THREAD)).toBe('auto')
      clearThreadEffectiveApprovalMode(`chat-session-${THREAD}`)
    })

    it('写裸 id，读带前缀命中；clear 双向清干净', () => {
      setThreadEffectiveApprovalMode(THREAD, 'full_access')
      expect(getThreadEffectiveApprovalMode(`chat-session-${THREAD}`)).toBe('full_access')
      clearThreadEffectiveApprovalMode(`chat-session-${THREAD}`)
      expect(getThreadEffectiveApprovalMode(THREAD)).toBeUndefined()
    })
  })

  describe('空值与生命周期', () => {
    it('undefined / null / 空串 / 未发布 thread 一律不旁路', () => {
      expect(shouldBypassConfirmApproval(undefined)).toBe(false)
      expect(shouldBypassConfirmApproval(null)).toBe(false)
      expect(shouldBypassConfirmApproval('')).toBe(false)
      expect(shouldBypassConfirmApproval('never-set-thread')).toBe(false)
      expect(shouldBypassSecurityFloorApproval(undefined)).toBe(false)
    })

    it('clear 后回到不旁路（session 销毁生命周期）', () => {
      setThreadEffectiveApprovalMode(THREAD, 'full_access')
      expect(shouldBypassConfirmApproval(THREAD)).toBe(true)
      clearThreadEffectiveApprovalMode(THREAD)
      expect(shouldBypassConfirmApproval(THREAD)).toBe(false)
      expect(getThreadEffectiveApprovalMode(THREAD)).toBeUndefined()
    })

    it('覆盖写入取最新值', () => {
      setThreadEffectiveApprovalMode(THREAD, 'full_access')
      setThreadEffectiveApprovalMode(THREAD, 'always_ask')
      expect(shouldBypassConfirmApproval(THREAD)).toBe(false)
    })
  })
})
