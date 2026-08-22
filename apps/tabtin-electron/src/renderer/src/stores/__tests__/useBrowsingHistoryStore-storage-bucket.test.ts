/**
 * W2.2 G3 · renderer 守护测试：useBrowsingHistoryStore 正确注册
 * browser:browsing-history bucket。
 *
 * 守住的核心约束：
 *   1. bucket 注册成功且字段符合规范（data / browser / hard）
 *   2. clearFn 支持全清 + 按 itemIds 部分清
 *   3. 不提供 exportFn（隐私类，D-5 没把 browsing-history 列入 5 核心导出）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

describe('useBrowsingHistoryStore · storage-manager 接入', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
  })

  it('store 模块加载后 browser:browsing-history 已注册', async () => {
    await import('../useBrowsingHistoryStore')
    const sm = await import('@tabtin/storage-manager')

    const bucket = sm.getBucket('browser:browsing-history')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('data')
    expect(bucket?.group).toBe('browser')
    expect(bucket?.requiresConfirmation).toBe('hard')
    expect(bucket?.warnings?.length ?? 0).toBeGreaterThan(0)
    // 隐私考量：不提供 exportFn
    expect(bucket?.exportFn).toBeUndefined()
  })

  it('clearFn 支持按 itemIds 部分清理', async () => {
    const { useBrowsingHistoryStore } = await import('../useBrowsingHistoryStore')
    const sm = await import('@tabtin/storage-manager')

    useBrowsingHistoryStore.setState({
      items: [
        { id: 'a', url: 'https://a.com', title: 'A', visitedAt: 1 },
        { id: 'b', url: 'https://b.com', title: 'B', visitedAt: 2 },
        { id: 'c', url: 'https://c.com', title: 'C', visitedAt: 3 },
      ],
      initialized: false,
    })

    const bucket = sm.getBucket('browser:browsing-history')!
    const result = await bucket.clearFn!({ itemIds: ['a', 'c'] })
    expect(result.clearedItemCount).toBe(2)

    const remaining = useBrowsingHistoryStore.getState().items
    expect(remaining).toHaveLength(1)
    expect(remaining[0].id).toBe('b')
  })

  it('clearFn 不带 itemIds 时全清', async () => {
    const { useBrowsingHistoryStore } = await import('../useBrowsingHistoryStore')
    const sm = await import('@tabtin/storage-manager')

    useBrowsingHistoryStore.setState({
      items: [
        { id: 'a', url: 'https://a.com', title: 'A', visitedAt: 1 },
        { id: 'b', url: 'https://b.com', title: 'B', visitedAt: 2 },
      ],
      initialized: false,
    })

    const bucket = sm.getBucket('browser:browsing-history')!
    const result = await bucket.clearFn!()
    expect(result.clearedItemCount).toBe(2)
    expect(useBrowsingHistoryStore.getState().items).toHaveLength(0)
  })

  it('sizeFn 粗略反映 items 数量', async () => {
    const { useBrowsingHistoryStore } = await import('../useBrowsingHistoryStore')
    const sm = await import('@tabtin/storage-manager')

    useBrowsingHistoryStore.setState({
      items: [
        { id: 'a', url: 'https://a.com', title: 'A', visitedAt: 1 },
        { id: 'b', url: 'https://b.com', title: 'B', visitedAt: 2 },
      ],
      initialized: false,
    })

    const bucket = sm.getBucket('browser:browsing-history')!
    const size = await bucket.sizeFn()
    expect(size.itemCount).toBe(2)
    expect(size.bytes).toBeGreaterThan(0)
  })
})
