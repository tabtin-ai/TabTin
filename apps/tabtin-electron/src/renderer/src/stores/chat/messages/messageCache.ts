/**
 * IndexedDB 消息缓存层
 *
 * 缓存策略：
 * - 缓存是内存 store（`messagesBySessionId`）的**纯快照**，不是可独立增量维护的副本。
 * - 存储粒度 = 每个会话一条整快照文档（`{ sessionId, messages, ... }`）。
 * - 写入即整份替换：`put` 覆盖整条会话文档，天然 replace，不存在「旧消息 key 残留」。
 *   这保证缓存里永远不会出现 store 里已不存在的消息（回退 / 压缩 / 删除后的幽灵消息
 *   从物理上不可能从缓存复活）。
 * - 加载时：先读 IndexedDB → 立即渲染 → 后台 API 同步 → 写回快照。
 * - 最近访问的 N 个会话落盘（LRU 淘汰）。
 *
 * 历史设计（DB v1）用「每条消息一行 + sessionId 索引」，`cacheMessages` 只 upsert 不删旧行，
 * 导致回退截断后旧消息仍留在 IndexedDB、下次打开会话被读回。v2 改为 per-session 快照根治。
 */

import { openDB, type IDBPDatabase } from 'idb'
import type { ChatMessage } from '@tabtin/chat-client'
import { isUnconfirmedLocalMessage } from '../shared/types'
import { registerResetAction } from '../../sessionResetRegistry'
import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { sortMessagesForTimeline } from '@/stores/chat/domain/messageTimelineOrder'

const DB_NAME = 'tabtin-chat-cache'
const DB_VERSION = 2
const STORE_SESSIONS = 'sessions'
// v1 遗留 store 名——升级时删除（缓存可丢，直接重建）。
const LEGACY_STORE_MESSAGES = 'messages'
const LEGACY_STORE_SESSION_META = 'session_meta'
const MAX_CACHED_SESSIONS = 20

/** 每会话一条整快照文档。 */
interface SessionCacheDoc {
  sessionId: string
  messages: ChatMessage[]
  lastSyncTimestamp: string | null
  lastAccessedAt: number
}

let dbInstance: IDBPDatabase | null = null

async function getDB(): Promise<IDBPDatabase> {
  if (dbInstance) return dbInstance
  dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // v1 → v2：删除旧的 per-message store，改用 per-session 快照。
      // 缓存是可丢的本地副本，升级即清空，顺便清掉历史残留的幽灵消息。
      if (db.objectStoreNames.contains(LEGACY_STORE_MESSAGES)) {
        db.deleteObjectStore(LEGACY_STORE_MESSAGES)
      }
      if (db.objectStoreNames.contains(LEGACY_STORE_SESSION_META)) {
        db.deleteObjectStore(LEGACY_STORE_SESSION_META)
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' })
      }
    },
  })
  return dbInstance
}

interface CacheMessagesOptions {
  preserveSyncTimestamp?: boolean
}

/**
 * 过滤掉尚未确认落库的本地消息——发送中 / 失败的乐观消息属于 transient 状态，
 * 不应持久化。单一身份收口后用户消息 id 从创建起即 = 服务端落库 id，
 * 「未确认」信号由 `sendStatus` 承载（见 `isUnconfirmedLocalMessage`），已确认
 * （sent / 历史）的消息 id 稳定，可安全缓存。写侧统一过滤，读侧无需再兜底。
 */
function stripTransientIds(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter(m => !isUnconfirmedLocalMessage(m))
}

async function getDoc(sessionId: string): Promise<SessionCacheDoc | undefined> {
  const db = await getDB()
  return (await db.get(STORE_SESSIONS, sessionId)) as SessionCacheDoc | undefined
}

export async function getCachedMessages(sessionId: string): Promise<ChatMessage[] | null> {
  try {
    const doc = await getDoc(sessionId)
    if (!doc || doc.messages.length === 0) return null
    return sortMessagesForTimeline(doc.messages)
  } catch (error) {
    console.warn('[MessageCache] getCachedMessages failed:', error)
    return null
  }
}

export async function touchSessionMeta(sessionId: string): Promise<void> {
  try {
    const db = await getDB()
    const doc = (await db.get(STORE_SESSIONS, sessionId)) as SessionCacheDoc | undefined
    // 无快照时无可 touch —— 快照模型下 meta 不再独立存在。
    if (!doc) return
    doc.lastAccessedAt = Date.now()
    await db.put(STORE_SESSIONS, doc)
  } catch (error) {
    console.warn('[MessageCache] touchSessionMeta failed:', error)
  }
}

/**
 * 写入会话消息快照（整份替换语义）。
 *
 * 传入的 `messages` 就是当前内存 store 里该会话的完整列表——写入即用它整份覆盖，
 * 缓存永远等于 store 的一个已知快照。
 *
 * 空快照（全是 transient 消息）时跳过写入，避免用「发送中途只有 temp 消息」的瞬时态
 * 清掉已有的有效缓存。
 */
export async function cacheMessages(
  sessionId: string,
  messages: ChatMessage[],
  syncedAt?: string,
  options: CacheMessagesOptions = {},
): Promise<void> {
  try {
    const persistable = stripTransientIds(messages)
    if (persistable.length === 0) return
    const db = await getDB()
    const existing = (await db.get(STORE_SESSIONS, sessionId)) as SessionCacheDoc | undefined
    const doc: SessionCacheDoc = {
      sessionId,
      messages: sortMessagesForTimeline(persistable),
      lastSyncTimestamp: options.preserveSyncTimestamp
        ? (existing?.lastSyncTimestamp ?? null)
        : (syncedAt ?? new Date().toISOString()),
      lastAccessedAt: Date.now(),
    }
    await db.put(STORE_SESSIONS, doc)
    await evictOldSessions()
  } catch (error) {
    console.warn('[MessageCache] cacheMessages failed:', error)
  }
}

