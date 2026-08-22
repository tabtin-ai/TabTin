import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  BILLING_ERROR_RESOLVED_META_KEY,
  clearBalanceBillingErrorsInChatStore,
  isBalanceBillingErrorMessage,
  isResolvedBalanceBillingErrorMessage,
} from '../clearBalanceBillingChatErrors'

const { patchMessageById, messagesBySessionId } = vi.hoisted(() => {
  const messagesBySessionId: Record<string, ChatMessage[]> = {}
  return {
    messagesBySessionId,
    patchMessageById: vi.fn((sessionId: string, messageId: string, patcher: (m: ChatMessage) => ChatMessage) => {
      const list = messagesBySessionId[sessionId]
      if (!list) return
      const idx = list.findIndex((m) => m.id === messageId)
      if (idx < 0) return
      list[idx] = patcher(list[idx])
    }),
  }
})

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      messagesBySessionId,
      patchMessageById,
    }),
  },
}))

function makeMsg(
  id: string,
  metadata: Record<string, unknown>,
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    metadata,
  } as ChatMessage
}

describe('clearBalanceBillingChatErrors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(messagesBySessionId)) {
      delete messagesBySessionId[key]
    }
  })

  it('识别 organization_insufficient_credits 为余额不足卡', () => {
    expect(isBalanceBillingErrorMessage(makeMsg('a', {
      errorCategory: 'organization_insufficient_credits',
      errorClass: 'LLM_BILLING_ORG_INSUFFICIENT',
      isErrorMessage: true,
    }))).toBe(true)
  })

  it('已消警消息不再识别为余额不足', () => {
    const message = makeMsg('a', {
      errorCategory: 'organization_insufficient_credits',
      errorClass: 'LLM_BILLING_ORG_INSUFFICIENT',
      [BILLING_ERROR_RESOLVED_META_KEY]: true,
    })
    expect(isBalanceBillingErrorMessage(message)).toBe(false)
    expect(isResolvedBalanceBillingErrorMessage(message)).toBe(true)
  })

  it('充值后批量标记余额不足消息为已消警，不写运行态投影', () => {
    messagesBySessionId['s1'] = [
      makeMsg('billing-err', {
        errorCategory: 'organization_insufficient_credits',
        errorClass: 'LLM_BILLING_ORG_INSUFFICIENT',
        isErrorMessage: true,
      }),
      makeMsg('ok', { foo: 1 }),
      makeMsg('network-err', {
        errorCategory: 'network',
        errorClass: 'LLM_ERROR',
        isErrorMessage: true,
      }),
    ]

    const marked = clearBalanceBillingErrorsInChatStore()

    expect(marked).toBe(1)
    expect(messagesBySessionId.s1[0].metadata).toMatchObject({
      errorCategory: 'organization_insufficient_credits',
      [BILLING_ERROR_RESOLVED_META_KEY]: true,
    })
    expect(messagesBySessionId.s1[2].metadata).not.toHaveProperty(BILLING_ERROR_RESOLVED_META_KEY)
  })
})
