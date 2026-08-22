/**
 *  回归：Space 权限校验（fail-closed）。
 *
 * assertCurrentUserCanAccessSpace 委托后端 GET /context/workspaces/{id}：
 * - 200 → 放行
 * - 401 → unauthenticated（未登录）
 * - 403/404 → forbidden（无 viewer 权限）
 * - 其它/后端不可达 → unverifiable（fail-closed，拒绝）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  djangoRequest: vi.fn(),
}))

vi.mock('../../cli/routes/shared/error-handler', () => ({
  djangoRequest: mocks.djangoRequest,
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { assertCurrentUserCanAccessSpace, SpaceAccessDeniedError } from '../space-access-guard'

const SPACE_ID = 'space-123'

describe('assertCurrentUserCanAccessSpace', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('后端 200：有权限，放行（不抛）', async () => {
    mocks.djangoRequest.mockResolvedValue({ status: 200, data: { id: SPACE_ID } })
    await expect(assertCurrentUserCanAccessSpace(SPACE_ID)).resolves.toBeUndefined()
    expect(mocks.djangoRequest).toHaveBeenCalledWith(
      'GET',
      `/context/workspaces/${SPACE_ID}`,
      undefined,
      expect.objectContaining({ logTag: expect.any(String) }),
    )
  })

  it('后端 401：未登录 → unauthenticated', async () => {
    mocks.djangoRequest.mockResolvedValue({ status: 401, data: {} })
    await expect(assertCurrentUserCanAccessSpace(SPACE_ID)).rejects.toMatchObject({
      name: 'SpaceAccessDeniedError',
      reason: 'unauthenticated',
      spaceId: SPACE_ID,
    })
  })

  it.each([403, 404])('后端 %s：无权限 → forbidden', async (status) => {
    mocks.djangoRequest.mockResolvedValue({ status, data: {} })
    await expect(assertCurrentUserCanAccessSpace(SPACE_ID)).rejects.toMatchObject({
      reason: 'forbidden',
    })
  })

  it.each([500, 502, 504])('后端 %s：不可达 → unverifiable（fail-closed）', async (status) => {
    mocks.djangoRequest.mockResolvedValue({ status, data: {} })
    await expect(assertCurrentUserCanAccessSpace(SPACE_ID)).rejects.toMatchObject({
      reason: 'unverifiable',
    })
  })

  it('spaceId 为空：直接拒绝，不打后端', async () => {
    await expect(assertCurrentUserCanAccessSpace('   ')).rejects.toBeInstanceOf(SpaceAccessDeniedError)
    expect(mocks.djangoRequest).not.toHaveBeenCalled()
  })
})
