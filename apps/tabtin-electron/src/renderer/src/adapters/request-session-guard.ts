/**
 * 401 会话守卫
 *
 * app-shell / 各 renderer service 走的 `apiRequest`（api-adapter-instance）
 * 历史上对 401 没有任何处理：token 失效后保存类操作只会抛通用「更新失败」，
 * 既不刷新重试，也不触发登出链路。
 *
 * 本守卫把主通道（api.ts requestViaProxy）的 401 语义对齐过来：
 *   1. 收到 401 → 调 `tryRefreshTokens`（复用 apiService 的带锁刷新，
 *      内部失败时已经走 handleRefreshFailure → 清凭证 → 登出链路）；
 *   2. 刷新成功 → 换新 token 重试一次原请求（不无限循环）；
 *   3. 刷新失败 → 抛出调用方注入的「会话已过期」错误，让 UI 显示明确的
 *      重新登录提示而不是通用错误文案。
 *
 * 依赖全部注入，模块本身零运行时依赖，便于单测。
 */

import type { TableHttpRequest, TableHttpResponse } from '@tabtin/table-core'

export interface SessionGuardDeps<T> {
  /** 实际发请求（通常是 electron adapter 的 request） */
  request: (options: TableHttpRequest) => Promise<TableHttpResponse<T>>
  /** 带锁 token 刷新；失败返回 null（内部已触发登出链路） */
  tryRefreshTokens: () => Promise<string | null>
  /** 刷新失败时要抛出的「会话已过期」错误 */
  createSessionExpiredError: (responseData: unknown) => Error
}

export async function requestWithSessionGuard<T>(
  deps: SessionGuardDeps<T>,
  options: TableHttpRequest,
): Promise<TableHttpResponse<T>> {
  const response = await deps.request(options)
  if (response.status !== 401) {
    return response
  }

  const newToken = await deps.tryRefreshTokens()
  if (!newToken) {
    throw deps.createSessionExpiredError(response.data)
  }

  return deps.request({
    ...options,
    headers: {
      ...options.headers,
      Authorization: `Bearer ${newToken}`,
    },
  })
}
