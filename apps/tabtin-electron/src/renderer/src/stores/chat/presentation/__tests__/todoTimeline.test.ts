import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { deriveTodoTimeline } from '../todoTimeline'

type ContentBlockEntry = {
  index: number
  block_id: string
  block: Record<string, unknown>
  finalized: boolean
  partial: boolean
}

type TodoSeed = { id: string; content: string; status: string }

function todoEntry(
  toolCallId: string,
  input: Record<string, unknown>,
  opts?: { finalized?: boolean; arrivalSeq?: number },
): ContentBlockEntry {
  const block: Record<string, unknown> = {
    type: 'tool_use',
    id: toolCallId,
    name: 'todo',
    input,
  }
  if (opts?.arrivalSeq !== undefined) block.arrival_seq = opts.arrivalSeq
  return {
    index: 0,
    block_id: toolCallId,
    block,
    finalized: opts?.finalized ?? true,
    partial: false,
  } as unknown as ContentBlockEntry
}

function todoErrorResult(toolCallId: string): ContentBlockEntry {
  return {
    index: 1,
    block_id: `result-${toolCallId}`,
    block: {
      type: 'tool_result',
      tool_use_id: toolCallId,
      content: '{"success":false,"error_kind":"todo_list_already_open"}',
      is_error: true,
    },
    finalized: true,
    partial: false,
  } as unknown as ContentBlockEntry
}

function asstMsg(
  id: string,
  blocks: ContentBlockEntry[],
  opts?: { subagent_run_id?: string },
): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    created_at: '2026-07-06T00:00:00.000Z',
    blocks,
    ...(opts?.subagent_run_id ? { subagent_run_id: opts.subagent_run_id } : {}),
  } as unknown as ChatMessage
}