/**
 * 加载更早历史页时把旧消息并入快照（向前拼接 + 去重），保持整份文档语义。
 */
export async function appendCachedMessages(sessionId: string, messages: ChatMessage[]): Promise<void> {
  const persistable = stripTransientIds(messages)
  if (persistable.length === 0) return
  try {
    const db = await getDB()
    const existing = (await db.get(STORE_SESSIONS, sessionId)) as SessionCacheDoc | undefined
    const byId = new Map<string, ChatMessage>()
    for (const m of existing?.messages ?? []) byId.set(m.id, m)
    for (const m of persistable) byId.set(m.id, m)
    const doc: SessionCacheDoc = {
      sessionId,
      messages: sortMessagesForTimeline([...byId.values()]),
      lastSyncTimestamp: existing?.lastSyncTimestamp ?? null,
      lastAccessedAt: Date.now(),
    }
    await db.put(STORE_SESSIONS, doc)
  } catch (error) {
    console.warn('[MessageCache] appendCachedMessages failed:', error)
  }
}

export async function getSessionSyncTimestamp(sessionId: string): Promise<string | null> {
  try {
    const doc = await getDoc(sessionId)
    return doc?.lastSyncTimestamp ?? null
  } catch {
    return null
  }
}

export async function clearSessionCache(sessionId: string): Promise<void> {
  try {
    const db = await getDB()
    await db.delete(STORE_SESSIONS, sessionId)
  } catch (error) {
    console.warn('[MessageCache] clearSessionCache failed:', error)
  }
}

export async function clearAllCache(): Promise<void> {
  try {
    const db = await getDB()
    await db.clear(STORE_SESSIONS)
  } catch (error) {
    console.warn('[MessageCache] clearAllCache failed:', error)
  }
}

async function evictOldSessions(): Promise<void> {
  try {
    const db = await getDB()
    const allDocs = (await db.getAll(STORE_SESSIONS)) as SessionCacheDoc[]
    if (allDocs.length <= MAX_CACHED_SESSIONS) return

    allDocs.sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0))
    const toEvict = allDocs.slice(MAX_CACHED_SESSIONS)

    for (const doc of toEvict) {
      await clearSessionCache(doc.sessionId)
    }
  } catch (error) {
    console.warn('[MessageCache] evictOldSessions failed:', error)
  }
}

registerResetAction('message-cache', 'cleanup', clearAllCache)

// ─── storage-manager 注册（chat:message-cache） ─────────────────
// W2.2-G2：把 IndexedDB messageCache 暴露到「个人资料 → 存储管理」面板。
// 单条消息容量按 2KB 估算（content + metadata + 上下文块包络的中位数），
// 实际值会上下浮动 50%——UI 仅用于"哪些会话占用多"的相对排序，对绝对值
// 不敏感。listFn 按 lastAccessedAt 倒序返回，便于用户在 UI 选择性删除老会话。
const MESSAGE_CACHE_BUCKET_ID = 'chat:message-cache'
const MESSAGE_CACHE_AVG_BYTES = 2048

async function _safeListSessionDocs(): Promise<SessionCacheDoc[]> {
  try {
    const db = await getDB()
    return ((await db.getAll(STORE_SESSIONS)) as SessionCacheDoc[]) ?? []
  } catch {
    return []
  }
}

if (!getBucket(MESSAGE_CACHE_BUCKET_ID)) {
  registerStorageBucket({
    id: MESSAGE_CACHE_BUCKET_ID,
    category: 'semi-cache',
    group: 'conversation',
    displayName: '对话消息缓存',
    description: '最近 20 个会话的本地消息副本（容量为估算值；云端仍是真源）',
    sizeFn: async () => {
      const allDocs = await _safeListSessionDocs()
      const itemCount = allDocs.reduce((sum, d) => sum + (d.messages?.length ?? 0), 0)
      return { bytes: itemCount * MESSAGE_CACHE_AVG_BYTES, itemCount }
    },
    listFn: async () => {
      const allDocs = await _safeListSessionDocs()
      return allDocs
        .slice()
        .sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0))
        .map(doc => ({
          id: doc.sessionId,
          label: `会话 ${doc.sessionId.slice(0, 8)}…`,
          bytes: (doc.messages?.length ?? 0) * MESSAGE_CACHE_AVG_BYTES,
          metadata: {
            messageCount: doc.messages?.length ?? 0,
            lastAccessedAt: doc.lastAccessedAt ?? null,
            lastSyncTimestamp: doc.lastSyncTimestamp ?? null,
          },
        }))
    },
    clearFn: async (options) => {
      const allDocs = await _safeListSessionDocs()
      const targetIds = options?.itemIds && options.itemIds.length > 0
        ? new Set(options.itemIds)
        : null
      const targets = targetIds
        ? allDocs.filter(d => targetIds.has(d.sessionId))
        : allDocs
      const freedBytes = targets.reduce(
        (sum, d) => sum + (d.messages?.length ?? 0) * MESSAGE_CACHE_AVG_BYTES,
        0,
      )
      const clearedItemCount = targets.reduce(
        (sum, d) => sum + (d.messages?.length ?? 0),
        0,
      )
      if (options?.dryRun) {
        return { clearedItemCount, freedBytes }
      }
      if (targetIds) {
        for (const sid of targetIds) {
          try { await clearSessionCache(sid) } catch { /* noop */ }
        }
      } else {
        await clearAllCache()
      }
      return { clearedItemCount, freedBytes }
    },
  })
}
