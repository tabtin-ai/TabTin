/**
 * TabData 协作准入契约
 *
 * 后端 `GET /collab/v1/table/{id}/auth` 在字段可见性受限时返回：
 * `{ authorized: false, collab_mode: "rest_projection", reason: "field_visibility_restricted" }`
 * 客户端必须在创建 HocuspocusProvider 前消费该契约，不得重试进房。
 */

export type TableCollabMode = 'full' | 'rest_projection'

export interface TableCollabAccessDecision {
  authorized: boolean
  collab_mode?: TableCollabMode | string | null
  reason?: string | null
  visible_field_count?: number
  total_field_count?: number
  hidden_field_count?: number
}

/** 与后端 `COLLAB_DENY_REASON_FIELD_VISIBILITY` / `COLLAB_MODE_REST_PROJECTION` 对齐 */
export const FIELD_VISIBILITY_RESTRICTED = 'field_visibility_restricted'
export const COLLAB_PERMISSION_DENIED = 'permission_denied'
export const COLLAB_ACCESS_VERIFICATION_UNAVAILABLE = 'access_verification_unavailable'
export const COLLAB_MODE_REST_PROJECTION = 'rest_projection'
export const PARENT_DOCUMENT_PARAMETER = 'parent_document_id'

export function buildTableCollabConnectionParameters(
  parentDocumentId: string | null | undefined,
): Record<string, string> | undefined {
  const normalized = parentDocumentId?.trim()
  return normalized ? { [PARENT_DOCUMENT_PARAMETER]: normalized } : undefined
}

export function resolveTableCollabDeniedReason(
  decision: TableCollabAccessDecision | null | undefined,
):
  | typeof FIELD_VISIBILITY_RESTRICTED
  | typeof COLLAB_PERMISSION_DENIED
  | typeof COLLAB_ACCESS_VERIFICATION_UNAVAILABLE {
  if (decision?.reason === FIELD_VISIBILITY_RESTRICTED) {
    return FIELD_VISIBILITY_RESTRICTED
  }
  if (decision?.reason === COLLAB_ACCESS_VERIFICATION_UNAVAILABLE) {
    return COLLAB_ACCESS_VERIFICATION_UNAVAILABLE
  }
  return COLLAB_PERMISSION_DENIED
}

/**
 * 判断 auth/preflight 响应是否要求 REST 投影降级（业务终态，禁止建 Y.Doc 连接）。
 */
export function isRestProjectionAccess(
  decision: TableCollabAccessDecision | null | undefined,
): boolean {
  if (!decision) return false
  return (
    decision.collab_mode === COLLAB_MODE_REST_PROJECTION
    || decision.reason === FIELD_VISIBILITY_RESTRICTED
    || decision.authorized === false
  )
}

/**
 * 从 Django 统一 envelope（`{ status, data }`）或裸 data 中取出准入决策。
 */
export function parseTableCollabAccessPayload(
  payload: unknown,
): TableCollabAccessDecision | null {
  if (!payload || typeof payload !== 'object') return null
  const root = payload as Record<string, unknown>
  const data = (root.data && typeof root.data === 'object'
    ? root.data
    : root) as Record<string, unknown>

  if (
    typeof data.authorized !== 'boolean'
    && data.collab_mode == null
    && data.reason == null
  ) {
    return null
  }

  return {
    authorized: data.authorized === true,
    collab_mode: typeof data.collab_mode === 'string' ? data.collab_mode : null,
    reason: typeof data.reason === 'string' ? data.reason : null,
    visible_field_count:
      typeof data.visible_field_count === 'number' ? data.visible_field_count : undefined,
    total_field_count:
      typeof data.total_field_count === 'number' ? data.total_field_count : undefined,
    hidden_field_count:
      typeof data.hidden_field_count === 'number' ? data.hidden_field_count : undefined,
  }
}
