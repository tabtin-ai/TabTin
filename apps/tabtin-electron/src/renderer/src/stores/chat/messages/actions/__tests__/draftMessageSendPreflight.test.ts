import { beforeEach, describe, expect, it, vi } from 'vitest'
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

import { runDraftMessageSendPreflight } from '../draftMessageSendPreflight'

describe('runDraftMessageSendPreflight ', () => {
  beforeEach(() => {
    mocks.preflightCommit.mockReset()
    mocks.toast.mockReset()
  })

  it('A. bind fail → blocked + 气泡 failed；第二次成功放行', async () => {
    const messages: LocalChatMessage[] = [{
      id: 'msg-1',
      role: 'user',
      content: 'hello',
      created_at: '2026-03-13T00:00:00.000Z',
      sendStatus: 'sending',
    } as LocalChatMessage]
    const updateSessionMessages = vi.fn((
      _sid: string,
      updater: (msgs: LocalChatMessage[]) => LocalChatMessage[],
    ) => {
      messages.splice(0, messages.length, ...updater(messages))
    })

    const patchSessionAgent = vi.fn()
    mocks.preflightCommit.mockResolvedValueOnce({ ok: false, reason: 'agent_bind_failed' })
    const fail = await runDraftMessageSendPreflight({
      sessionId: 'sess-1',
      existingClientMessageId: 'msg-1',
      patchSessionAgent,
      getSession: () => ({ id: 'sess-1', agent_id: 'agent-old' }),
      updateSessionInCaches: vi.fn(),
      updateSessionMessages,
    })
    expect(fail.blocked).toBe(true)
    expect(messages[0]?.sendStatus).toBe('failed')
    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringContaining('绑定 Agent') }),
    )

    mocks.preflightCommit.mockResolvedValueOnce({
      ok: true,
      applied: true,
      agentId: 'agent-new',
    })
    const ok = await runDraftMessageSendPreflight({
      sessionId: 'sess-1',
      existingClientMessageId: 'msg-1',
      expectedDraftMessageId: 'ep-1',
      patchSessionAgent,
      getSession: () => ({ id: 'sess-1', agent_id: 'agent-old' }),
      updateSessionInCaches: vi.fn(),
      updateSessionMessages,
    })
    expect(ok.blocked).toBe(false)
    expect(mocks.preflightCommit).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedDraftMessageId: 'ep-1',
        patchSessionAgent,
      }),
    )
  })

  it('B/E. 任意 ok:false（含 cancelled / not_draft_message）都 blocked；toast 文案分 reason', async () => {
    const patchSessionAgent = vi.fn()
    for (const reason of ['cancelled', 'draft_message_mismatch', 'not_draft_message', 'agent_bind_failed'] as const) {
      mocks.toast.mockReset()
      mocks.preflightCommit.mockResolvedValueOnce({ ok: false, reason })
      const outcome = await runDraftMessageSendPreflight({
        sessionId: 'sess-1',
        existingClientMessageId: 'msg-1',
        patchSessionAgent,
        getSession: () => undefined,
        updateSessionInCaches: vi.fn(),
        updateSessionMessages: vi.fn(),
      })
      expect(outcome.blocked).toBe(true)
      expect(mocks.toast).toHaveBeenCalled()
      const title = mocks.toast.mock.calls[0]?.[0]?.title as string
      if (reason === 'agent_bind_failed') {
        expect(title).toContain('绑定 Agent')
      } else if (reason === 'cancelled' || reason === 'draft_message_mismatch') {
        expect(title).not.toContain('绑定 Agent')
      }
    }
  })

  it('普通 session preflight ok applied:false → 不挡发送', async () => {
    mocks.preflightCommit.mockResolvedValueOnce({ ok: true, applied: false })
    const outcome = await runDraftMessageSendPreflight({
      sessionId: 'sess-active',
      patchSessionAgent: vi.fn(),
      getSession: () => ({ id: 'sess-active', agent_id: 'a' }),
      updateSessionInCaches: vi.fn(),
      updateSessionMessages: vi.fn(),
    })
    expect(outcome.blocked).toBe(false)
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
