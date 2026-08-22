/**
 * Wave 5 回归测试 — SP0-05 离线写操作队列溢出修复
 *
 * 验证：
 * - appendPendingWrite 超限时先合并同元素 updateElement 操作
 * - 合并后仍超限则溢出到 localStorage，不静默丢弃
 * - compactPendingQueue 正确合并同 (pageId, elementId) 的 updateElement
 * - loadPendingOverflow 读取并清除 localStorage 溢出数据
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  appendPendingWrite,
  compactPendingQueue,
  spillToLocalStorage,
  loadPendingOverflow,
  PENDING_WRITES_MAX,
  type PendingSlideWrite,
} from '../hooks/useSlideCollaboration'

// ── Mock localStorage ──

const localStorageMap = new Map<string, string>()

beforeEach(() => {
  localStorageMap.clear()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => localStorageMap.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageMap.set(key, value) },
    removeItem: (key: string) => { localStorageMap.delete(key) },
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ── compactPendingQueue ──

describe('SP0-05: compactPendingQueue', () => {
  it('merges updateElement ops with same (pageId, elementId), later wins per field', () => {
    const queue: PendingSlideWrite[] = [
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { left: 10, top: 20 } },
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { left: 30, width: 100 } },
    ]
    const removed = compactPendingQueue(queue)
    expect(removed).toBe(1)
    expect(queue).toHaveLength(1)
    const merged = queue[0] as Extract<PendingSlideWrite, { op: 'updateElement' }>
    expect(merged.updates).toEqual({ left: 30, top: 20, width: 100 })
  })

  it('does not merge different elementIds', () => {
    const queue: PendingSlideWrite[] = [
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { left: 10 } },
      { op: 'updateElement', pageId: 'p1', elementId: 'e2', updates: { left: 20 } },
    ]
    const removed = compactPendingQueue(queue)
    expect(removed).toBe(0)
    expect(queue).toHaveLength(2)
  })

  it('preserves non-updateElement ops', () => {
    const queue: PendingSlideWrite[] = [
      { op: 'addPage', pageId: 'p2', page: {} },
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { left: 10 } },
      { op: 'deletePage', pageId: 'p3' },
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { left: 30 } },
    ]
    const removed = compactPendingQueue(queue)
    expect(removed).toBe(1)
    expect(queue).toHaveLength(3)
    expect(queue[0].op).toBe('addPage')
    expect(queue[1].op).toBe('deletePage')
    expect(queue[2].op).toBe('updateElement')
    expect((queue[2] as any).updates.left).toBe(30)
  })

  it('handles three updates to same element', () => {
    const queue: PendingSlideWrite[] = [
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { left: 1 } },
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { top: 2 } },
      { op: 'updateElement', pageId: 'p1', elementId: 'e1', updates: { left: 3, width: 4 } },
    ]
    const removed = compactPendingQueue(queue)
    expect(removed).toBe(2)
    expect(queue).toHaveLength(1)
    expect((queue[0] as any).updates).toEqual({ left: 3, top: 2, width: 4 })
  })
})

// ── spillToLocalStorage / loadPendingOverflow ──

describe('SP0-05: localStorage overflow spill', () => {
  it('spillToLocalStorage writes and loadPendingOverflow reads back', () => {
    const ops: PendingSlideWrite[] = [
      { op: 'deletePage', pageId: 'p1' },
      { op: 'addPage', pageId: 'p2', page: { id: 'p2' } },
    ]
    spillToLocalStorage(ops)
    const loaded = loadPendingOverflow()
    expect(loaded).toEqual(ops)
  })

  it('loadPendingOverflow clears storage after read', () => {
    spillToLocalStorage([{ op: 'deletePage', pageId: 'p1' }])
    loadPendingOverflow()
    const second = loadPendingOverflow()
    expect(second).toEqual([])
  })

  it('spillToLocalStorage accumulates across calls', () => {
    spillToLocalStorage([{ op: 'deletePage', pageId: 'p1' }])
    spillToLocalStorage([{ op: 'deletePage', pageId: 'p2' }])
    const loaded = loadPendingOverflow()
    expect(loaded).toHaveLength(2)
  })

  it('spillToLocalStorage no-op for empty array', () => {
    spillToLocalStorage([])
    expect(localStorageMap.size).toBe(0)
  })

  it('spillToLocalStorage isolates by projectId', () => {
    spillToLocalStorage([{ op: 'deletePage', pageId: 'p1' }], 'projA')
    spillToLocalStorage([{ op: 'deletePage', pageId: 'p2' }], 'projB')
    const a = loadPendingOverflow('projA')
    const b = loadPendingOverflow('projB')
    expect(a).toHaveLength(1)
    expect(a[0]).toMatchObject({ pageId: 'p1' })
    expect(b).toHaveLength(1)
    expect(b[0]).toMatchObject({ pageId: 'p2' })
  })

  it('loadPendingOverflow with projectId does not read unkeyed data', () => {
    spillToLocalStorage([{ op: 'deletePage', pageId: 'p1' }])
    const result = loadPendingOverflow('projX')
    expect(result).toEqual([])
  })
})

// ── appendPendingWrite integration ──

describe('SP0-05: appendPendingWrite overflow safety', () => {
  it('compacts before discarding when queue exceeds limit', () => {
    const queue: PendingSlideWrite[] = []

    for (let i = 0; i < PENDING_WRITES_MAX; i++) {
      queue.push({
        op: 'updateElement',
        pageId: 'p1',
        elementId: 'e1',
        updates: { left: i },
      })
    }
    expect(queue).toHaveLength(PENDING_WRITES_MAX)

    appendPendingWrite(queue, {
      op: 'updateElement',
      pageId: 'p1',
      elementId: 'e1',
      updates: { left: 999 },
    })

    // All same element updates should compact to 1
    expect(queue.length).toBeLessThanOrEqual(PENDING_WRITES_MAX)
    const last = queue[queue.length - 1] as Extract<PendingSlideWrite, { op: 'updateElement' }>
    expect(last.updates.left).toBe(999)
  })

  it('spills to localStorage instead of discarding when compaction insufficient', () => {
    const queue: PendingSlideWrite[] = []

    // Fill with distinct ops that cannot be compacted
    for (let i = 0; i < PENDING_WRITES_MAX; i++) {
      queue.push({
        op: 'updateElement',
        pageId: `p${i}`,
        elementId: `e${i}`,
        updates: { left: i },
      })
    }

    appendPendingWrite(queue, { op: 'deletePage', pageId: 'pNew' })

    expect(queue).toHaveLength(PENDING_WRITES_MAX)
    const overflow = loadPendingOverflow()
    expect(overflow.length).toBeGreaterThan(0)
  })

  it('setPageElements dedup still works', () => {
    const queue: PendingSlideWrite[] = [
      { op: 'setPageElements', pageId: 'p1', elements: [{ id: 'e1' } as any] },
    ]
    appendPendingWrite(queue, {
      op: 'setPageElements',
      pageId: 'p1',
      elements: [{ id: 'e2' } as any],
    })
    expect(queue).toHaveLength(1)
    expect((queue[0] as any).elements[0].id).toBe('e2')
  })
})
