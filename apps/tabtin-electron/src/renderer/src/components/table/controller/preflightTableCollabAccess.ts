/**
 * Electron TabData：连接 Hocuspocus 前调用统一 collab auth。
 */
import { getAuthToken } from '@/adapters/api-adapter-instance'
import { API_CONFIG } from '@/config/api'
import { joinApiPath } from '@tabtin/config'
import {
  COLLAB_ACCESS_VERIFICATION_UNAVAILABLE,
  COLLAB_PERMISSION_DENIED,
  parseTableCollabAccessPayload,
  type TableCollabAccessDecision,
} from '@tabtin/table-engine/collab'
import { electronFetch } from '@/services/electronFetch'
import { createLogger } from '@/utils/logger'

const log = createLogger('TableCollabPreflight')

export async function preflightTableCollabAccess(
  tableId: string,
  parentDocumentId?: string | null,
): Promise<TableCollabAccessDecision | null> {
  const token = await getAuthToken()
  const url = joinApiPath(
    API_CONFIG.baseURL,
    `/collab/v1/table/${encodeURIComponent(tableId)}/auth`,
  )
  const normalizedParentDocumentId = parentDocumentId?.trim()
  const resp = await electronFetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(normalizedParentDocumentId
        ? { 'X-TabTin-Parent-Document-Id': normalizedParentDocumentId }
        : {}),
    },
  })

  if (!resp.ok) {
    const accessVerificationUnavailable = resp.headers?.get?.(
      'x-tabtin-embedded-access-unavailable',
    ) === '1'
    // 明确 403 是业务终态，不得 fall-through 建 Provider 形成 4403 重连风暴。
    if (resp.status === 403) {
      const reason = accessVerificationUnavailable
        ? COLLAB_ACCESS_VERIFICATION_UNAVAILABLE
        : COLLAB_PERMISSION_DENIED
      log.warn('collab auth preflight denied', {
        tableId,
        parentDocumentId: normalizedParentDocumentId,
        reason,
      })
      return {
        authorized: false,
        reason,
      }
    }
    // 其它非契约失败：抛出让上层按瞬态故障 fall-through。
    log.warn('collab auth preflight non-OK', { tableId, status: resp.status })
    throw new Error(`collab_auth_preflight_http_${resp.status}`)
  }

  const json = await resp.json().catch(() => null)
  const decision = parseTableCollabAccessPayload(json)
  if (decision) {
    log.info('collab auth preflight', {
      tableId,
      authorized: decision.authorized,
      collab_mode: decision.collab_mode,
      reason: decision.reason,
      visible_field_count: decision.visible_field_count,
      total_field_count: decision.total_field_count,
    })
  }
  return decision
}
