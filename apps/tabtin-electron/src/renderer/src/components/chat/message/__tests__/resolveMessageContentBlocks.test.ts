import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../blocks/types'
import { ensureMessageRuntimeBlocks } from '@/stores/chat/messages/ensureMessageRuntimeBlocks'
import { deriveAssistantBubbleModel } from '@stores/chat/presentation/messageBubble/deriveAssistantBubbleModel'
import {
  resolveMessageContentBlocks,
  shouldHideEntireMessageBubble,
} from '@stores/chat/presentation/messageBubble/resolveMessageContentBlocks'
import {
  deriveMessageBubbleVisibility,
  isInternalNonRenderableMessage,
} from '@stores/chat/presentation/messageBubble/messageBubblePresentationDerivers'

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

  it('优先非空 contentBlocksOverride', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      contentBlocksOverride: overrideBlocks,
      runtimeBlocks,
      isPartialSegment: false,
    })).toBe(overrideBlocks)
  })

  it('空数组 override 不短路，回落到 runtimeBlocks', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      contentBlocksOverride: [],
      runtimeBlocks,
      isPartialSegment: false,
    })).toBe(runtimeBlocks)
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

  it('非 partial：非空 override → runtimeBlocks → messageBlocks', () => {
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
  })

  it('#8846 store 非空时不读 props.messageBlocks', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: false,
      runtimeBlocks,
      messageBlocks,
    })).toBe(runtimeBlocks)
  })

  it('#8846 store 空时回落 messageBlocks（归档冷读）', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: false,
      runtimeBlocks: [],
      messageBlocks,
    })).toBe(messageBlocks)
  })

  it('partial 段即使有 messageBlocks 也不回落', () => {
    expect(resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: true,
      contentBlocksOverride: [],
      runtimeBlocks: [],
      messageBlocks,
    })).toEqual([])
  })
})

describe('isInternalNonRenderableMessage', () => {
  it('#9460：system 持久化的 Skill 仍隐藏，Push 仍按通知展示', () => {
    const skill = deriveMessageBubbleVisibility({
      message: makeAssistant({ role: 'system', metadata: { source: 'skill_invoke' } }),
      metadata: { source: 'skill_invoke' },
      messageKind: 'llm',
      hideAnchoredPushNotification: false,
    })
    const push = deriveMessageBubbleVisibility({
      message: makeAssistant({ role: 'system', metadata: { triggered_by: 'push-notification' } }),
      metadata: { triggered_by: 'push-notification' },
      messageKind: 'llm',
      hideAnchoredPushNotification: false,
    })

    expect(skill.shouldHideEntireBubble).toBe(true)
    expect(push.isPushNotification).toBe(true)
    expect(push.shouldHideEntireBubble).toBe(false)
  })

  it('skill / push anchor / environment / hitl 隐藏整条消息', () => {
    expect(shouldHideEntireMessageBubble({
      isSkillInjection: true,
      hideAnchoredPushNotification: false,
      isEnvironmentContext: false,
      isHitlInteraction: false,
    })).toBe(true)
    expect(shouldHideEntireMessageBubble({
      isSkillInjection: false,
      hideAnchoredPushNotification: true,
      isEnvironmentContext: false,
      isHitlInteraction: false,
    })).toBe(true)
    expect(shouldHideEntireMessageBubble({
      isSkillInjection: false,
      hideAnchoredPushNotification: false,
      isEnvironmentContext: false,
      isHitlInteraction: false,
      isContinuationTrigger: true,
    })).toBe(true)
  })

  it('skill / environment / hitl 不参与普通消息渲染', () => {
    expect(isInternalNonRenderableMessage({
      message: { id: 'skill-1', role: 'user', content: '', metadata: { source: 'skill_invoke' } } as ChatMessage,
      metadata: { source: 'skill_invoke' },
      messageKind: 'llm',
    })).toBe(true)
    expect(isInternalNonRenderableMessage({
      message: { id: 'ctx-1', role: 'system', content: '<context type="environment">x</context>' } as ChatMessage,
      metadata: null,
      messageKind: 'llm',
    })).toBe(true)
    expect(isInternalNonRenderableMessage({
      message: { id: 'hitl-1', role: 'user', content: '' } as ChatMessage,
      metadata: null,
      messageKind: 'hitl_interaction',
    })).toBe(true)
  })

  it('未知专用 user kind 默认隐藏，不靠内部 kind 黑名单兜底', () => {
    expect(isInternalNonRenderableMessage({
      message: {
        id: 'future-internal-1',
        role: 'user',
        content: 'internal',
        message_kind: 'future_internal_context',
      } as ChatMessage,
      metadata: null,
      messageKind: 'future_internal_context',
    })).toBe(true)
  })

  it('已回答单选 HITL 可见，其余 HITL 仍隐藏', () => {
    const metadata = {
      hitl: {
        kind: 'ask_choice',
        status: 'resolved',
        payload: {
          questions: [{
            id: 'q1',
            prompt: '选一个主题',
            options: [{ id: 'a', label: '人工智能' }],
          }],
        },
        result: {
          answers: [{ question_id: 'q1', selected_options: ['a'] }],
        },
      },
    }

    expect(isInternalNonRenderableMessage({
      message: { id: 'hitl-answered', role: 'assistant', content: '', metadata } as ChatMessage,
      metadata,
      messageKind: 'hitl_interaction',
    })).toBe(false)
    expect(isInternalNonRenderableMessage({
      message: { id: 'hitl-pending', role: 'assistant', content: '' } as ChatMessage,
      metadata: { hitl: { ...metadata.hitl, status: 'pending' } },
      messageKind: 'hitl_interaction',
    })).toBe(true)
  })

  it('隐藏没有实质输出的已中断 assistant 空壳', () => {
    const hidden = isInternalNonRenderableMessage({
      message: makeAssistant({
        content: '',
        stop_reason: 'aborted',
        content_blocks_json: [],
      }),
      metadata: null,
      messageKind: 'llm',
    })

    expect(hidden).toBe(true)
  })

  it('已中断 assistant 有实质输出时仍保留', () => {
    const hidden = isInternalNonRenderableMessage({
      message: makeAssistant({
        content: '已经输出的部分内容',
        stop_reason: 'aborted',
      }),
      metadata: null,
      messageKind: 'llm',
    })

    expect(hidden).toBe(false)
  })
})

