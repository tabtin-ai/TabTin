/**
 *  方案 A：轮末 checkpoint 行为测——list 只算锚点，不得写 messagesBySessionId。
 * ：pending 队列 FIFO consume；无 pending 时不 createCheckpoint。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { CheckpointPendingContext } from '../../../checkpoint/handlers/checkpointAnchor'

const createCheckpoint = vi.fn().mockResolvedValue(undefined)
const consumeCheckpointPendingContext = vi.fn()
const clearCheckpointPendingContext = vi.fn()
const setSessionMessages = vi.fn()
const replaceFromRollback = vi.fn()
const setCheckpointBaseline = vi.fn()

const pendingCtx: CheckpointPendingContext = {
  baselineHashPromise: Promise.resolve('baseline-hash'),
  userClientMessageId: 'client-1',
  userLocalMessageId: 'user-local-1',
  spaceId: 'space-1',
}

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      checkpointPendingContextBySessionId: {},
      consumeCheckpointPendingContext,
      clearCheckpointPendingContext,
      createCheckpoint,
      setSessionMessages,
      replaceFromRollback,
      setCheckpointBaseline,
      messagesBySessionId: { 'session-1': [] as ChatMessage[] },
    }),
  },
}))

vi.mock('@/utils/logger', () => {
  const stub = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { logger: stub, createLogger: () => stub }
})

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

import { triggerCheckpointAfterLifecycleEnd } from '../lifecycleHandler'

function msg(overrides: Partial<ChatMessage> & { id: string; role: ChatMessage['role'] }): ChatMessage {
  return {
    content: '',
    created_at: '2026-07-22T00:00:00.000Z',
    ...overrides,
  } as ChatMessage
}

describe('triggerCheckpointAfterLifecycleEnd — 不写 store', () => {
  beforeEach(() => {
    createCheckpoint.mockClear()
    consumeCheckpointPendingContext.mockReset()
    consumeCheckpointPendingContext.mockReturnValue(pendingCtx)
    clearCheckpointPendingContext.mockClear()
    setSessionMessages.mockClear()
    replaceFromRollback.mockClear()
    setCheckpointBaseline.mockClear()
  })

  it('list 成功后只 createCheckpoint，不调用任何消息列表写 action', async () => {
    const client = {
      messages: {
        list: vi.fn().mockResolvedValue({
          messages: [
            msg({
              id: 'user-local-1',
              role: 'user',
              content: 'hi',
              metadata: { client_event_id: 'client-1' },
            }),
            msg({ id: 'assistant-1', role: 'assistant', content: 'ok', message_kind: 'llm' }),
          ],
        }),
      },
    }

    await triggerCheckpointAfterLifecycleEnd('session-1', client as never)

    expect(consumeCheckpointPendingContext).toHaveBeenCalledWith('session-1')
    expect(createCheckpoint).toHaveBeenCalledWith(
      'session-1',
      'assistant-1',
      2,
      expect.objectContaining({ spaceId: 'space-1', kind: 'agent_turn_done' }),
    )
    expect(setSessionMessages).not.toHaveBeenCalled()
    expect(replaceFromRollback).not.toHaveBeenCalled()
    expect(setCheckpointBaseline).not.toHaveBeenCalled()
  })

  it('无 pending context 时跳过 createCheckpoint', async () => {
    consumeCheckpointPendingContext.mockReturnValue(undefined)
    const list = vi.fn()
    const client = { messages: { list } }

    await triggerCheckpointAfterLifecycleEnd('session-1', client as never)

    expect(consumeCheckpointPendingContext).toHaveBeenCalledWith('session-1')
    expect(createCheckpoint).not.toHaveBeenCalled()
    expect(list).not.toHaveBeenCalled()
  })
})
