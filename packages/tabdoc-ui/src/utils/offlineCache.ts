/**
 * TabDoc 离线草稿缓存
 *
 * 使用 IndexedDB 持久化文档草稿，防止浏览器崩溃/断网时丢失未保存编辑。
 * 参照 TabWhiteboard OfflineCache 模式，针对文档草稿场景简化。
 *
 * 功能：
 * - 编辑器变更时 debounce 写入 IndexedDB
 * - 文档加载时检查是否有比服务端更新的本地草稿
 * - 保存成功后清除对应草稿
 * - TTL 过期自动清理
 */

import { registerStorageBucket } from '@tabtin/storage-manager'

export interface CachedDraft {
  documentId: string
  pmJson: Record<string, unknown>
  markdown: string
  plaintext: string
  baseVersion: number | null
  savedAt: number
}

const DB_NAME = 'tabdoc-offline'
const STORE_NAME = 'drafts'
const DB_VERSION = 1
const DEFAULT_TTL = 7 * 24 * 60 * 60 * 1000 // 7 天

let dbInstance: IDBDatabase | null = null
let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)
  if (dbPromise) return dbPromise

  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'documentId' })
      }
    }
    req.onsuccess = () => {
      dbInstance = req.result
      dbInstance.onclose = () => {
        dbInstance = null
        dbPromise = null
      }
      resolve(dbInstance)
    }
    req.onerror = () => {
      dbPromise = null
      reject(req.error)
    }
  })

  return dbPromise
}

/**
 * 保存草稿到 IndexedDB
 */
export async function saveDraft(draft: Omit<CachedDraft, 'savedAt'>): Promise<void> {
  const db = await openDB()
  const record: CachedDraft = { ...draft, savedAt: Date.now() }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).put(record)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 读取指定文档的本地草稿，过期返回 null
 */
export async function loadDraft(documentId: string): Promise<CachedDraft | null> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(documentId)
    req.onsuccess = () => {
      const record = req.result as CachedDraft | undefined
      if (!record) {
        resolve(null)
        return
      }
      if (Date.now() - record.savedAt > DEFAULT_TTL) {
        deleteDraft(documentId).catch(() => {})
        resolve(null)
        return
      }
      resolve(record)
    }
    req.onerror = () => reject(req.error)
  })
}

/**
 * 删除指定文档的本地草稿
 */
export async function deleteDraft(documentId: string): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).delete(documentId)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 清理所有过期草稿
 */
export async function cleanupExpiredDrafts(): Promise<number> {
  const db = await openDB()
  const all = await new Promise<CachedDraft[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as CachedDraft[])
    req.onerror = () => reject(req.error)
  })
  const now = Date.now()
  const expired = all.filter((r) => now - r.savedAt > DEFAULT_TTL)
  for (const r of expired) {
    await deleteDraft(r.documentId)
  }
  return expired.length
}

/**
 * BIZ-052: 清除所有本地草稿（供设置面板使用）
 */
export async function clearAllDrafts(): Promise<number> {
  const db = await openDB()
  const all = await new Promise<CachedDraft[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as CachedDraft[])
    req.onerror = () => reject(req.error)
  })
  if (all.length === 0) return 0
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.objectStore(STORE_NAME).clear()
    tx.oncomplete = () => resolve(all.length)
    tx.onerror = () => reject(tx.error)
  })
}

/**
 * 容量估算：把所有草稿全量读出按 JSON 序列化字节数累加。
 *
 * 草稿条目本身较小（PM JSON + markdown + plaintext，单条数十 KB 量级），
 * 受 TTL 7 天和"保存成功就删"双约束，常见情况 < 几十条；
 * 不需要走 navigator.storage.estimate() 的粗粒度估算。
 *
 * R3 一致性修复：与 tabvideo:projects / skills:preinstalled 同款 200ms 记忆化，
 * 避免 sizeFn → listFn → clearFn(dryRun) 同一渲染周期 3× 全表 getAll。
 */
const _DRAFTS_AGGREGATE_TTL_MS = 200
let _draftsAggregateCache: {
  at: number
  promise: Promise<{ bytes: number; itemCount: number; entries: CachedDraft[] }>
} | null = null

async function _doAggregateDraftsSize(): Promise<{ bytes: number; itemCount: number; entries: CachedDraft[] }> {
  const db = await openDB()
  const all = await new Promise<CachedDraft[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).getAll()
    req.onsuccess = () => resolve(req.result as CachedDraft[])
    req.onerror = () => reject(req.error)
  })
  let bytes = 0
  for (const draft of all) {
    try {
      bytes += new TextEncoder().encode(JSON.stringify(draft)).byteLength
    } catch {
      // ignore single-draft serialization failure
    }
  }
  return { bytes, itemCount: all.length, entries: all }
}

