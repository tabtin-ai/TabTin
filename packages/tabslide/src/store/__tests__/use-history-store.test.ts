/**
 * useHistoryStore 单元测试
 *
 * 覆盖范围（TC-06）：
 * - undo / redo 基本功能
 * - pushSnapshotDebounced debounce 行为（leading-edge）
 * - redo 栈在新操作后清空
 * - MAX_HISTORY 深度限制（50）
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useHistoryStore } from '../history'
import type { Slide } from '../../types/slides'

// ── 测试辅助 ────────────────────────────────────────────────────

const makePages = (label: string, count = 1): Slide[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${label}_page_${i}`,
    elements: [],
    background: { type: 'solid' as const, color: '#ffffff' },
  }))

const resetStore = () => {
  useHistoryStore.getState().setCollabUndoRedo(null)
  useHistoryStore.getState().clear()
}

// ═══════════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════════

describe('useHistoryStore', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetStore()
  })

  afterEach(() => {
    vi.useRealTimers()
    resetStore()
  })

  // ─── 初始状态 ────────────────────────────────────────────────

  describe('初始状态', () => {
    it('undoStack 和 redoStack 均为空', () => {
      const s = useHistoryStore.getState()
      expect(s.undoStack).toHaveLength(0)
      expect(s.redoStack).toHaveLength(0)
    })

    it('初始 canUndo / canRedo 均为 false', () => {
      const s = useHistoryStore.getState()
      expect(s.canUndo()).toBe(false)
      expect(s.canRedo()).toBe(false)
    })
  })

  // ─── pushSnapshot ────────────────────────────────────────────

  describe('pushSnapshot', () => {
    it('push 一次后 undoStack 长度为 1', () => {
      const pages = makePages('v1')
      useHistoryStore.getState().pushSnapshot(pages)
      expect(useHistoryStore.getState().undoStack).toHaveLength(1)
      expect(useHistoryStore.getState().canUndo()).toBe(true)
    })

    it('同一引用重复 push 不增加 undoStack', () => {
      const pages = makePages('v1')
      useHistoryStore.getState().pushSnapshot(pages)
      useHistoryStore.getState().pushSnapshot(pages)
      expect(useHistoryStore.getState().undoStack).toHaveLength(1)
    })

    it('不同引用的 push 会增加 undoStack', () => {
      useHistoryStore.getState().pushSnapshot(makePages('v1'))
      useHistoryStore.getState().pushSnapshot(makePages('v2'))
      expect(useHistoryStore.getState().undoStack).toHaveLength(2)
    })

    it('push 新快照会清空 redoStack', () => {
      const pages_a = makePages('a')
      const pages_b = makePages('b')
      const pages_c = makePages('c')

      useHistoryStore.getState().pushSnapshot(pages_a)
      useHistoryStore.getState().pushSnapshot(pages_b)
      // undo 后 redoStack 有数据
      useHistoryStore.getState().undo(pages_b)
      expect(useHistoryStore.getState().redoStack).toHaveLength(1)

      // 推入新快照 → redoStack 清空
      useHistoryStore.getState().pushSnapshot(pages_c)
      expect(useHistoryStore.getState().redoStack).toHaveLength(0)
    })
  })

  // ─── undo ────────────────────────────────────────────────────

  describe('undo', () => {
    it('undo 返回上一个快照', () => {
      const pagesV1 = makePages('v1')
      const pagesV2 = makePages('v2')

      // 推入 v1 作为"修改前保存点"；v2 是修改后的当前状态（未入栈）
      useHistoryStore.getState().pushSnapshot(pagesV1)

      const restored = useHistoryStore.getState().undo(pagesV2)
      expect(restored).toBeDefined()
      expect(restored![0]?.id).toBe('v1_page_0')
    })

    it('undo 将 currentPages 压入 redoStack', () => {
      const pagesV1 = makePages('v1')
      const pagesV2 = makePages('v2')

      useHistoryStore.getState().pushSnapshot(pagesV1)
      useHistoryStore.getState().undo(pagesV2)

      expect(useHistoryStore.getState().redoStack).toHaveLength(1)
      expect(useHistoryStore.getState().canRedo()).toBe(true)
    })

    it('undoStack 为空时 undo 返回 null', () => {
      const result = useHistoryStore.getState().undo(makePages('cur'))
      expect(result).toBeNull()
    })

    it('多次 undo 依次恢复历史', () => {
      const p1 = makePages('v1')
      const p2 = makePages('v2')
      const p3 = makePages('v3')

      // undoStack = [clone(p1), clone(p2)]；p3 是当前状态（未入栈）
      useHistoryStore.getState().pushSnapshot(p1)
      useHistoryStore.getState().pushSnapshot(p2)

      // 第一次 undo：弹出 clone(p2)，返回 v2 状态
      const r1 = useHistoryStore.getState().undo(p3)
      expect(r1![0]?.id).toBe('v2_page_0')

      // 第二次 undo：弹出 clone(p1)，返回 v1 状态
      const r2 = useHistoryStore.getState().undo(r1!)
      expect(r2![0]?.id).toBe('v1_page_0')
    })
  })

  // ─── redo ────────────────────────────────────────────────────

  describe('redo', () => {
    it('redo 恢复被撤销的页面', () => {
      const pagesV1 = makePages('v1')
      const pagesV2 = makePages('v2')

      useHistoryStore.getState().pushSnapshot(pagesV1)
      const restored = useHistoryStore.getState().undo(pagesV2)
      const redone = useHistoryStore.getState().redo(restored!)

      expect(redone![0]?.id).toBe('v2_page_0')
    })

    it('redoStack 为空时 redo 返回 null', () => {
      const result = useHistoryStore.getState().redo(makePages('cur'))
      expect(result).toBeNull()
    })

    it('redo 将 currentPages 压回 undoStack', () => {
      const p1 = makePages('v1')
      const p2 = makePages('v2')

      useHistoryStore.getState().pushSnapshot(p1)
      useHistoryStore.getState().undo(p2)
      expect(useHistoryStore.getState().undoStack).toHaveLength(0)

      const restored = useHistoryStore.getState().redo(makePages('cur'))
      expect(restored).not.toBeNull()
      expect(useHistoryStore.getState().undoStack).toHaveLength(1)
    })
  })

  // ─── redo 栈在新操作后清空 ───────────────────────────────────

  describe('redo 栈在新 push 后清空', () => {
    it('undo 之后 push 新快照，redoStack 应清空', () => {
      const p1 = makePages('v1')
      const p2 = makePages('v2')
      const p3 = makePages('v3')

      useHistoryStore.getState().pushSnapshot(p1)
      useHistoryStore.getState().pushSnapshot(p2)
      useHistoryStore.getState().undo(p2)
      expect(useHistoryStore.getState().redoStack).toHaveLength(1)

      // 新操作 push 一个不同引用的快照
      useHistoryStore.getState().pushSnapshot(p3)
      expect(useHistoryStore.getState().redoStack).toHaveLength(0)
      expect(useHistoryStore.getState().canRedo()).toBe(false)
    })
  })

  // ─── debounce 行为 ───────────────────────────────────────────

  describe('pushSnapshotDebounced（leading-edge debounce）', () => {
    it('窗口期内首次调用立即 push，后续调用静默', () => {
      const p1 = makePages('d1')
      const p2 = makePages('d2')
      const p3 = makePages('d3')

      useHistoryStore.getState().pushSnapshotDebounced(p1) // 窗口内第一次 → push
      useHistoryStore.getState().pushSnapshotDebounced(p2) // 静默
      useHistoryStore.getState().pushSnapshotDebounced(p3) // 静默

      expect(useHistoryStore.getState().undoStack).toHaveLength(1)
      expect(useHistoryStore.getState().undoStack[0]![0]?.id).toBe('d1_page_0')
    })

    it('窗口期（300ms）结束后再次调用会 push', () => {
      const p1 = makePages('e1')
      const p2 = makePages('e2')

      useHistoryStore.getState().pushSnapshotDebounced(p1)
      vi.advanceTimersByTime(300)

      useHistoryStore.getState().pushSnapshotDebounced(p2) // 新窗口，立即 push
      expect(useHistoryStore.getState().undoStack).toHaveLength(2)
    })

    it('重置计时器：窗口期内多次调用后等待 300ms 才解锁', () => {
      const p1 = makePages('f1')
      const p2 = makePages('f2')
      const p3 = makePages('f3')

      useHistoryStore.getState().pushSnapshotDebounced(p1) // push，锁定
      vi.advanceTimersByTime(200) // 未到期
      useHistoryStore.getState().pushSnapshotDebounced(p2) // 重置计时器，仍锁定
      vi.advanceTimersByTime(200) // 200ms：从第二次调用算共 200ms，仍在锁定期
      useHistoryStore.getState().pushSnapshotDebounced(p3) // 仍静默（锁定中）
      expect(useHistoryStore.getState().undoStack).toHaveLength(1)

      vi.advanceTimersByTime(300) // 超过最后一次调用 300ms → 解锁
      useHistoryStore.getState().pushSnapshotDebounced(makePages('f4')) // 新窗口
      expect(useHistoryStore.getState().undoStack).toHaveLength(2)
    })
  })

  // ─── MAX_HISTORY 深度限制 ────────────────────────────────────

  describe('MAX_HISTORY 深度限制（50）', () => {
    it('超过 50 条时最旧的条目被丢弃', () => {
      // push 51 条不同引用快照
      for (let i = 0; i < 51; i++) {
        useHistoryStore.getState().pushSnapshot(makePages(`snap_${i}`))
      }
      const stack = useHistoryStore.getState().undoStack
      expect(stack).toHaveLength(50)
      // 最早的 snap_0 应已被丢弃，最旧的是 snap_1
      expect(stack[0]![0]?.id).toBe('snap_1_page_0')
    })

    it('redo 栈也受 MAX_HISTORY 限制', () => {
      // 先 push 50 条
      const pages: Slide[][] = []
      for (let i = 0; i < 50; i++) {
        const p = makePages(`r_${i}`)
        pages.push(p)
        useHistoryStore.getState().pushSnapshot(p)
      }

      // undo 50 次
      let current = makePages('cur')
      for (let i = 0; i < 50; i++) {
        const restored = useHistoryStore.getState().undo(current)
        if (restored) current = restored
      }

      // redoStack 最多 50 条
      expect(useHistoryStore.getState().redoStack.length).toBeLessThanOrEqual(50)
    })
  })

  // ─── clear ───────────────────────────────────────────────────

  describe('clear', () => {
    it('clear 后 undoStack 和 redoStack 均为空', () => {
      useHistoryStore.getState().pushSnapshot(makePages('g1'))
      useHistoryStore.getState().pushSnapshot(makePages('g2'))
      useHistoryStore.getState().clear()

      expect(useHistoryStore.getState().undoStack).toHaveLength(0)
      expect(useHistoryStore.getState().redoStack).toHaveLength(0)
      expect(useHistoryStore.getState().canUndo()).toBe(false)
    })
  })

  // ─── 协作模式 ────────────────────────────────────────────────

  describe('协作模式（setCollabUndoRedo）', () => {
    it('进入协作模式后 pushSnapshot 变为 no-op', () => {
      const collabUndo = vi.fn()
      const collabRedo = vi.fn()
      useHistoryStore.getState().setCollabUndoRedo({
        undo: collabUndo,
        redo: collabRedo,
        canUndo: () => true,
        canRedo: () => false,
      })

      useHistoryStore.getState().pushSnapshot(makePages('collab'))
      expect(useHistoryStore.getState().undoStack).toHaveLength(0)
    })

    it('协作模式下 undo 委托给注入函数', () => {
      const collabUndo = vi.fn()
      useHistoryStore.getState().setCollabUndoRedo({
        undo: collabUndo,
        redo: vi.fn(),
        canUndo: () => true,
        canRedo: () => false,
      })

      const result = useHistoryStore.getState().undo(makePages('cur'))
      expect(collabUndo).toHaveBeenCalledTimes(1)
      expect(result).toBeNull()
    })

    it('退出协作模式后恢复 legacy 行为', () => {
      useHistoryStore.getState().setCollabUndoRedo({
        undo: vi.fn(),
        redo: vi.fn(),
        canUndo: () => true,
        canRedo: () => false,
      })
      useHistoryStore.getState().setCollabUndoRedo(null)
      expect(useHistoryStore.getState().isCollabMode).toBe(false)

      useHistoryStore.getState().pushSnapshot(makePages('legacy'))
      expect(useHistoryStore.getState().undoStack).toHaveLength(1)
    })

    it('H1-03 回归：协作函数存储在 store state 中，后注入覆盖前注入', () => {
      const undoA = vi.fn()
      const undoB = vi.fn()

      useHistoryStore.getState().setCollabUndoRedo({
        undo: undoA,
        redo: vi.fn(),
        canUndo: () => true,
        canRedo: () => false,
      })

      useHistoryStore.getState().setCollabUndoRedo({
        undo: undoB,
        redo: vi.fn(),
        canUndo: () => true,
        canRedo: () => false,
      })

      useHistoryStore.getState().undo(makePages('cur'))
      expect(undoA).not.toHaveBeenCalled()
      expect(undoB).toHaveBeenCalledTimes(1)
    })

    it('H1-03 回归：协作函数通过 store state 可观测', () => {
      const s0 = useHistoryStore.getState()
      expect(s0._collabUndoFn).toBeNull()

      const undoFn = vi.fn()
      useHistoryStore.getState().setCollabUndoRedo({
        undo: undoFn,
        redo: vi.fn(),
        canUndo: () => true,
        canRedo: () => false,
      })

      const s1 = useHistoryStore.getState()
      expect(s1._collabUndoFn).toBe(undoFn)

      useHistoryStore.getState().setCollabUndoRedo(null)
      const s2 = useHistoryStore.getState()
      expect(s2._collabUndoFn).toBeNull()
    })
  })
})
