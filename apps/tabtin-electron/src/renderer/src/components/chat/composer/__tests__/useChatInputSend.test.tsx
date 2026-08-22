import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockFinalizeComposerSend,
  mockPreviewFunding,
  mockToastInfo,
} = vi.hoisted(() => ({
  mockFinalizeComposerSend: vi.fn(),
  mockPreviewFunding: vi.fn(),
  mockToastInfo: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: {
    error: vi.fn(),
    info: mockToastInfo,
    warning: vi.fn(),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue || _key,
  }),
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    models: {
      previewFunding: mockPreviewFunding,
    },
  }),
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      getEffectiveOrganizationId: () => 'org-1',
    }),
  },
}))

vi.mock('../useComposerAttachmentUploads', () => ({
  isAttachmentStillUploading: () => false,
}))

vi.mock('../send/prepareComposerSendContent', () => ({
  prepareComposerSendContent: () => ({
    compactArgs: null,
    hasContent: true,
    message: '你好',
    unrecognizedSlashToken: null,
  }),
}))

vi.mock('../send/mergePresetSendPayload', () => ({
  mergePresetSendPayload: () => ({
    attachments: [],
    blocks: [],
    ok: true,
  }),
}))

vi.mock('../send/finalizeComposerSend', () => ({
  finalizeComposerSend: mockFinalizeComposerSend,
}))

import { useChatInputSend } from '../useChatInputSend'

describe('useChatInputSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPreviewFunding.mockResolvedValue({
      funding_preview: [{
        credits: '1.0000',
        source_type: 'monthly_budget',
      }],
    })
  })

  it('正常资金来源不触发发送前预览或 toast', () => {
    const { result } = renderHook(() => useChatInputSend({
      activePresets: [],
      allContextRefs: [],
      allowInterruptedEditRecovery: false,
      attachments: [],
      buildContextBlocks: () => [],
      clearInputState: vi.fn(),
      conversationReferenceRefs: [],
      disabled: false,
      handleManualCompact: vi.fn(),
      hasActivePresets: false,
      input: '你好',
      onSend: vi.fn(),
      resolvedPresetScopeId: null,
      sessionId: 'session-1',
      slashOptions: [],
      spaceId: 'space-1',
      stopVoiceForSubmit: vi.fn(),
      wsDisconnected: false,
    }))

    act(() => result.current.handleSend())

    expect(mockPreviewFunding).not.toHaveBeenCalled()
    expect(mockToastInfo).not.toHaveBeenCalled()
    expect(mockFinalizeComposerSend).toHaveBeenCalledOnce()
  })
})