describe('deriveTodoTimeline', () => {
  it('open 全 completed：自动 close，面板空 + 完成卡', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [
            { id: 't1', content: 'A', status: 'completed' },
            { id: 't2', content: 'B', status: 'completed' },
          ] satisfies TodoSeed[],
        }),
      ]),
    ])
    expect(tl.activeTodos).toEqual([])
    expect(tl.completedGroups).toHaveLength(1)
    expect(tl.completedGroups[0].anchorToolCallId).toBe('tw1')
    expect(tl.completedGroups[0].todos.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('进行中：面板显示 open 列表', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [
            { id: 't1', content: 'A', status: 'in_progress' },
            { id: 't2', content: 'B', status: 'pending' },
          ],
        }),
      ]),
    ])
    expect(tl.completedGroups).toHaveLength(0)
    expect(tl.activeTodos.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('paused：面板保留暂停项，不生成完成卡', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [
            { id: 'oauth', content: '等待用户完成 OAuth 授权', status: 'in_progress' },
          ],
        }),
      ]),
      asstMsg('m2', [
        todoEntry('tw2', {
          action: 'update',
          id: 'oauth',
          status: 'paused',
          content: '等待用户完成 OAuth 授权后回复已授权',
        }),
      ]),
    ])
    expect(tl.completedGroups).toHaveLength(0)
    expect(tl.activeTodos.map((t) => [t.id, t.status])).toEqual([['oauth', 'paused']])
  })

  it('update 至全完成：完成卡含全量', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [
            { id: 't1', content: 'A', status: 'pending' },
            { id: 't2', content: 'B', status: 'pending' },
          ],
        }),
      ]),
      asstMsg('m2', [
        todoEntry('tw2', { action: 'update', id: 't1', status: 'completed' }),
      ]),
      asstMsg('m3', [
        todoEntry('tw3', { action: 'update', id: 't2', status: 'completed' }),
      ]),
    ])
    expect(tl.activeTodos).toEqual([])
    expect(tl.completedGroups).toHaveLength(1)
    expect(tl.completedGroups[0].anchorToolCallId).toBe('tw3')
    expect(tl.completedGroups[0].todos.map((t) => t.id).sort()).toEqual(['t1', 't2'])
  })

  it('第一批 close + 第二批 open：流内卡 + 面板第二批', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [{ id: 'a1', content: 'A1', status: 'completed' }],
        }),
      ]),
      asstMsg('m2', [
        todoEntry('tw2', {
          action: 'open',
          items: [
            { id: 'b1', content: 'B1', status: 'in_progress' },
            { id: 'b2', content: 'B2', status: 'pending' },
          ],
        }),
      ]),
    ])
    expect(tl.completedGroups).toHaveLength(1)
    expect(tl.completedGroups[0].anchorToolCallId).toBe('tw1')
    expect(tl.activeTodos.map((t) => t.id)).toEqual(['b1', 'b2'])
  })

  it('completed 项不可再 update：非法动作跳过，列表不变', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [
            { id: 't1', content: 'A', status: 'completed' },
            { id: 't2', content: 'B', status: 'pending' },
          ],
        }),
      ]),
      asstMsg('m2', [
        todoEntry('tw2', { action: 'update', id: 't1', status: 'in_progress' }),
      ]),
    ])
    expect(tl.activeTodos.find((t) => t.id === 't1')?.status).toBe('completed')
    expect(tl.activeTodos.find((t) => t.id === 't2')?.status).toBe('pending')
  })

  it('显式 close：未完成变 cancelled，面板空', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [
            { id: 't1', content: 'A', status: 'in_progress' },
            { id: 't2', content: 'B', status: 'pending' },
          ],
        }),
      ]),
      asstMsg('m2', [todoEntry('tw2', { action: 'close' })]),
    ])
    expect(tl.activeTodos).toEqual([])
    expect(tl.completedGroups).toHaveLength(1)
    expect(tl.completedGroups[0].todos.every((t) => t.status === 'cancelled')).toBe(true)
  })

  it('子 Agent 的 todo 不参与主面板', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw1', {
          action: 'open',
          items: [
            { id: 't1', content: 'Main A', status: 'in_progress' },
            { id: 't2', content: 'Main B', status: 'pending' },
          ],
        }),
      ]),
      asstMsg(
        'm2',
        [
          todoEntry('tw2', {
            action: 'open',
            items: [{ id: 's1', content: 'Sub', status: 'in_progress' }],
          }),
        ],
        { subagent_run_id: 'sub-1' },
      ),
    ])
    expect(tl.activeTodos.map((t) => t.id)).toEqual(['t1', 't2'])
    expect(tl.activeTodos.map((t) => t.content)).toEqual(['Main A', 'Main B'])
  })

  it('按 arrival_seq 排序，不按消息数组顺序', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m2', [
        todoEntry(
          'tw2',
          { action: 'update', id: 't1', status: 'completed' },
          { arrivalSeq: 20 },
        ),
      ]),
      asstMsg('m1', [
        todoEntry(
          'tw1',
          {
            action: 'open',
            items: [{ id: 't1', content: 'A', status: 'in_progress' }],
          },
          { arrivalSeq: 10 },
        ),
      ]),
    ])
    expect(tl.activeTodos).toEqual([])
    expect(tl.completedGroups[0]?.anchorToolCallId).toBe('tw2')
  })

  it('失败 open 不入账：无幽灵面板（ live）', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw-fail', {
          action: 'open',
          items: [
            { id: '1', content: 'A', status: 'in_progress' },
            { id: '2', content: 'B', status: 'pending' },
            { id: '3', content: 'C', status: 'pending' },
          ],
        }),
        todoErrorResult('tw-fail'),
      ]),
    ])
    expect(tl.activeTodos).toEqual([])
    expect(tl.completedGroups).toEqual([])
  })

  it('旧 todo_write 不参与会话面板（预期空， 单工具契约）', () => {
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        {
          index: 0,
          block_id: 'legacy-1',
          block: {
            type: 'tool_use',
            id: 'legacy-1',
            name: 'todo_write',
            input: {
              todos: [
                { id: 't1', content: 'Legacy A', status: 'in_progress' },
                { id: 't2', content: 'Legacy B', status: 'pending' },
              ],
              merge: false,
            },
          },
          finalized: true,
          partial: false,
        } as unknown as ContentBlockEntry,
      ]),
    ])
    expect(tl.activeTodos).toEqual([])
    expect(tl.completedGroups).toEqual([])
  })

  it('mixed arrival_seq：任一缺失则全体按 encounter，不得完成卡+底栏双出口', () => {
    // 真实时序：先 open（无 seq）再逐项 update 收尾（有 seq）。旧比较器会把有
    // seq 的 update 排到 open 前 → update 全失败、面板停在 in_progress。
    const tl = deriveTodoTimeline([
      asstMsg('m1', [
        todoEntry('tw-open', {
          action: 'open',
          items: [
            { id: '1', content: 'A', status: 'in_progress' },
            { id: '2', content: 'B', status: 'pending' },
            { id: '3', content: 'C', status: 'pending' },
            { id: '4', content: 'D', status: 'pending' },
          ],
        }),
      ]),
      asstMsg('m2', [
        todoEntry('tw-u1', { action: 'update', id: '1', status: 'completed' }, { arrivalSeq: 201 }),
      ]),
      asstMsg('m3', [
        todoEntry('tw-u2', { action: 'update', id: '2', status: 'completed' }, { arrivalSeq: 202 }),
      ]),
      asstMsg('m4', [
        todoEntry('tw-u3', { action: 'update', id: '3', status: 'completed' }, { arrivalSeq: 203 }),
      ]),
      asstMsg('m5', [
        todoEntry('tw-u4', { action: 'update', id: '4', status: 'completed' }, { arrivalSeq: 204 }),
      ]),
    ])
    expect(tl.activeTodos).toEqual([])
    expect(tl.completedGroups).toHaveLength(1)
    expect(tl.completedGroups[0]?.anchorToolCallId).toBe('tw-u4')
    expect(tl.completedGroups[0]?.todos.every((t) => t.status === 'completed')).toBe(true)
  })
})
