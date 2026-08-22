import { beforeEach, describe, expect, it, vi } from 'vitest'

const authenticatedRequest = vi.fn()

vi.mock('./base.js', () => ({
  authenticatedRequest: (...args: unknown[]) => authenticatedRequest(...args),
  apiBaseUrl: () => 'https://api.tabtin.test/api',
  formatApiErrorMessage: vi.fn(),
}))

import { AgentApiService } from './space-api.js'

describe('AgentApiService.reactivateAgent', () => {
  beforeEach(() => {
    authenticatedRequest.mockReset()
  })

  it('returns the restored Agent from the success envelope', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: { id: 'agent-1', name: '恢复后的分身', is_active: true },
      },
    })

    await expect(AgentApiService.reactivateAgent('agent-1')).resolves.toMatchObject({
      id: 'agent-1',
      is_active: true,
    })
    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/agents/agent-1/reactivate',
      method: 'POST',
    })
  })

  it('rejects a successful response without Agent data', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: { success: true, message: '恢复成功' },
    })

    await expect(AgentApiService.reactivateAgent('agent-1')).rejects.toThrow(
      'Invalid reactivate agent response',
    )
  })
})

describe('AgentApiService.permanentDeleteAgent', () => {
  beforeEach(() => {
    authenticatedRequest.mockReset()
  })

  it('uses the dedicated permanent deletion endpoint', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: { success: true },
    })

    await expect(AgentApiService.permanentDeleteAgent('agent-1')).resolves.toBeUndefined()
    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/agents/agent-1/permanent',
      method: 'DELETE',
    })
  })

  it('surfaces a rejected permanent deletion response', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: { success: false, message: '仍有执行记录' },
    })

    await expect(AgentApiService.permanentDeleteAgent('agent-1')).rejects.toThrow(
      '仍有执行记录',
    )
  })
})
