import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionById: vi.fn(),
  refreshPromotionCredits: vi.fn(),
  availableModels: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({ getSessionById: mocks.getSessionById }),
  },
}))

vi.mock('@/stores/useChatModelStore', () => ({
  useChatModelStore: {
    getState: () => ({
      availableModels: mocks.availableModels,
      loadedOrganizationId: 'org-a',
      refreshPromotionCredits: mocks.refreshPromotionCredits,
    }),
  },
}))

import { refreshPromotionCreditAfterDone } from '../promotionCreditRefresh'

describe('refreshPromotionCreditAfterDone', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.availableModels = []
    mocks.getSessionById.mockReturnValue({
      id: 'session-1',
      organization_id: 'org-a',
      current_model_id: 'model-1',
    })
  })

  it('专项点券模型结算完成后刷新当前组织余额', () => {
    mocks.availableModels = [{
      id: 'model-1',
      promotion_credit: {
        eligible: true,
        remaining_credits: 10,
        total_credits: 10,
      },
    }]

    refreshPromotionCreditAfterDone('session-1')

    expect(mocks.refreshPromotionCredits).toHaveBeenCalledWith('org-a')
  })

  it('普通模型结算完成后不产生额外目录请求', () => {
    mocks.availableModels = [{ id: 'model-1', promotion_credit: null }]

    refreshPromotionCreditAfterDone('session-1')

    expect(mocks.refreshPromotionCredits).not.toHaveBeenCalled()
  })

  it('后台旧组织会话完成时不刷新当前前台组织', () => {
    mocks.getSessionById.mockReturnValue({
      id: 'session-1',
      organization_id: 'org-b',
      current_model_id: 'model-1',
    })
    mocks.availableModels = [{
      id: 'model-1',
      promotion_credit: {
        eligible: true,
        remaining_credits: 10,
        total_credits: 10,
      },
    }]

    refreshPromotionCreditAfterDone('session-1')

    expect(mocks.refreshPromotionCredits).not.toHaveBeenCalled()
  })
})
