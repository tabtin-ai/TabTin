import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dispatchComposerSend } from '../dispatchComposerSend'

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: vi.fn(() => ({
      replyTargetBySessionId: {},
      clearReplyTarget: vi.fn(),
    })),
  },
}))

vi.mock('@/stores/useComposerPresetStore', () => ({
  useComposerPresetStore: {
    getState: () => ({
      clearAllPresets: vi.fn(),
    }),
  },
}))

const t = ((key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key) as never

function baseInput(overrides: Partial<Parameters<typeof dispatchComposerSend>[0]> = {}) {
  return {
    sendRoute: 'direct' as const,
    message: 'hello',
    skillSendOptions: undefined,
    finalAttachments: undefined,
    finalBlocks: undefined,
    sessionId: 'session-1',
    resolvedPresetScopeId: null,
    allowInterruptedEditRecovery: false,
    onSend: vi.fn(),
    stopVoiceForSubmit: vi.fn(),
    clearInputState: vi.fn(),
    t,
    ...overrides,
  }
}

describe('dispatchComposerSend', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('direct route calls onSend and does not clear input (ACK 后再清)', async () => {
    const onSend = vi.fn()
    const clearInputState = vi.fn()

    await dispatchComposerSend(baseInput({ onSend, clearInputState }))

    expect(onSend).toHaveBeenCalledWith('hello', undefined, undefined, undefined)
    expect(clearInputState).not.toHaveBeenCalled()
  })

  it('includes reply target in send options', async () => {
    const onSend = vi.fn()
    const { useChatStore } = await import('@/stores/chat/useChatStore')
    vi.mocked(useChatStore.getState).mockReturnValueOnce({
      replyTargetBySessionId: {
        'session-1': {
          messageId: 'm1',
          preview: { role: 'user', text: 'quoted' },
        },
      },
      clearReplyTarget: vi.fn(),
    } as never)

    await dispatchComposerSend(baseInput({ onSend }))

    expect(onSend).toHaveBeenCalledWith(
      'hello',
      undefined,
      undefined,
      expect.objectContaining({
        replyTo: expect.objectContaining({ messageId: 'm1' }),
      }),
    )
  })
})
