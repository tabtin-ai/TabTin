/**
 * 回归：SharedSessionPane 实时查看须能显示 agent 正文。
 *
 *  后助手气泡只认 store `messagesBySessionId[].blocks`。
 * Pane 须经 hydrate 入口写入 store，不能只把 blocks 挂在本地 props 上。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { deriveAssistantBubbleModel } from '../../message'
import { resolveMessageContentBlocks } from '../../message'
import {
  hydrateSessionBlocksFromJson,
  __resetMessageBlocks,
} from '@/stores/chat/messages/messageBlocks'
import {
  loadLatestSharedTimelinePage,
  mergeSharedTimelineMessages,
} from '../sharedSessionMessages'

const t = (key: string, opts?: Record<string, unknown>) => {
  if (opts?.defaultValue && typeof opts.defaultValue === 'string') return opts.defaultValue
  return key
}

/** 对齐 SharedSessionPane.refreshTimeline：merge 后 hydrate 写入 store 切片。 */
function applySharedTimelineLikePane(
  restMessages: ChatMessage[],
  liveMessages: ChatMessage[] = [],
): ChatMessage[] {
  const merged = mergeSharedTimelineMessages(restMessages, liveMessages)
  return hydrateSessionBlocksFromJson(merged).messages
}

describe('SharedSessionPane agent blocks regression ', () => {
  beforeEach(() => {
    __resetMessageBlocks()
  })

  it('REST 历史经 hydrate 写入后，气泡读路径能拿到 agent 全文', () => {
    const fullText = '共享视图应能看到完整 agent 回复'
    const restMessage = {
      id: 'asst-shared-1',
      role: 'assistant',
      content: '摘要截断…',
      created_at: '2026-07-27T00:00:00Z',
      message_kind: 'llm',
      content_blocks_json: [{ type: 'text', text: fullText }],
    } as ChatMessage

    const stored = applySharedTimelineLikePane([restMessage])
    const hydrated = stored.find((m) => m.id === restMessage.id)
    expect(hydrated?.blocks?.length).toBeGreaterThan(0)

    const runtimeBlocks = [...(hydrated?.blocks ?? [])]
    const resolved = resolveMessageContentBlocks({
      isUser: false,
      isPartialSegment: false,
      runtimeBlocks,
    })
    const model = deriveAssistantBubbleModel({
      message: hydrated!,
      messageKind: 'llm',
      metadata: null,
      runtimeBlocks,
      t,
      hasErrorIndicators: false,
    })

    expect(resolved.length).toBeGreaterThan(0)
    expect(model.hasContentBlocks).toBe(true)
    expect((model.contentBlocks[0]?.block as { text?: string }).text).toBe(fullText)
  })

  it('刷新时保留仅存在于 live 的壳，同 id 以 REST hydrate 为准', () => {
    const liveOnly = {
      id: 'asst-live-only',
      role: 'assistant',
      content: '',
      created_at: '2026-07-27T00:00:02Z',
      message_kind: 'llm',
      blocks: [{
        index: 0,
        block_id: 'live-1',
        block: { type: 'text', text: '流式中' },
        finalized: false,
      }],
    } as ChatMessage
    const restDone = {
      id: 'asst-done',
      role: 'assistant',
      content: '摘要',
      created_at: '2026-07-27T00:00:01Z',
      message_kind: 'llm',
      content_blocks_json: [{ type: 'text', text: '已落库全文' }],
    } as ChatMessage

    const stored = applySharedTimelineLikePane([restDone], [liveOnly])
    expect(stored.map((m) => m.id)).toEqual(['asst-done', 'asst-live-only'])
    const done = stored.find((m) => m.id === 'asst-done')
    expect((done?.blocks?.[0]?.block as { text?: string })?.text).toBe('已落库全文')
    expect(stored.find((m) => m.id === 'asst-live-only')?.blocks?.[0]).toEqual(liveOnly.blocks![0])
  })

  it('长任务首次打开加载最新页，不能把第 72 条产物截在前 50 条之外', async () => {
    const messages = Array.from({ length: 97 }, (_, index) => ({
      id: `message-${String(index + 1).padStart(3, '0')}`,
      role: 'assistant',
      content: index === 71 ? '佛手柑拼多多调研数据' : `message ${index + 1}`,
      created_at: new Date(Date.UTC(2026, 7, 3, 0, 0, index)).toISOString(),
      message_kind: index === 71 ? 'tool_artifact' : 'llm',
      content_blocks_json: index === 71
        ? [{
            type: 'tabtin_rich_content',
            kind: 'resource_ref',
            payload: {
              resource_type: 'table',
              resource_id: '595cc395-1cae-4824-aba2-89a8341c1423',
            },
          }]
        : [{ type: 'text', text: `message ${index + 1}` }],
    })) as ChatMessage[]
    const list = vi.fn(async (_sessionId: string, params?: { limit?: number; offset?: number }) => {
      const limit = params?.limit ?? 50
      const offset = params?.offset ?? 0
      const pageMessages = messages.slice(offset, offset + limit)
      return {
        messages: pageMessages,
        total: messages.length,
        has_more: offset + pageMessages.length < messages.length,
        oldest_id: pageMessages[0]?.id ?? null,
        newest_id: pageMessages.at(-1)?.id ?? null,
      }
    })

    const page = await loadLatestSharedTimelinePage(list, 'shared-session', 50)

    expect(list).toHaveBeenNthCalledWith(1, 'shared-session', { limit: 50 })
    expect(list).toHaveBeenNthCalledWith(2, 'shared-session', { limit: 50, offset: 47 })
    expect(page.messages).toHaveLength(50)
    expect(page.messages.some((message) => message.message_kind === 'tool_artifact')).toBe(true)
    expect(page.hasEarlier).toBe(true)
  })
})
