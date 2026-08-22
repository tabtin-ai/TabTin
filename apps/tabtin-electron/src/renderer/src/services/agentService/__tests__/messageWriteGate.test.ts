/**
 * messageWriteGate.test.ts —  消息写入门控契约。
 *
 * 锁定三个不变量：
 * 1. epoch 门控：服务端 sync 发起后、写回前发生本地结构性变更（回退截断）→ 写回丢弃，
 *    被回退消息不能经迟到写回复活（ 打包版复现时序）。
 * 2. restoring 互斥：回退管线进行中，任何服务端写回丢弃。
 * 3. 自发回退广播抑制：发起端登记的期望被 FIFO 消费一次；无登记（观察端）不抑制；
 *    过期期望不误吞后续广播。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  __resetMessageWriteGateForTest,
  commitServerMerge,
  consumeSelfRollbackBroadcast,
  expectSelfRollbackBroadcast,
  getMessagesEpoch,
  isSessionRestoring,
  recordStructuralMutation,
  registerRestoringSessionProvider,
} from '../messageWriteGate'

const SESSION = 'session-2822'

describe('#2822 messageWriteGate', () => {
  beforeEach(() => {
    __resetMessageWriteGateForTest()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('epoch 门控', () => {
    it('无结构性变更时写回照常提交', () => {
      const fetchEpoch = getMessagesEpoch(SESSION)
      const apply = vi.fn()
      expect(commitServerMerge(SESSION, fetchEpoch, apply)).toBe('committed')
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('#2822 复现时序：sync 发起 → 回退截断 → 写回被丢弃，消息不复活', () => {
      // sync 发起（fetch 前捕获 epoch）
      const fetchEpoch = getMessagesEpoch(SESSION)
      // fetch 在途期间回退管线完成本地截断
      recordStructuralMutation(SESSION, 'rollback-truncate')
      // 迟到的写回必须被丢弃
      const apply = vi.fn()
      expect(commitServerMerge(SESSION, fetchEpoch, apply)).toBe('stale-epoch')
      expect(apply).not.toHaveBeenCalled()
    })

    it('截断后新发起的 sync（携带新 epoch）可以正常写回', () => {
      recordStructuralMutation(SESSION, 'rollback-truncate')
      const fetchEpoch = getMessagesEpoch(SESSION)
      const apply = vi.fn()
      expect(commitServerMerge(SESSION, fetchEpoch, apply)).toBe('committed')
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('epoch 按 session 隔离，不跨会话误伤', () => {
      const otherEpoch = getMessagesEpoch('session-other')
      recordStructuralMutation(SESSION, 'rollback-truncate')
      const apply = vi.fn()
      expect(commitServerMerge('session-other', otherEpoch, apply)).toBe('committed')
      expect(apply).toHaveBeenCalledTimes(1)
    })
  })

  describe('restoring 互斥', () => {
    it('回退管线进行中写回丢弃；结束后恢复', () => {
      let restoring = true
      registerRestoringSessionProvider((sid) => restoring && sid === SESSION)

      const fetchEpoch = getMessagesEpoch(SESSION)
      const apply = vi.fn()
      expect(commitServerMerge(SESSION, fetchEpoch, apply)).toBe('restoring')
      expect(apply).not.toHaveBeenCalled()

      restoring = false
      expect(commitServerMerge(SESSION, fetchEpoch, apply)).toBe('committed')
      expect(apply).toHaveBeenCalledTimes(1)
    })

    it('provider 未注册（测试 / 纯远程形态）视为非 restoring', () => {
      expect(isSessionRestoring(SESSION)).toBe(false)
    })
  })

  describe('自发回退广播抑制', () => {
    it('发起端登记后首条广播被消费，第二条不再抑制', () => {
      expectSelfRollbackBroadcast(SESSION)
      expect(consumeSelfRollbackBroadcast(SESSION)).toBe(true)
      expect(consumeSelfRollbackBroadcast(SESSION)).toBe(false)
    })

    it('观察端（无登记）不抑制', () => {
      expect(consumeSelfRollbackBroadcast(SESSION)).toBe(false)
    })

    it('两次回退登记两条期望，FIFO 各消费一次', () => {
      expectSelfRollbackBroadcast(SESSION)
      expectSelfRollbackBroadcast(SESSION)
      expect(consumeSelfRollbackBroadcast(SESSION)).toBe(true)
      expect(consumeSelfRollbackBroadcast(SESSION)).toBe(true)
      expect(consumeSelfRollbackBroadcast(SESSION)).toBe(false)
    })

    it('过期期望不误吞后续广播（WS 事件丢失泄漏兜底）', () => {
      vi.useFakeTimers()
      expectSelfRollbackBroadcast(SESSION)
      // 越过 TTL（5 分钟）后，遗留期望应被清除而不是吞掉他端发起的广播
      vi.advanceTimersByTime(5 * 60_000 + 1)
      expect(consumeSelfRollbackBroadcast(SESSION)).toBe(false)
    })
  })
})
