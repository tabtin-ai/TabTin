import { getBucket, registerStorageBucket } from '@tabtin/storage-manager'
import { DRAFT_MAX_CHARS } from './chatInputConstants'

const DRAFT_KEY_PREFIX = 'tabtin:draft:'
const DRAFT_SPACE_KEY_PREFIX = 'space:'
const DRAFT_MAX_SESSIONS = 20
const DRAFT_LRU_KEY = 'tabtin:draftLRU'
const INPUT_DRAFTS_BUCKET_ID = 'chat:input-drafts'

/** 已有会话用 sessionId；草稿会话（sessionId=null）用 space:{spaceId}。 */
export function resolveDraftKey(sessionId: string | null | undefined, spaceId: string | null | undefined): string | null {
  if (sessionId) return sessionId
  if (spaceId) return `${DRAFT_SPACE_KEY_PREFIX}${spaceId}`
  return null
}

/** ：与草稿 localStorage key 同源的 React key，切会话 remount 避免旧草稿闪帧。 */
const COMPOSER_DRAFT_SCOPE_FALLBACK = 'none'
export function composerDraftScopeKey(
  sessionId: string | null | undefined,
  spaceId: string | null | undefined,
): string {
  return resolveDraftKey(sessionId, spaceId) ?? COMPOSER_DRAFT_SCOPE_FALLBACK
}

/** 外部写入草稿后通知已挂载的 ChatInput 同步（如交接 take_over）。 */
export const COMPOSER_DRAFT_EXTERNAL_SET_EVENT = 'tabtin:composer-draft-external-set'

/** 输入框从空↔非空变化时通知欢迎建议条等旁路 UI。 */
export const COMPOSER_DRAFT_PRESENCE_EVENT = 'tabtin:composer-draft-presence'

export function emitComposerDraftPresence(draftKey: string, hasText: boolean) {
  if (typeof window === 'undefined' || !draftKey) return
  window.dispatchEvent(
    new CustomEvent(COMPOSER_DRAFT_PRESENCE_EVENT, {
      detail: { draftKey, hasText },
    }),
  )
}

export function saveDraft(draftKey: string, value: string) {
  try {
    const truncated = value.length > DRAFT_MAX_CHARS ? value.slice(0, DRAFT_MAX_CHARS) : value
    localStorage.setItem(`${DRAFT_KEY_PREFIX}${draftKey}`, truncated)
    enforceDraftLRU(draftKey)
  } catch { /* localStorage 不可用 — 静默降级 */ }
}

/** 持久化草稿并通知当前匹配 draftKey 的输入框立刻刷新。 */
export function setComposerDraftExternally(draftKey: string, value: string) {
  saveDraft(draftKey, value)
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(COMPOSER_DRAFT_EXTERNAL_SET_EVENT, {
      detail: { draftKey, value },
    }),
  )
}

/** 清除持久化草稿，并通知当前匹配 draftKey 的输入框立即清空。 */
export function clearComposerDraftExternally(draftKey: string) {
  clearDraft(draftKey)
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(COMPOSER_DRAFT_EXTERNAL_SET_EVENT, {
      detail: { draftKey, value: '' },
    }),
  )
}

export function loadDraft(draftKey: string): string {
  try {
    return localStorage.getItem(`${DRAFT_KEY_PREFIX}${draftKey}`) ?? ''
  } catch {
    return ''
  }
}

export function clearDraft(draftKey: string) {
  try {
    localStorage.removeItem(`${DRAFT_KEY_PREFIX}${draftKey}`)
  } catch { /* noop */ }
}

export function clearDrafts(draftKeys: readonly string[]) {
  for (const draftKey of draftKeys) clearDraft(draftKey)
}

function enforceDraftLRU(sessionId: string) {
  try {
    const raw = localStorage.getItem(DRAFT_LRU_KEY)
    const order: string[] = raw ? JSON.parse(raw) : []
    const idx = order.indexOf(sessionId)
    if (idx >= 0) order.splice(idx, 1)
    order.push(sessionId)
    while (order.length > DRAFT_MAX_SESSIONS) {
      const evictId = order.shift()!
      localStorage.removeItem(`${DRAFT_KEY_PREFIX}${evictId}`)
    }
    localStorage.setItem(DRAFT_LRU_KEY, JSON.stringify(order))
  } catch { /* noop */ }
}

function enumerateDraftKeys(): Array<{ sessionId: string; raw: string }> {
  const out: Array<{ sessionId: string; raw: string }> = []
  try {
    if (typeof localStorage === 'undefined') return out
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(DRAFT_KEY_PREFIX)) continue
      const sessionId = key.slice(DRAFT_KEY_PREFIX.length)
      const raw = localStorage.getItem(key) ?? ''
      out.push({ sessionId, raw })
    }
  } catch { /* localStorage 不可用 */ }
  return out
}

if (typeof window !== 'undefined' && !getBucket(INPUT_DRAFTS_BUCKET_ID)) {
  registerStorageBucket({
    id: INPUT_DRAFTS_BUCKET_ID,
    category: 'data',
    group: 'conversation',
    displayName: '对话输入框草稿',
    description: '所有会话的未发送输入框草稿（用户写到一半的消息，本地保留）',
    warnings: [
      '清除后，所有未发送的草稿（用户写到一半的消息）将永久丢失',
      '草稿没有云端备份——这是纯本地缓存',
    ],
    sizeFn: async () => {
      const drafts = enumerateDraftKeys()
      const bytes = drafts.reduce((sum, d) => sum + d.raw.length * 2, 0)
      return { bytes, itemCount: drafts.length }
    },
    listFn: async () => {
      const drafts = enumerateDraftKeys()
      let lruOrder: string[] = []
      try {
        const raw = localStorage.getItem(DRAFT_LRU_KEY)
        lruOrder = raw ? JSON.parse(raw) : []
      } catch { /* localStorage 不可用 */ }
      return drafts.map(d => ({
        id: d.sessionId,
        label: `会话 ${d.sessionId.slice(0, 8)}…`,
        bytes: d.raw.length * 2,
        metadata: {
          chars: d.raw.length,
          lruRank: lruOrder.indexOf(d.sessionId),
          lruTotal: lruOrder.length,
        },
      }))
    },
    clearFn: async (options) => {
      const drafts = enumerateDraftKeys()
      const targetIds = options?.itemIds && options.itemIds.length > 0
        ? new Set(options.itemIds)
        : null
      const targets = targetIds
        ? drafts.filter(d => targetIds.has(d.sessionId))
        : drafts
      const freedBytes = targets.reduce((sum, d) => sum + d.raw.length * 2, 0)
      if (options?.dryRun) {
        return { clearedItemCount: targets.length, freedBytes }
      }
      try {
        for (const d of targets) {
          localStorage.removeItem(`${DRAFT_KEY_PREFIX}${d.sessionId}`)
        }
        if (!targetIds) {
          localStorage.removeItem(DRAFT_LRU_KEY)
        } else {
          try {
            const raw = localStorage.getItem(DRAFT_LRU_KEY)
            if (raw) {
              const order: string[] = JSON.parse(raw)
              const filtered = order.filter(id => !targetIds.has(id))
              localStorage.setItem(DRAFT_LRU_KEY, JSON.stringify(filtered))
            }
          } catch { /* LRU 维护非关键路径 */ }
        }
      } catch { /* localStorage 不可用 */ }
      return { clearedItemCount: targets.length, freedBytes }
    },
  })
}
