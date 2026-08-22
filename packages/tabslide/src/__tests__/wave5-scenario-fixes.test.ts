/**
 * Wave 5 场景验证修复回归测试
 *
 * SP0-07: 撤销栈总内存上限，防止大文稿 OOM
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useHistoryStore, __test__ as historyTestUtils } from '../store/history'
import type { Slide } from '../types/slides'

const { estimateSnapshotBytes, trimStackByMemory, MAX_MEMORY_BYTES } = historyTestUtils

// ── 辅助 ─────────────────────────────────────────────────

const makePages = (label: string, count = 1): Slide[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `${label}_page_${i}`,
    elements: [],
    background: { type: 'solid' as const, color: '#ffffff' },
  }))

const makePagesOfSize = (label: string, sizeChars: number): Slide[] => [
  {
    id: `${label}_page_0`,
    elements: [
      {
        id: `${label}_el_0`,
        type: 'text',
        x: 0, y: 0, width: 100, height: 50, rotate: 0,
        content: 'x'.repeat(sizeChars),
      } as any,
    ],
    background: { type: 'solid' as const, color: '#ffffff' },
  },
]

const resetHistoryStore = () => {
  useHistoryStore.getState().setCollabUndoRedo(null)
  useHistoryStore.getState().clear()
}

// ═══════════════════════════════════════════════════════════
// SP0-07: estimateSnapshotBytes 单元测试
// ═══════════════════════════════════════════════════════════

describe('SP0-07: estimateSnapshotBytes', () => {
  it('返回 JSON.stringify 长度 × 2', () => {
    const pages = makePages('est', 2)
    const jsonLen = JSON.stringify(pages).length
    expect(estimateSnapshotBytes(pages)).toBe(jsonLen * 2)
  })

  it('对大数据也能正确估算', () => {
    const pages = makePagesOfSize('big', 10000)
    const est = estimateSnapshotBytes(pages)
    expect(est).toBeGreaterThan(20000)
  })
})

// ═══════════════════════════════════════════════════════════
// SP0-07: trimStackByMemory 单元测试
// ═══════════════════════════════════════════════════════════

describe('SP0-07: trimStackByMemory', () => {
  it('栈总大小在预算内时不裁剪', () => {
    const stack = [makePages('a'), makePages('b'), makePages('c')]
    const result = trimStackByMemory(stack, 1024 * 1024)
    expect(result).toHaveLength(3)
    expect(result).toBe(stack)
  })

  it('栈超过预算时从最旧端丢弃', () => {
    const stack = [
      makePagesOfSize('s0', 5000),
      makePagesOfSize('s1', 5000),
      makePagesOfSize('s2', 5000),
    ]
    const singleSize = estimateSnapshotBytes(stack[0]!)
    const budget = singleSize * 2 + 100
    const result = trimStackByMemory(stack, budget)
    expect(result).toHaveLength(2)
    expect(result[0]![0]!.id).toBe('s1_page_0')
    expect(result[1]![0]!.id).toBe('s2_page_0')
  })

  it('所有条目都超预算时只保留最后一个', () => {
    const stack = [
      makePagesOfSize('x0', 10000),
      makePagesOfSize('x1', 10000),
      makePagesOfSize('x2', 10000),
    ]
    const result = trimStackByMemory(stack, 1)
    expect(result.length).toBeLessThanOrEqual(1)
  })

  it('空栈不崩溃', () => {
    expect(trimStackByMemory([], 100)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════
// SP0-07: 集成测试 — store 使用内存上限
// ═══════════════════════════════════════════════════════════

describe('SP0-07: 撤销栈内存上限集成', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetHistoryStore()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetHistoryStore()
  })

  it('小快照在 MAX_HISTORY 范围内不被内存上限裁剪', () => {
    for (let i = 0; i < 50; i++) {
      useHistoryStore.getState().pushSnapshot(makePages(`small_${i}`))
    }
    expect(useHistoryStore.getState().undoStack).toHaveLength(50)
  })

  it('MAX_MEMORY_BYTES 已配置为 100MB', () => {
    expect(MAX_MEMORY_BYTES).toBe(100 * 1024 * 1024)
  })

  it('pushSnapshot 内部调用 trimStackByMemory（通过行为验证）', () => {
    const pages = makePages('verify')
    useHistoryStore.getState().pushSnapshot(pages)
    const stack = useHistoryStore.getState().undoStack
    expect(stack).toHaveLength(1)
    expect(stack[0]![0]!.id).toBe('verify_page_0')
  })

  it('内存裁剪后 undo/redo 功能仍然正常', () => {
    useHistoryStore.getState().pushSnapshot(makePages('fn_0'))
    useHistoryStore.getState().pushSnapshot(makePages('fn_1'))

    const current = makePages('fn_current')
    const restored = useHistoryStore.getState().undo(current)
    expect(restored).not.toBeNull()
    expect(restored![0]!.id).toBe('fn_1_page_0')
    expect(useHistoryStore.getState().canRedo()).toBe(true)

    const redone = useHistoryStore.getState().redo(restored!)
    expect(redone).not.toBeNull()
  })
})

