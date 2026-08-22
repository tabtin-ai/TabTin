import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

function msg(id: string, role: ChatMessage['role'], createdAt: string): ChatMessage {
  return {
    id,
    role,
    content: id,
    created_at: createdAt,
  } as ChatMessage
}

async function loadCache() {
  vi.resetModules()
  return import('../messageCache')
}

const SID = 'session-1'

describe('messageCache per-session 快照语义', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('#2522 回退截断后写短列表，缓存整份替换，不残留旧消息', async () => {
    const cache = await loadCache()
    await cache.cacheMessages(SID, [
      msg('u1', 'user', '2026-07-03T08:00:00.000Z'),
      msg('a1', 'assistant', '2026-07-03T08:00:01.000Z'),
      msg('u2', 'user', '2026-07-03T08:00:02.000Z'),
      msg('a2', 'assistant', '2026-07-03T08:00:03.000Z'),
    ])

    // 回退：内存 store 截断成前两条，写回缓存。
    await cache.cacheMessages(SID, [
      msg('u1', 'user', '2026-07-03T08:00:00.000Z'),
      msg('a1', 'assistant', '2026-07-03T08:00:01.000Z'),
    ])

    const cached = await cache.getCachedMessages(SID)
    expect(cached?.map(m => m.id)).toEqual(['u1', 'a1'])
  })

  it('temp-* 消息不落缓存；空快照不清掉已有缓存', async () => {
    const cache = await loadCache()
    await cache.cacheMessages(SID, [msg('u1', 'user', '2026-07-03T08:00:00.000Z')])
    // 只有 temp 消息的瞬时态：persistable 为空 → 跳过写入，不清掉已有缓存。
    await cache.cacheMessages(SID, [msg('temp-user-x', 'user', '2026-07-03T08:00:05.000Z')])

    const cached = await cache.getCachedMessages(SID)
    expect(cached?.map(m => m.id)).toEqual(['u1'])
  })

  it('appendCachedMessages 向前拼接更早历史并去重', async () => {
    const cache = await loadCache()
    await cache.cacheMessages(SID, [
      msg('a1', 'assistant', '2026-07-03T08:00:01.000Z'),
    ])
    await cache.appendCachedMessages(SID, [
      msg('u0', 'user', '2026-07-03T07:59:59.000Z'),
      msg('a1', 'assistant', '2026-07-03T08:00:01.000Z'),
    ])

    const cached = await cache.getCachedMessages(SID)
    expect(cached?.map(m => m.id)).toEqual(['u0', 'a1'])
  })

  it('clearSessionCache 删除整会话快照', async () => {
    const cache = await loadCache()
    await cache.cacheMessages(SID, [msg('u1', 'user', '2026-07-03T08:00:00.000Z')])
    await cache.clearSessionCache(SID)
    expect(await cache.getCachedMessages(SID)).toBeNull()
  })

  it('preserveSyncTimestamp 保留旧水位', async () => {
    const cache = await loadCache()
    await cache.cacheMessages(SID, [msg('u1', 'user', '2026-07-03T08:00:00.000Z')], '2026-07-03T08:00:00.000Z')
    await cache.cacheMessages(
      SID,
      [msg('u1', 'user', '2026-07-03T08:00:00.000Z'), msg('a1', 'assistant', '2026-07-03T08:00:01.000Z')],
      undefined,
      { preserveSyncTimestamp: true },
    )
    expect(await cache.getSessionSyncTimestamp(SID)).toBe('2026-07-03T08:00:00.000Z')
  })
})
