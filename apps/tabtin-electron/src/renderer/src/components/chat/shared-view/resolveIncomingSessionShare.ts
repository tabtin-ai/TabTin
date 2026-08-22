import {
  getSessionShare,
  listIncomingSessionShares,
  type SessionShareInfo,
} from '@/services/tabchatApi'

interface AccessWatermark {
  objectId: string
  version: number
  accessEpoch: number
}

const RESTORE_RETRY_DELAYS_MS = [0, 250, 500, 1_000]

function hasReachedWatermark(share: SessionShareInfo, target: AccessWatermark): boolean {
  return share.id !== target.objectId || (
    (share.version ?? 0) >= target.version
    && (share.access_epoch ?? 0) >= target.accessEpoch
  )
}

const wait = (delay: number) => new Promise(resolve => setTimeout(resolve, delay))

/** 与共享卡入口统一：按会话解析当前组织最新有效的 incoming 授权。 */
export async function resolveIncomingSessionShare(
  organizationId: string,
  sessionId: string,
): Promise<SessionShareInfo | null> {
  const shares = await listIncomingSessionShares(organizationId)
  return shares.find(share => share.session_id === sessionId) ?? null
}

/** 恢复标签优先验证原授权；原授权失效时才切换到同会话的最新有效授权。 */
export async function resolveRestoredIncomingSessionShare(
  organizationId: string,
  sessionId: string,
  shareId: string,
  target: AccessWatermark | null = null,
): Promise<SessionShareInfo | null> {
  const delays = target ? RESTORE_RETRY_DELAYS_MS : [0]
  let lastError: unknown = null
  for (const delay of delays) {
    if (delay) await wait(delay)
    try {
      const current = await getSessionShare(shareId)
      if (
        current.status === 'active'
        && current.session_id === sessionId
        && (!target || hasReachedWatermark(current, target))
      ) return current
    } catch (error) {
      lastError = error
    }
    try {
      const latest = await resolveIncomingSessionShare(organizationId, sessionId)
      if (latest && (!target || hasReachedWatermark(latest, target))) return latest
      lastError = null
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) throw lastError
  return null
}
