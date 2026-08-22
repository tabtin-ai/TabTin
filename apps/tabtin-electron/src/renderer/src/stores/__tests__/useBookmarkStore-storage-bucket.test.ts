/**
 * W2.2 G3 · renderer 守护测试：useBookmarkStore 正确注册 browser:bookmarks bucket。
 *
 * 守住的核心约束：
 *   1. import store 时会自动向 renderer 进程 storage-manager 注册 browser:bookmarks
 *   2. bucket 满足 D-5 要求：exportFn 存在，产出含 metadata 的 JSON 对象
 *      （W3.3 增强：`{ schemaVersion, exportedAt, source, bucketId, bookmarks: [...] }`）
 *   3. clearFn 支持全清 + 按 itemIds 部分清
 *   4. sizeFn 粗略反映 items.length
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

describe('useBookmarkStore · storage-manager 接入', () => {
  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    const sm = await import('@tabtin/storage-manager')
    sm.__resetForTesting()
  })

  it('store 模块加载后 browser:bookmarks 已注册，字段符合 W2.2 G3 规范', async () => {
    await import('../useBookmarkStore')
    const sm = await import('@tabtin/storage-manager')

    const bucket = sm.getBucket('browser:bookmarks')
    expect(bucket).toBeDefined()
    expect(bucket?.category).toBe('data')
    expect(bucket?.group).toBe('browser')
    expect(bucket?.requiresConfirmation).toBe('hard')
    expect(bucket?.warnings?.length ?? 0).toBeGreaterThan(0)
    // D-5 核心资产必须有 exportFn
    expect(typeof bucket?.exportFn).toBe('function')
  })

  it('exportFn 产出含 metadata + 书签数组的 JSON（W3.3 增强）', async () => {
    const { useBookmarkStore } = await import('../useBookmarkStore')
    const sm = await import('@tabtin/storage-manager')

    useBookmarkStore.getState().addBookmark('https://example.com/a', 'A 示例')
    useBookmarkStore.getState().addBookmark('https://example.com/b', 'B 示例')

    const bucket = sm.getBucket('browser:bookmarks')!
    const exp = await bucket.exportFn!()
    expect(exp.mimeType).toBe('application/json')
    // W3.3 D-5：filename 统一格式 `tabtin-bookmarks-{ISO ts}.json`
    expect(exp.filename).toMatch(/^tabtin-bookmarks-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d+Z\.json$/)
    const parsed = JSON.parse(exp.data as string)
    expect(parsed).toMatchObject({
      schemaVersion: 1,
      source: 'tabtin-electron',
      bucketId: 'browser:bookmarks',
      itemCount: 2,
    })
    // exportedAt 必须是合法 ISO 时间字符串
    expect(typeof parsed.exportedAt).toBe('string')
    expect(new Date(parsed.exportedAt).toISOString()).toBe(parsed.exportedAt)

    expect(Array.isArray(parsed.bookmarks)).toBe(true)
    expect(parsed.bookmarks).toHaveLength(2)
    for (const entry of parsed.bookmarks) {
      expect(entry).toHaveProperty('url')
      expect(entry).toHaveProperty('title')
      expect(entry).toHaveProperty('createdAt')
      expect(entry).toHaveProperty('addedAtIso')
      // addedAtIso 必须能反序列化回原 createdAt
      expect(new Date(entry.addedAtIso).getTime()).toBe(entry.createdAt)
    }
  })

  it('clearFn 支持按 itemIds 部分清理', async () => {
    const { useBookmarkStore } = await import('../useBookmarkStore')
    const sm = await import('@tabtin/storage-manager')

    useBookmarkStore.getState().addBookmark('https://example.com/a', 'A')
    useBookmarkStore.getState().addBookmark('https://example.com/b', 'B')
    useBookmarkStore.getState().addBookmark('https://example.com/c', 'C')

    const items = useBookmarkStore.getState().items
    expect(items).toHaveLength(3)

    const bucket = sm.getBucket('browser:bookmarks')!
    // 清掉 A / C，保留 B
    const toClear = items.filter((b) => b.title !== 'B').map((b) => b.id)
    const result = await bucket.clearFn!({ itemIds: toClear })
    expect(result.clearedItemCount).toBe(2)

    const remaining = useBookmarkStore.getState().items
    expect(remaining).toHaveLength(1)
    expect(remaining[0].title).toBe('B')
  })

  it('clearFn 不带 itemIds 时全清', async () => {
    const { useBookmarkStore } = await import('../useBookmarkStore')
    const sm = await import('@tabtin/storage-manager')

    useBookmarkStore.getState().addBookmark('https://example.com/a', 'A')
    useBookmarkStore.getState().addBookmark('https://example.com/b', 'B')

    const bucket = sm.getBucket('browser:bookmarks')!
    const result = await bucket.clearFn!()
    expect(result.clearedItemCount).toBe(2)
    expect(useBookmarkStore.getState().items).toHaveLength(0)
  })

  it('clearFn dryRun 不改状态', async () => {
    const { useBookmarkStore } = await import('../useBookmarkStore')
    const sm = await import('@tabtin/storage-manager')

    useBookmarkStore.getState().addBookmark('https://example.com/a', 'A')
    useBookmarkStore.getState().addBookmark('https://example.com/b', 'B')

    const bucket = sm.getBucket('browser:bookmarks')!
    const dry = await bucket.clearFn!({ dryRun: true })
    expect(dry.clearedItemCount).toBe(2)
    expect(useBookmarkStore.getState().items).toHaveLength(2)
  })
})
