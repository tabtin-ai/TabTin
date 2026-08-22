/**
 * scrollToToolCall.test.ts — PRD §4.15 / 决策 2=A 通用机制回归
 *
 * 覆盖通用 scrollToToolCall 模块：
 *   1. findMessageIdByToolCallId 反查 (sessionId, messageId) 命中
 *   2. 多 session、多 message 数据下找到正确的 message
 *   3. tool_use / server_tool_use / mcp_tool_use 三种类型都识别
 *   4. 找不到 → 返回 null + 调用方 onMissing 回调被调
 *   5. scrollToToolCall 跨 session 跳转：先 setCurrentSessionForSpace 再 scrollToMessage
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/logger', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
  }
})

import { useChatStore } from '@/stores/chat/useChatStore'
import { findMessageIdByToolCallId, scrollToToolCall } from '../scrollToToolCall'

interface SessionLike {
  id: string
  space_id: string
}

interface MessageLike {
  id: string
  content_blocks_json?: unknown[]
  blocks?: unknown[]
}

// ：定位反查读运行时 SSoT message.blocks（生产由入口反序列化灌入）。测试从
// content_blocks_json 派生 finalized entries 模拟 ingress。
function withDerivedBlocks(messages: MessageLike[]): MessageLike[] {
  return messages.map((m) => (
    m.blocks || !Array.isArray(m.content_blocks_json)
      ? m
      : {
          ...m,
          blocks: m.content_blocks_json.map((block, index) => ({
            index,
            block_id: `b-${m.id}-${index}`,
            block,
            finalized: true,
            partial: false,
          })),
        }
  ))
}

function setStoreFixture(opts: {
  messagesBySessionId: Record<string, MessageLike[]>
  currentSessionId?: string | null
  sessions?: SessionLike[]
}): { scrollSpy: ReturnType<typeof vi.fn>; setCurrentSpy: ReturnType<typeof vi.fn> } {
  const scrollSpy = vi.fn()
  const setCurrentSpy = vi.fn()
  const sessionMap = new Map(opts.sessions?.map(s => [s.id, s]) ?? [])
  const messagesBySessionId = Object.fromEntries(
    Object.entries(opts.messagesBySessionId).map(([sid, msgs]) => [sid, withDerivedBlocks(msgs)]),
  )

  useChatStore.setState({
    messagesBySessionId: messagesBySessionId as never,
    currentSessionId: opts.currentSessionId ?? null,
    getSessionById: ((sid: string) => sessionMap.get(sid)) as never,
    setCurrentSessionForSpace: setCurrentSpy as never,
    scrollToMessage: scrollSpy as never,
  } as never)

  return { scrollSpy, setCurrentSpy }
}

const ORIGINAL_STATE = useChatStore.getState()

afterEach(() => {
  // 还原 store，避免污染其他测试
  useChatStore.setState(ORIGINAL_STATE, true)
})

describe('findMessageIdByToolCallId', () => {
  beforeEach(() => {
    setStoreFixture({
      messagesBySessionId: {
        'sess-a': [
          { id: 'm-a1', content_blocks_json: [
            { type: 'tool_use', id: 'tc-1' },
            { type: 'text', text: 'foo' },
          ] },
          { id: 'm-a2', content_blocks_json: [
            { type: 'server_tool_use', id: 'tc-2' },
          ] },
        ],
        'sess-b': [
          { id: 'm-b1', content_blocks_json: [
            { type: 'mcp_tool_use', id: 'tc-3' },
          ] },
        ],
      },
    })
  })

  it('命中 tool_use 类型 block：返回正确的 (sessionId, messageId)', () => {
    expect(findMessageIdByToolCallId('tc-1')).toEqual({ sessionId: 'sess-a', messageId: 'm-a1' })
  })

  it('命中 server_tool_use 类型 block', () => {
    expect(findMessageIdByToolCallId('tc-2')).toEqual({ sessionId: 'sess-a', messageId: 'm-a2' })
  })

  it('命中 mcp_tool_use 类型 block', () => {
    expect(findMessageIdByToolCallId('tc-3')).toEqual({ sessionId: 'sess-b', messageId: 'm-b1' })
  })

  it('找不到 → 返回 null', () => {
    expect(findMessageIdByToolCallId('tc-nonexistent')).toBeNull()
  })

  it('messages 为空 → 返回 null', () => {
    setStoreFixture({ messagesBySessionId: {} })
    expect(findMessageIdByToolCallId('tc-1')).toBeNull()
  })
})

describe('scrollToToolCall', () => {
  it('找到 + 当前 session 同：只调 scrollToMessage，不切 session', () => {
    const { scrollSpy, setCurrentSpy } = setStoreFixture({
      messagesBySessionId: {
        'sess-a': [{ id: 'm-1', content_blocks_json: [{ type: 'tool_use', id: 'tc-x' }] }],
      },
      currentSessionId: 'sess-a',
      sessions: [{ id: 'sess-a', space_id: 'space-1' }],
    })

    scrollToToolCall('tc-x')

    expect(scrollSpy).toHaveBeenCalledWith('sess-a', 'm-1')
    expect(setCurrentSpy).not.toHaveBeenCalled()
  })

  it('找到 + 当前 session 不同：先 setCurrentSessionForSpace 再 scroll', () => {
    const { scrollSpy, setCurrentSpy } = setStoreFixture({
      messagesBySessionId: {
        'sess-target': [{ id: 'm-target', content_blocks_json: [{ type: 'tool_use', id: 'tc-y' }] }],
      },
      currentSessionId: 'sess-other',
      sessions: [
        { id: 'sess-target', space_id: 'space-2' },
        { id: 'sess-other', space_id: 'space-other' },
      ],
    })

    scrollToToolCall('tc-y')

    expect(setCurrentSpy).toHaveBeenCalledWith('space-2', 'sess-target')
    expect(scrollSpy).toHaveBeenCalledWith('sess-target', 'm-target')
  })

  it('找不到：onMissing 回调被调用、不触发 scrollToMessage', () => {
    const { scrollSpy } = setStoreFixture({
      messagesBySessionId: { 'sess-a': [{ id: 'm-1', content_blocks_json: [] }] },
    })
    const onMissing = vi.fn()

    scrollToToolCall('tc-not-here', { onMissing })

    expect(onMissing).toHaveBeenCalledWith('tc-not-here')
    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('空 toolCallId：直接 return，不调任何 store action', () => {
    const { scrollSpy, setCurrentSpy } = setStoreFixture({ messagesBySessionId: {} })

    scrollToToolCall('')

    expect(scrollSpy).not.toHaveBeenCalled()
    expect(setCurrentSpy).not.toHaveBeenCalled()
  })
})
