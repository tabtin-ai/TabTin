import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../blocks/types'
import {
  deriveMessageBubbleModel,
  resolveMessageContentBlocks,
} from '@stores/chat/presentation/messageBubble/deriveMessageBubbleModel'

const t = (key: string, opts?: Record<string, unknown>) => {
  if (opts?.defaultValue && typeof opts.defaultValue === 'string') return opts.defaultValue
  return key
}

function makeAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'asst-1',
    role: 'assistant',
    content: 'hello',
    created_at: '2026-07-12T00:00:00Z',
    message_kind: 'llm',
    ...overrides,
  } as ChatMessage
}

describe('resolveMessageContentBlocks', () => {
  const runtimeBlocks = [{ index: 0, block_id: 'r1' }] as ContentBlockEntry[]
  const messageBlocks = [{ index: 0, block_id: 'm1' }] as ContentBlockEntry[]
  const overrideBlocks = [{ index: 0, block_id: 'o1' }] as ContentBlockEntry[]

  it('user 消息始终返回空数组', () => {
    expect(resolveMessageContentBlocks({
      isUser: true,
      runtimeBlocks,
      isPartialSegment: false,
      contentBlocksOverride: overrideBlocks,
    })).toEqual([])
  })

  it('优先 contentBlocksOverride', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      contentBlocksOverride: overrideBlocks,
      runtimeBlocks,
      isPartialSegment: false,
    })).toBe(overrideBlocks)
  })

  it('partial 段只认 override，不回落 runtimeBlocks', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: true,
      contentBlocksOverride: messageBlocks,
      runtimeBlocks,
    })).toBe(messageBlocks)

    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: true,
      contentBlocksOverride: [],
      runtimeBlocks,
    })).toEqual([])
  })

  it('非 partial：runtimeBlocks 优先；空时回落 messageBlocks', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: false,
      runtimeBlocks,
    })).toBe(runtimeBlocks)

    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: false,
      runtimeBlocks: [],
    })).toEqual([])

    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: false,
      runtimeBlocks: [],
      messageBlocks,
    })).toBe(messageBlocks)

    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: false,
      runtimeBlocks,
      messageBlocks,
    })).toBe(runtimeBlocks)
  })
})

describe('deriveMessageBubbleModel footer matrix', () => {
  const baseInput = {
    message: makeAssistant(),
    sessionId: 'sess-1',
    currentUserId: 'user-1',
    isActiveSession: true,
    isRestoring: false,
    isStreaming: false,
    runStateSuspended: false,
    sessionMessages: [] as ChatMessage[],
    runtimeBlocks: [] as ContentBlockEntry[],
    t,
    locale: 'zh-CN',
  }

  it('llm 助手消息显示标准 footer', () => {
    const model = deriveMessageBubbleModel(baseInput)
    expect(model.showStandardFooter).toBe(true)
    expect(model.showErrorEnvelopeFooter).toBe(false)
    expect(model.isMiniMessage).toBe(false)
  })

  it('tool_artifact 跳过标准 footer', () => {
    const model = deriveMessageBubbleModel({
      ...baseInput,
      message: makeAssistant({ message_kind: 'tool_artifact', content: 'tool out' }),
    })
    expect(model.isMiniMessage).toBe(true)
    expect(model.showStandardFooter).toBe(false)
  })

  it('error_envelope 走简化 footer', () => {
    const model = deriveMessageBubbleModel({
      ...baseInput,
      message: makeAssistant({ message_kind: 'error_envelope', content: '[unknown] boom' }),
    })
    expect(model.isErrorEnvelope).toBe(true)
    expect(model.showStandardFooter).toBe(false)
    expect(model.showErrorEnvelopeFooter).toBe(true)
  })

  it('streaming 末条 assistant 隐藏标准 footer', () => {
    const model = deriveMessageBubbleModel({
      ...baseInput,
      isStreaming: true,
      isLastAssistantMsg: true,
    })
    expect(model.isStreamingTailMessage).toBe(true)
    expect(model.showStandardFooter).toBe(false)
  })
})
