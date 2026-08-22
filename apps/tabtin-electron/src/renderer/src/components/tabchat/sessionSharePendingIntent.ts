/**
 * 共享发卡幂等意图：失败重试复用同一 client_request_id，避免叠出多条授权。
 */

import { createClientRequestId } from '@/services/im'

export const PENDING_SHARE_INTENTS_STORAGE_KEY = 'tabtin:session-share:pending-intents:v1'

export interface StoredPendingShareIntent {
  clientRequestId: string
}

export function loadPendingShareIntents(
  storage: Pick<Storage, 'getItem'> = window.sessionStorage,
): Record<string, StoredPendingShareIntent> {
  try {
    const raw = storage.getItem(PENDING_SHARE_INTENTS_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, StoredPendingShareIntent] => {
        const value = entry[1] as Partial<StoredPendingShareIntent> | null
        return Boolean(
          value
          && typeof value.clientRequestId === 'string'
          && value.clientRequestId.length > 0
        )
      }),
    )
  } catch {
    return {}
  }
}

export function savePendingShareIntents(
  intents: Record<string, StoredPendingShareIntent>,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = window.sessionStorage,
): void {
  try {
    if (Object.keys(intents).length === 0) {
      storage.removeItem(PENDING_SHARE_INTENTS_STORAGE_KEY)
      return
    }
    storage.setItem(PENDING_SHARE_INTENTS_STORAGE_KEY, JSON.stringify(intents))
  } catch {
    // sessionStorage 可能被浏览器策略禁用；调用方可另持 ref 提供本次打开期间的幂等。
  }
}

export function rememberPendingShareIntent(
  intentKey: string,
  clientRequestId: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = window.sessionStorage,
): void {
  savePendingShareIntents({
    ...loadPendingShareIntents(storage),
    [intentKey]: {
      clientRequestId,
    },
  }, storage)
}

export function forgetPendingShareIntent(
  intentKey: string,
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = window.sessionStorage,
): void {
  const intents = loadPendingShareIntents(storage)
  delete intents[intentKey]
  savePendingShareIntents(intents, storage)
}

export function forgetPendingShareIntentForShare(
  params: { sessionId: string; granteeUserId: string; tier: string },
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = window.sessionStorage,
): void {
  const intents = loadPendingShareIntents(storage)
  for (const intentKey of Object.keys(intents)) {
    try {
      const parsed: unknown = JSON.parse(intentKey)
      if (
        Array.isArray(parsed)
        && parsed[1] === params.sessionId
        && parsed[2] === params.granteeUserId
        && parsed[3] === params.tier
      ) {
        delete intents[intentKey]
      }
    } catch {
      // 非当前格式的历史 key 保留，避免误删其它客户端状态。
    }
  }
  savePendingShareIntents(intents, storage)
}

export function resolvePendingShareClientRequestId(options: {
  intentKey: string
  memoryIntent: { key: string; clientRequestId: string } | null
  createId?: () => string
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
}): string {
  const storage = options.storage ?? window.sessionStorage
  const createId = options.createId ?? createClientRequestId
  if (options.memoryIntent?.key === options.intentKey) {
    return options.memoryIntent.clientRequestId
  }
  return loadPendingShareIntents(storage)[options.intentKey]?.clientRequestId ?? createId()
}

export function buildSessionShareIntentKey(params: {
  organizationId: string | null | undefined
  sessionId: string
  granteeUserId: string
  tier: string
}): string {
  return JSON.stringify([
    params.organizationId ?? null,
    params.sessionId,
    params.granteeUserId,
    params.tier,
  ])
}
