import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../blocks/types'
import { projectTaskEpisodeTimeline } from '@stores/chat/presentation/messageTimeline/taskEpisodeTimelineProjection'
import { isSharedTimelineMessageVisible } from '../../shared-view/sharedSessionMessages'

function message(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    created_at: '2026-08-07T00:00:00.000Z',
    message_kind: 'llm',
    content_blocks_json: [],
    ...partial,
  } as ChatMessage
}

describe('projectTaskEpisodeTimeline', () => {
  it('主时间线隔离子代理消息，并允许嵌入详情显式保留', () => {
    const input = [
      message({ id: 'main', created_at: '2026-08-07T00:00:00.000Z' }),
      message({
        id: 'child',
        created_at: '2026-08-07T00:00:01.000Z',
        subagent_run_id: 'run-child',
      }),
    ]

    expect(projectTaskEpisodeTimeline(input).messages.map((item) => item.id)).toEqual(['main'])
    expect(
      projectTaskEpisodeTimeline(input, {
        includeSubagentMessages: true,
      }).messages.map((item) => item.id),
    ).toEqual(['main', 'child'])
  })

  it('共享时间线投影对实时内部上下文应用场景可见性门', () => {
    const projection = projectTaskEpisodeTimeline([
      message({ id: 'visible', role: 'user', content: '真实发言' }),
      message({
        id: 'context',
        role: 'system',
        content: '<context type="agent-profile">内部规则</context>',
        message_kind: 'agent_profile_context',
      }),
    ], {
      isMessageVisible: isSharedTimelineMessageVisible,
    })

    expect(projection.messages.map((item) => item.id)).toEqual(['visible'])
  })

  it('默认隐藏普通 system，但保留白名单 system', () => {
    const projection = projectTaskEpisodeTimeline([
      message({ id: 'plain-system', role: 'system', content: 'plain system' }),
      message({
        id: 'status-system',
        role: 'system',
        content: '回退完成',
        metadata: { system_fact: 'checkpoint_rewind_summary' },
      }),
      message({ id: 'visible', role: 'user', content: '真实发言' }),
    ])

    expect(projection.messages.map((item) => item.id)).toEqual(['status-system', 'visible'])
  })

  it('默认隐藏未知专用 user kind，只保留真实用户消息', () => {
    const projection = projectTaskEpisodeTimeline([
      message({
        id: 'internal-user',
        role: 'user',
        message_kind: 'future_internal_context',
        content: 'internal',
      }),
      message({ id: 'visible', role: 'user', content: '真实发言' }),
    ])

    expect(projection.messages.map((item) => item.id)).toEqual(['visible'])
  })

  it('把连续助手段和轮内关系预先投影到行，不留给视口扫描', () => {
    const projection = projectTaskEpisodeTimeline([
      message({ id: 'user', role: 'user', message_kind: undefined }),
      message({ id: 'assistant-1', created_at: '2026-08-07T00:00:01.000Z' }),
      message({ id: 'assistant-2', created_at: '2026-08-07T00:00:02.000Z' }),
    ])

    expect(
      projection.rows.map((row) => ({
        id: row.message.id,
        renderId: row.renderMessage.id,
        renderIndex: row.renderMessageIndex,
        runPlaceholder: row.isRunPlaceholder,
        sameTurnAssistant: row.isSameTurnAssistant,
        lastInTurn: row.isLastInTurn,
        hideAgentBadge: row.hideAgentBadge,
      })),
    ).toEqual([
      {
        id: 'user',
        renderId: 'user',
        renderIndex: 0,
        runPlaceholder: false,
        sameTurnAssistant: false,
        lastInTurn: true,
        hideAgentBadge: false,
      },
      {
        id: 'assistant-1',
        renderId: 'assistant-2',
        renderIndex: 2,
        runPlaceholder: false,
        sameTurnAssistant: false,
        lastInTurn: true,
        hideAgentBadge: false,
      },
      {
        id: 'assistant-2',
        renderId: 'assistant-2',
        renderIndex: 2,
        runPlaceholder: true,
        sameTurnAssistant: true,
        lastInTurn: true,
        hideAgentBadge: true,
      },
    ])
  })

  it('在投影层重组连续 assistant run 的 blocks，行组件不再理解 run', () => {
    const firstBlock = {
      index: 0,
      block_id: 'b-1',
      block: { type: 'text', text: 'first' },
      finalized: true,
      partial: false,
    } as ContentBlockEntry
    const secondBlock = {
      index: 0,
      block_id: 'b-2',
      block: { type: 'text', text: 'second' },
      finalized: true,
      partial: false,
    } as ContentBlockEntry
    const projection = projectTaskEpisodeTimeline([
      message({ id: 'assistant-1', created_at: '2026-08-07T00:00:01.000Z' }),
      message({ id: 'assistant-2', created_at: '2026-08-07T00:00:02.000Z' }),
    ], {
      blocksByMessageId: {
        'assistant-1': [firstBlock],
        'assistant-2': [secondBlock],
      },
    })

    expect(projection.rows[0].renderMessage.id).toBe('assistant-2')
    expect(projection.rows[0].contentBlocksOverride).toEqual([firstBlock, secondBlock])
    expect(projection.rows[1].isRunPlaceholder).toBe(true)
  })
})
