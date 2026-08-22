import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../blocks/types'
import { computeAssistantRuns, assembleRunContentBlocks } from '@stores/chat/presentation/messageTimeline/messageRuns'
import { materializeMessagesForTimeline } from '@/stores/chat/domain/messageTimelineOrder'

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  const built = {
    role: 'assistant',
    content: '',
    created_at: '2026-07-04T00:00:00.000Z',
    message_kind: 'llm',
    content_blocks_json: [],
    ...partial,
  } as ChatMessage
  if (built.blocks === undefined && Array.isArray(built.content_blocks_json)) {
    built.blocks = built.content_blocks_json.map((block, index) => ({
      index,
      block_id: `b-${built.id}-${index}`,
      block: block as ContentBlockEntry['block'],
      finalized: true,
      partial: false,
    }))
  }
  return built
}

describe('computeAssistantRuns', () => {
  it('单条 llm 助手消息不登记（size==1 照旧单独渲染）', () => {
    const runs = computeAssistantRuns([
      msg({ id: 'u1', role: 'user', message_kind: undefined }),
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'u2', role: 'user', message_kind: undefined }),
    ])
    expect(runs.size).toBe(0)
  })

  it('连续同 run 的多条 llm 段合并为一个 run（首/末下标正确）', () => {
    const runs = computeAssistantRuns([
      msg({ id: 'u1', role: 'user', message_kind: undefined }),
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
      msg({ id: 'a3', agent_run_id: 'r1' }),
    ])
    const run = runs.get(1)
    expect(run).toBeDefined()
    expect(run!.firstIndex).toBe(1)
    expect(run!.lastIndex).toBe(3)
    expect(run!.memberIndices).toEqual([1, 2, 3])
    expect(runs.get(2)).toBe(run)
    expect(runs.get(3)).toBe(run)
  })

  it('#7533 连续 llm 不同 agent_run_id 仍合并（不比较 run_id）', () => {
    const runs = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
      msg({ id: 'a3', agent_run_id: 'r2' }),
      msg({ id: 'a4', agent_run_id: 'r2' }),
    ])
    expect(runs.get(0)?.memberIndices).toEqual([0, 1, 2, 3])
  })

  it('缺失 agent_run_id 时相邻 llm 段合并', () => {
    const runs = computeAssistantRuns([
      msg({ id: 'a1' }),
      msg({ id: 'a2' }),
    ])
    expect(runs.get(0)?.memberIndices).toEqual([0, 1])
  })

  it('同 run 的 tool_artifact 不打断前后 llm 段，并并入同一个 run', () => {
    const runs = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'art', agent_run_id: 'r1', message_kind: 'tool_artifact' }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    const run = runs.get(0)
    expect(run).toBeDefined()
    expect(run!.firstIndex).toBe(0)
    expect(run!.lastIndex).toBe(2)
    expect(run!.memberIndices).toEqual([0, 1, 2])
  })

  it('块级物化拆出的 llm → tool_artifact → llm 三段仍合并为一个 run', () => {
    const llm = msg({
      id: 'llm',
      agent_run_id: 'r1',
      content_blocks_json: [
        { type: 'text', text: 'before tool', arrival_seq: 10 },
        { type: 'text', text: 'after artifact', arrival_seq: 40 },
      ],
    })
    const artifact = msg({
      id: 'artifact',
      agent_run_id: 'r1',
      message_kind: 'tool_artifact',
      content_blocks_json: [
        { type: 'tabtin_rich_content', kind: 'widget', summary: 'artifact', arrival_seq: 30 },
      ],
    })

    const timeline = materializeMessagesForTimeline([artifact, llm])
    expect(timeline.map((m) => m.id)).toEqual(['llm', 'artifact', 'llm'])

    const runs = computeAssistantRuns(timeline)
    expect(runs.get(0)?.memberIndices).toEqual([0, 1, 2])
  })

  it('trailing tool_artifact 保持独立，不强行合入单条 llm run', () => {
    const runs = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'art', agent_run_id: 'r1', message_kind: 'tool_artifact' }),
    ])
    expect(runs.size).toBe(0)
  })

  it('多个连续 tool_artifact 夹在同 run llm 中时全部并入 run', () => {
    const runs = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'art-1', agent_run_id: 'r1', message_kind: 'tool_artifact' }),
      msg({ id: 'art-2', agent_run_id: 'r1', message_kind: 'tool_artifact' }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    expect(runs.get(0)?.memberIndices).toEqual([0, 1, 2, 3])
  })

  it('UI 隐藏脚手架不打断 run 合并', () => {
    const withProfile = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({
        id: 'profile',
        role: 'user',
        message_kind: 'agent_profile_context',
        content: '<context type="agent-profile">x</context>',
      }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    expect(withProfile.get(0)?.memberIndices).toEqual([0, 2])

    const withHitl = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'hitl', role: 'assistant', message_kind: 'hitl_interaction' }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    expect(withHitl.get(0)?.memberIndices).toEqual([0, 2])

    const withSkillInjection = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({
        id: 'skill',
        role: 'user',
        message_kind: undefined,
        metadata: { source: 'skill_invoke' } as ChatMessage['metadata'],
      }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    expect(withSkillInjection.get(0)?.memberIndices).toEqual([0, 2])

    const withDedicatedUserKind = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({
        id: 'limits',
        role: 'user',
        message_kind: 'compaction_summary',
        content: '限制：保留最近上下文',
      }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    expect(withDedicatedUserKind.get(0)?.memberIndices).toEqual([0, 2])
  })

  it('可见的已回答单选 HITL 打断 run，其余 HITL 仍透明合并', () => {
    const hitl = {
      kind: 'ask_choice',
      payload: {
        questions: [{
          id: 'q1',
          prompt: '选一个主题',
          options: [{ id: 'a', label: '人工智能' }],
        }],
      },
      result: { answers: [{ question_id: 'q1', selected_options: ['a'] }] },
    }
    const answered = computeAssistantRuns([
      msg({ id: 'a1' }),
      msg({
        id: 'hitl-answered',
        message_kind: 'hitl_interaction',
        metadata: { hitl: { ...hitl, status: 'resolved' } } as ChatMessage['metadata'],
      }),
      msg({ id: 'a2' }),
    ])
    expect(answered.size).toBe(0)
    for (const [id, fact] of [
      ['hitl-pending', { ...hitl, status: 'pending' }],
      ['hitl-skipped', { ...hitl, status: 'resolved', result: { outcome: 'skipped' } }],
      ['hitl-form', { ...hitl, kind: 'ask_form', status: 'resolved' }],
    ] as const) {
      const transparent = computeAssistantRuns([
        msg({ id: 'a1' }),
        msg({
          id,
          message_kind: 'hitl_interaction',
          metadata: { hitl: fact } as ChatMessage['metadata'],
        }),
        msg({ id: 'a2' }),
      ])
      expect(transparent.get(0)?.memberIndices).toEqual([0, 2])
    }
  })

  it('#7533 有可见缺口不跨拼：push / error / 真实 user 均打断 run 合并', () => {
    const withPush = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({
        id: 'push',
        role: 'user',
        message_kind: undefined,
        content: 'A background command completed',
        metadata: { triggered_by: 'push-notification' } as ChatMessage['metadata'],
      }),
      msg({ id: 'a2', agent_run_id: 'r2' }),
    ])
    expect(withPush.size).toBe(0)

    const withError = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'err', agent_run_id: 'r1', message_kind: 'error_envelope' }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    expect(withError.size).toBe(0)

    const withUser = computeAssistantRuns([
      msg({ id: 'a1', agent_run_id: 'r1' }),
      msg({ id: 'u1', role: 'user', message_kind: undefined }),
      msg({ id: 'a2', agent_run_id: 'r1' }),
    ])
    expect(withUser.size).toBe(0)
  })
})

