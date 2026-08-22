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

import { AgentAccessDeniedError, assertCurrentUserCanAccessAgent } from '../agent-access-guard'

const AGENT_ID = 'agent-123'

describe('assertCurrentUserCanAccessAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('后端 200 时放行', async () => {
    mocks.djangoRequest.mockResolvedValue({ status: 200, data: { id: AGENT_ID } })

    await expect(assertCurrentUserCanAccessAgent(AGENT_ID)).resolves.toBeUndefined()
    expect(mocks.djangoRequest).toHaveBeenCalledWith(
      'GET',
      `/agents/${AGENT_ID}`,
      undefined,
      expect.objectContaining({ logTag: expect.any(String) }),
    )
  })

  it('后端 401 时按未登录拒绝', async () => {
    mocks.djangoRequest.mockResolvedValue({ status: 401, data: {} })

    await expect(assertCurrentUserCanAccessAgent(AGENT_ID)).rejects.toMatchObject({
      name: 'AgentAccessDeniedError',
      reason: 'unauthenticated',
      agentId: AGENT_ID,
    })
  })

  it.each([403, 404])('后端 %s 时按无权限拒绝', async (status) => {
    mocks.djangoRequest.mockResolvedValue({ status, data: {} })

    await expect(assertCurrentUserCanAccessAgent(AGENT_ID)).rejects.toMatchObject({
      reason: 'forbidden',
    })
  })

  it.each([500, 502, 504])('后端 %s 时 fail-closed', async (status) => {
    mocks.djangoRequest.mockResolvedValue({ status, data: {} })

    await expect(assertCurrentUserCanAccessAgent(AGENT_ID)).rejects.toMatchObject({
      reason: 'unverifiable',
    })
  })

  it('agentId 为空时直接拒绝', async () => {
    await expect(assertCurrentUserCanAccessAgent(' ')).rejects.toBeInstanceOf(AgentAccessDeniedError)
    expect(mocks.djangoRequest).not.toHaveBeenCalled()
  })
})
