import { API_ENDPOINTS } from '@tabtin/config'
import { djangoRequest } from '../cli/routes/shared/error-handler'
import { createLogger } from '../logger'

const log = createLogger('SpaceAccessGuard')

/**
 * 校验「当前登录用户对目标 spaceId 有权限」失败时抛出的错误。
 *
 * `reason` 区分三种拒绝语义，便于调用方按需处理 / 埋点，但对调用方而言
 * 三种都应 fail-closed（拒绝这次操作）：
 * - `unauthenticated`：主进程无有效登录态，无法代表任何用户校验权限。
 * - `forbidden`：后端明确判定当前用户对该 Space 无 viewer 权限（403/404）。
 * - `unverifiable`：后端不可达 / 5xx / 超时，无法确认权限——安全优先，按拒绝处理。
 */
export class SpaceAccessDeniedError extends Error {
  readonly spaceId: string
  readonly reason: 'unauthenticated' | 'forbidden' | 'unverifiable'

  constructor(
    spaceId: string,
    reason: 'unauthenticated' | 'forbidden' | 'unverifiable',
    message: string,
  ) {
    super(message)
    this.name = 'SpaceAccessDeniedError'
    this.spaceId = spaceId
    this.reason = reason
  }
}

/**
 * 断言当前登录用户对 `spaceId` 至少有 viewer 权限，否则抛 {@link SpaceAccessDeniedError}。
 *
 * 权限判定**以后端为权威**：委托 `GET /context/workspaces/{id}`（个人域 SSoT），
 * 后端在无 viewer 权限时返回 404、显式拒绝时返回 403。主进程不缓存「可访问 Space 列表」——
 * 那份状态只存在于 renderer 的 space store，与主进程不同步，且成员变更后难保证一致。
 *
 * fail-closed：任何非 200（含未登录、无权限、后端不可达）都拒绝，绝不放行。
 */
export async function assertCurrentUserCanAccessSpace(spaceId: string): Promise<void> {
  const trimmed = typeof spaceId === 'string' ? spaceId.trim() : ''
  if (!trimmed) {
    throw new SpaceAccessDeniedError(String(spaceId), 'forbidden', 'spaceId 为空，无法校验 Space 权限')
  }

  const result = await djangoRequest('GET', API_ENDPOINTS.WORKSPACE.DETAIL(trimmed), undefined, {
    logTag: '[SpaceAccessGuard]',
  })

  if (result.status === 200) {
    return
  }

  if (result.status === 401) {
    log.warn(`Space 权限校验失败：未登录 spaceId=${trimmed}`)
    throw new SpaceAccessDeniedError(trimmed, 'unauthenticated', `未登录，无法校验 Space 权限: ${trimmed}`)
  }

  if (result.status === 403 || result.status === 404) {
    log.warn(`Space 权限校验拒绝：spaceId=${trimmed} status=${result.status}`)
    throw new SpaceAccessDeniedError(trimmed, 'forbidden', `当前用户无权访问 Space: ${trimmed}`)
  }

  log.warn(`Space 权限无法确认（fail-closed）：spaceId=${trimmed} status=${result.status}`)
  throw new SpaceAccessDeniedError(
    trimmed,
    'unverifiable',
    `无法校验 Space 权限（后端不可达 status=${result.status}）: ${trimmed}`,
  )
}