describe('deriveAssistantBubbleModel · blocks 为正文 SSoT', () => {
  it('有 runtimeBlocks 时走 BlockTimeline；displayContent 仍可是 summary', () => {
    const summary = '甲'.repeat(200)
    const full = '甲'.repeat(280)
    const blocks = [{
      index: 0,
      block_id: 'b1',
      block: { type: 'text', text: full },
      finalized: true,
      partial: false,
    }] as ContentBlockEntry[]
    const model = deriveAssistantBubbleModel({
      message: makeAssistant({
        content: summary,
        content_blocks_json: [{ type: 'text', text: full }],
      }),
      messageKind: 'llm',
      metadata: null,
      runtimeBlocks: blocks,
      t,
      hasErrorIndicators: false,
    })
    expect(model.hasContentBlocks).toBe(true)
    expect((model.contentBlocks[0]?.block as { text?: string }).text).toBe(full)
    expect(model.displayContent).toBe(summary)
    expect(model.assistantCopyContent).toBe(full)
    expect(model.assistantToolbarContent).toBe(summary)
  })

  it('#8846 无 runtimeBlocks 时回落 message.blocks；仍不读 content_blocks_json', () => {
    const summary = '甲'.repeat(200)
    const full = '甲'.repeat(280)
    const fromJson = '只在 json 里'
    const model = deriveAssistantBubbleModel({
      message: makeAssistant({
        content: summary,
        content_blocks_json: [{ type: 'text', text: fromJson }],
        blocks: [{
          index: 0,
          block_id: 'archive',
          block: { type: 'text', text: full },
          finalized: true,
          partial: false,
        }] as ContentBlockEntry[],
      }),
      messageKind: 'llm',
      metadata: null,
      runtimeBlocks: [],
      t,
      hasErrorIndicators: false,
    })
    expect(model.hasContentBlocks).toBe(true)
    expect((model.contentBlocks[0]?.block as { text?: string }).text).toBe(full)
    expect(model.displayContent).toBe(summary)
  })

  it('无 runtimeBlocks 且无 message.blocks 时不从 content_blocks_json 拼正文', () => {
    const summary = '甲'.repeat(200)
    const full = '甲'.repeat(280)
    const model = deriveAssistantBubbleModel({
      message: makeAssistant({
        content: summary,
        content_blocks_json: [{ type: 'text', text: full }],
      }),
      messageKind: 'llm',
      metadata: null,
      runtimeBlocks: [],
      t,
      hasErrorIndicators: false,
    })
    expect(model.hasContentBlocks).toBe(false)
    expect(model.displayContent).toBe(summary)
  })

  it('#7794 ensure hydrate 后 model 正文为全文，content 仍可为 200 字摘要', () => {
    const full = `${'全文段落。'.repeat(40)}结尾标记`
    const summary = Array.from(full).slice(0, 200).join('')
    const cold = makeAssistant({
      content: summary,
      content_blocks_json: [{ type: 'text', text: full }],
    })
    expect(cold.blocks).toBeUndefined()
    const hydrated = ensureMessageRuntimeBlocks(cold)
    expect(hydrated).not.toBe(cold)
    expect(Array.from(hydrated.content ?? '').length).toBe(200)
    const model = deriveAssistantBubbleModel({
      message: hydrated,
      messageKind: 'llm',
      metadata: null,
      runtimeBlocks: hydrated.blocks ?? [],
      t,
      hasErrorIndicators: false,
    })
    expect(model.hasContentBlocks).toBe(true)
    expect((model.contentBlocks[0]?.block as { text?: string }).text).toBe(full)
    expect(Array.from((model.contentBlocks[0]?.block as { text: string }).text).length)
      .toBeGreaterThan(200)
    expect(model.displayContent).toBe(summary)
  })
})
