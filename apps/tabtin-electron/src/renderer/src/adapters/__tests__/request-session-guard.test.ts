/**
 * 401 会话守卫单测
 *
 * 覆盖 `requestWithSessionGuard` 的四个分支：
 *   1. 非 401 响应原样透传，不触发刷新
 *   2. 401 → 刷新成功 → 带新 Authorization 重试一次
 *   3. 401 → 刷新失败 → 抛「会话已过期」错误（登出链路由 tryRefreshTokens 内部触发）
 *   4. 401 → 刷新成功但重试仍 401 → 不再二次刷新（防循环）
 */
import { describe, it, expect, vi } from 'vitest'
import { requestWithSessionGuard } from '../request-session-guard'
import type { TableHttpRequest, TableHttpResponse } from '@tabtin/table-core'

const BASE_OPTIONS: TableHttpRequest = {
  url: '/agents/agent-1',
  method: 'PUT',
  headers: { Authorization: 'Bearer stale-token', 'Content-Type': 'application/json' },
  body: JSON.stringify({ working_dir: '/tmp/demo' }),
}

function response(status: number, data: unknown = null): TableHttpResponse<unknown> {
  return { status, data } as TableHttpResponse<unknown>
}

function createSessionExpiredError(data: unknown): Error {
  const err = new Error('登录已过期，请重新登录') as Error & { data?: unknown }
  err.data = data
  return err
}

describe('requestWithSessionGuard ', () => {
  it('非 401 响应原样透传，不触发刷新', async () => {
    const request = vi.fn().mockResolvedValue(response(200, { success: true }))
    const tryRefreshTokens = vi.fn()

    const result = await requestWithSessionGuard(
      { request, tryRefreshTokens, createSessionExpiredError },
      BASE_OPTIONS,
    )

    expect(result.status).toBe(200)
    expect(request).toHaveBeenCalledOnce()
    expect(tryRefreshTokens).not.toHaveBeenCalled()
  })

  it('401 且刷新成功时带新 token 重试一次', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(response(401, { message: 'token expired' }))
      .mockResolvedValueOnce(response(200, { success: true }))
    const tryRefreshTokens = vi.fn().mockResolvedValue('fresh-token')

    const result = await requestWithSessionGuard(
      { request, tryRefreshTokens, createSessionExpiredError },
      BASE_OPTIONS,
    )

    expect(result.status).toBe(200)
    expect(tryRefreshTokens).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
    const retryOptions = request.mock.calls[1][0] as TableHttpRequest
    expect(retryOptions.headers?.Authorization).toBe('Bearer fresh-token')
    // 其余请求参数保持不变
    expect(retryOptions.url).toBe(BASE_OPTIONS.url)
    expect(retryOptions.method).toBe(BASE_OPTIONS.method)
    expect(retryOptions.body).toBe(BASE_OPTIONS.body)
    expect(retryOptions.headers?.['Content-Type']).toBe('application/json')
  })

  it('401 且刷新失败时抛出明确的会话过期错误', async () => {
    const request = vi.fn().mockResolvedValue(response(401, { message: 'token expired' }))
    const tryRefreshTokens = vi.fn().mockResolvedValue(null)

    await expect(
      requestWithSessionGuard(
        { request, tryRefreshTokens, createSessionExpiredError },
        BASE_OPTIONS,
      ),
    ).rejects.toThrow('登录已过期，请重新登录')

    expect(request).toHaveBeenCalledOnce()
    expect(tryRefreshTokens).toHaveBeenCalledOnce()
  })

  it('重试后仍 401 时不再二次刷新（防循环）', async () => {
    const request = vi.fn().mockResolvedValue(response(401, { message: 'still unauthorized' }))
    const tryRefreshTokens = vi.fn().mockResolvedValue('fresh-token')

    const result = await requestWithSessionGuard(
      { request, tryRefreshTokens, createSessionExpiredError },
      BASE_OPTIONS,
    )

    expect(result.status).toBe(401)
    expect(request).toHaveBeenCalledTimes(2)
    expect(tryRefreshTokens).toHaveBeenCalledOnce()
  })
})
