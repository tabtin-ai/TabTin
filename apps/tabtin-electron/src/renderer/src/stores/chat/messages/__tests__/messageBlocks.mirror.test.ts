/**
 * messageBlocks commit ——  /  引擎→messages 层集成单测。
 *
 * runtime 引擎 rAF flush 后经 Zustand setState 把块写入 `ChatMessage.blocks`。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

const { mockState } = vi.hoisted(() => {
  const mockState: { messagesBySessionId: Record<string, ChatMessage[]> } = {
    messagesBySessionId: {},
  }
  return { mockState }
})

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => mockState,
    setState: (
      partial:
        | Partial<typeof mockState>
        | ((state: typeof mockState) => Partial<typeof mockState>),
    ) => {
      const patch = typeof partial === 'function' ? partial(mockState) : partial
      if (!patch || Object.keys(patch).length === 0) return
      Object.assign(mockState, patch)
    },
  },
}))

import { getCommittedBlocks, __resetMessageBlocks } from '../messageBlocks'
import { useChatRuntimeStore, flushRuntimeBatch } from '@stores/useChatRuntimeStore'
import type { ContentBlock } from '@tabtin/agent-wire'

const SID = 'sess-commit'
const TEXT_BLOCK: ContentBlock = { type: 'text', text: '' }

function shell(id: string): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    created_at: '2025-01-01T00:00:00Z',
    content_blocks_json: [],
  } as ChatMessage
}

beforeEach(() => {
  flushRuntimeBatch()
  useChatRuntimeStore.setState({
    messageMetaBySessionId: {},
    contentBlocksLastSeqBySessionId: {},
  })
  mockState.messagesBySessionId = {}
  __resetMessageBlocks()
})

describe('messageBlocks commit · runtime 引擎 → messages 层', () => {
  it('流式 text delta flush 后 commit 进 message.blocks', () => {
    const mid = 'msg-commit-1'
    mockState.messagesBySessionId[SID] = [shell(mid)]

    const store = useChatRuntimeStore.getState()
    store.messageStart(SID, mid, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SID, mid, 0, 'blk_0', TEXT_BLOCK, 2)
    store.contentBlockDelta(SID, mid, 0, { type: 'text_delta', text: 'Hi' }, 3)
    flushRuntimeBatch()

    const committed = getCommittedBlocks(SID, mid)
    expect(committed).toHaveLength(1)
    expect((committed![0].block as { text: string }).text).toBe('Hi')
    expect(committed![0].finalized).toBe(false)
    expect(mockState.messagesBySessionId[SID][0].blocks).toBe(committed)
  })

  it('message_stop 后 blocks finalize', () => {
    const mid = 'msg-commit-2'
    mockState.messagesBySessionId[SID] = [shell(mid)]

    const store = useChatRuntimeStore.getState()
    store.messageStart(SID, mid, { role: 'assistant', model_id: 'm', model_name: 'M', started_at: '2025-01-01T00:00:00Z' }, 1)
    store.contentBlockStart(SID, mid, 0, 'blk_0', TEXT_BLOCK, 2)
    store.contentBlockDelta(SID, mid, 0, { type: 'text_delta', text: 'Done' }, 3)
    store.contentBlockStop(SID, mid, 0, 4)
    store.messageStop(SID, mid, 5)
    flushRuntimeBatch()

    const committed = getCommittedBlocks(SID, mid)
    expect(committed).toHaveLength(1)
    expect(committed![0].finalized).toBe(true)
  })
})
