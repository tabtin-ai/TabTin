import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetFailedMessageEditResendForTests,
  armFailedMessageEditResend,
  takeFailedMessageEditResend,
} from '../failedMessageEditResend'
import { runDraftMessageSendPreflight } from '../draftMessageSendPreflight'
import type { LocalChatMessage } from '../../../shared/types'

const mocks = vi.hoisted(() => ({
  preflightCommit: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('../../../session/draftMessageSessionCoordinator', () => ({
  commitDraftMessageConfigBeforeSend: (...args: unknown[]) =>
    mocks.preflightCommit(...args),
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: (...args: unknown[]) => mocks.toast(...args),
}))

vi.mock('@/i18n', () => ({
  default: { t: (_k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? _k },
}))

vi.mock('@/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  createLogger: () => ({
    warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn(),
  }),
}))

describe('failedMessageEditResend + preflight ( C)', () => {
  beforeEach(() => {
    __resetFailedMessageEditResendForTests()
    mocks.preflightCommit.mockReset()
    mocks.toast.mockReset()
  })

  it('编辑→发送 commit 再失败：气泡仍可重试；随后成功放行', async () => {
    armFailedMessageEditResend('sess-1', 'msg-failed')
    const reusedId = takeFailedMessageEditResend('sess-1')
    expect(reusedId).toBe('msg-failed')

    const messages: LocalChatMessage[] = [{
      id: 'msg-failed',
      role: 'user',
      content: 'edited text',
      created_at: '2026-03-13T00:00:00.000Z',
      sendStatus: 'sending',
    } as LocalChatMessage]
    const updateSessionMessages = vi.fn((
      _sid: string,
      updater: (msgs: LocalChatMessage[]) => LocalChatMessage[],
    ) => {
      messages.splice(0, messages.length, ...updater(messages))
    })

    mocks.preflightCommit.mockResolvedValueOnce({ ok: false, reason: 'agent_bind_failed' })
    const fail = await runDraftMessageSendPreflight({
      sessionId: 'sess-1',
      existingClientMessageId: reusedId,
      patchSessionAgent: vi.fn(),
      getSession: () => ({ id: 'sess-1', agent_id: 'old' }),
      updateSessionInCaches: vi.fn(),
      updateSessionMessages,
    })
    expect(fail.blocked).toBe(true)
    expect(messages[0]?.sendStatus).toBe('failed')
    expect(messages[0]?.content).toBe('edited text')

    mocks.preflightCommit.mockResolvedValueOnce({ ok: true, applied: true })
    const ok = await runDraftMessageSendPreflight({
      sessionId: 'sess-1',
      existingClientMessageId: 'msg-failed',
      patchSessionAgent: vi.fn(),
      getSession: () => ({ id: 'sess-1', agent_id: 'old' }),
      updateSessionInCaches: vi.fn(),
      updateSessionMessages,
    })
    expect(ok.blocked).toBe(false)
  })
})