async function _aggregateDraftsSize(): Promise<{ bytes: number; itemCount: number; entries: CachedDraft[] }> {
  const now = Date.now()
  if (_draftsAggregateCache && now - _draftsAggregateCache.at < _DRAFTS_AGGREGATE_TTL_MS) {
    return _draftsAggregateCache.promise
  }
  const promise = _doAggregateDraftsSize()
  _draftsAggregateCache = { at: now, promise }
  promise.catch(() => {
    if (_draftsAggregateCache?.promise === promise) _draftsAggregateCache = null
  })
  return promise
}

// ── storage-manager 注册（W2.2 G1，business-app）─────────────────
//
// 注册函数本身幂等：重复调用会因 storage-manager 抛 BucketAlreadyRegisteredError，
// 我们在 try/catch 里吞掉，HMR / 测试场景下都安全。

export function registerTabDocOfflineDraftsBucket(): () => void {
  if (typeof indexedDB === 'undefined' || typeof navigator === 'undefined') {
    return () => undefined
  }

  let unregister: (() => void) | undefined
  try {
    unregister = registerStorageBucket({
      id: 'tabdoc:offline-drafts',
      category: 'data',
      group: 'business-app',
      displayName: 'TabDoc 离线草稿',
      description: '你正在编辑、还没成功保存到云端的 TabDoc 文档（断网或崩溃时的本地副本）。最多保留 7 天。',
      warnings: [
        '所有还没成功保存到云端的文档编辑会永久丢失，最多可累积到 7 天的写作量',
        '已经成功保存的文档不会受影响（你账号下的文档列表保留）',
        '若你最近有断网编辑、或 App 崩溃后没重新打开过对应文档，请先打开等它同步完再清理',
      ],
      requiresConfirmation: 'soft',
      sizeFn: async () => {
        try {
          const { bytes, itemCount } = await _aggregateDraftsSize()
          return { bytes, itemCount }
        } catch {
          return { bytes: 0, itemCount: 0 }
        }
      },
      listFn: async () => {
        try {
          const { entries } = await _aggregateDraftsSize()
          return entries.map((draft) => {
            let bytes = 0
            try {
              bytes = new TextEncoder().encode(JSON.stringify(draft)).byteLength
            } catch {
              bytes = 0
            }
            return {
              id: draft.documentId,
              label: draft.plaintext?.slice(0, 60) || `草稿 ${draft.documentId}`,
              bytes,
              metadata: {
                savedAt: draft.savedAt,
                baseVersion: draft.baseVersion,
              },
            }
          })
        } catch {
          return []
        }
      },
      clearFn: async (options) => {
        const { bytes, itemCount, entries } = await _aggregateDraftsSize().catch(() => ({
          bytes: 0,
          itemCount: 0,
          entries: [] as CachedDraft[],
        }))

        if (options?.dryRun) {
          if (options.itemIds?.length) {
            const idSet = new Set(options.itemIds)
            let bytesEstimate = 0
            let countEstimate = 0
            for (const draft of entries) {
              if (idSet.has(draft.documentId)) {
                bytesEstimate += new TextEncoder().encode(JSON.stringify(draft)).byteLength
                countEstimate += 1
              }
            }
            return { clearedItemCount: countEstimate, freedBytes: bytesEstimate }
          }
          return { clearedItemCount: itemCount, freedBytes: bytes }
        }

        if (options?.itemIds && options.itemIds.length > 0) {
          const idSet = new Set(options.itemIds)
          let cleared = 0
          let freed = 0
          const errors: string[] = []
          for (const draft of entries) {
            if (!idSet.has(draft.documentId)) continue
            try {
              await deleteDraft(draft.documentId)
              cleared += 1
              freed += new TextEncoder().encode(JSON.stringify(draft)).byteLength
            } catch (err) {
              errors.push(`${draft.documentId}: ${err instanceof Error ? err.message : String(err)}`)
            }
          }
          return { clearedItemCount: cleared, freedBytes: freed, errors: errors.length ? errors : undefined }
        }

        const cleared = await clearAllDrafts()
        return { clearedItemCount: cleared, freedBytes: bytes }
      },
    })
  } catch (err) {
    try { unregister?.() } catch { /* swallow */ }
    if (typeof console !== 'undefined') {
      console.warn('[tabdoc] storage-manager bucket registration skipped:', err)
    }
    return () => undefined
  }

  return () => {
    try { unregister?.() } catch { /* swallow */ }
  }
}

// 模块加载即注册——任何 import 本模块的代码（renderer 端）都会让 bucket 立即可见。
registerTabDocOfflineDraftsBucket()