describe('assembleRunContentBlocks', () => {
  function entry(id: string, index: number): ContentBlockEntry {
    return {
      index,
      block_id: id,
      block: { type: 'tool_use', id, name: 'read_file', input: {} },
      finalized: true,
      partial: false,
    } as ContentBlockEntry
  }

  /** store 有块时不读 props.blocks。 */
  it('按成员顺序拼接 blocksByMessageId（ /  store 优先）', () => {
    const members = [msg({ id: 'a1' }), msg({ id: 'a2' })]
    const out = assembleRunContentBlocks(members, {
      a1: [entry('t1', 0), entry('t2', 1)],
      a2: [entry('t3', 0)],
    })
    expect(out.map((e) => e.block_id)).toEqual(['t1', 't2', 't3'])
  })

  it('拼接 run 内 tool_artifact 块，保持工具产物在同一 BlockTimeline 内联', () => {
    const members = [
      msg({ id: 'a1' }),
      msg({ id: 'artifact', message_kind: 'tool_artifact' }),
      msg({ id: 'a2' }),
    ]
    const out = assembleRunContentBlocks(members, {
      a1: [entry('text-before', 0)],
      artifact: [{
        index: 0,
        block_id: 'rich-1',
        block: { type: 'tabtin_rich_content', kind: 'file', summary: 'out.txt' },
        finalized: true,
        partial: false,
      } as ContentBlockEntry],
      a2: [entry('text-after', 0)],
    })
    expect(out.map((e) => e.block_id)).toEqual(['text-before', 'rich-1', 'text-after'])
  })

  it('成员在 record 中无块且无 props.blocks 时跳过', () => {
    const members = [msg({ id: 'a1' }), msg({ id: 'a2' })]
    const out = assembleRunContentBlocks(members, {
      a1: [],
      a2: [entry('t3', 0)],
    })
    expect(out.map((e) => e.block_id)).toEqual(['t3'])
  })

  it('props.blocks 过期时仍拼出 record 全文（store 优先，）', () => {
    const members = [
      msg({ id: 'a1', blocks: [entry('stale', 0)] }),
      msg({ id: 'a2' }),
    ]
    const out = assembleRunContentBlocks(members, {
      a1: [entry('fresh-1', 0)],
      a2: [entry('fresh-2', 0)],
    })
    expect(out.map((e) => e.block_id)).toEqual(['fresh-1', 'fresh-2'])
  })

  it('#8846 store 空时按成员回落 message.blocks（子代理详情虚 session）', () => {
    const members = [
      msg({ id: 'a1', blocks: [entry('arch-1', 0)] }),
      msg({ id: 'a2', blocks: [entry('arch-2', 0), entry('arch-3', 1)] }),
    ]
    const out = assembleRunContentBlocks(members, {})
    expect(out.map((e) => e.block_id)).toEqual(['arch-1', 'arch-2', 'arch-3'])
  })

  it('#8846 混合：有 store 的成员用 store，无 store 的成员用 props.blocks', () => {
    const members = [
      msg({ id: 'a1', blocks: [entry('stale', 0)] }),
      msg({ id: 'a2', blocks: [entry('arch-2', 0)] }),
    ]
    const out = assembleRunContentBlocks(members, {
      a1: [entry('fresh-1', 0)],
    })
    expect(out.map((e) => e.block_id)).toEqual(['fresh-1', 'arch-2'])
  })
})
