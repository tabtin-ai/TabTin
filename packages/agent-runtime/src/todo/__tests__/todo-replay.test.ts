import { describe, expect, it } from 'vitest'
import type { Message } from '../../engine/contracts/conversation.js'
import type { ToolContext } from '../../engine/contracts/tools.js'
import { createCoreTools } from '../../tools/core-tools.js'
import {
  applyTodoAction,
  deriveActiveTodoBatch,
  deriveOpenTodoList,
  extractInProgressTodo,
  extractLatestActionableTodos,
  extractLatestUnfinishedTodos,
  type TodoSessionAnchor,
} from '../todo-replay.js'

function assistantTodo(input: Record<string, unknown>, id = 'tu-1'): Message {
  return {
    role: 'assistant',
    content: [
      {
        type: 'tool_use',
        id,
        name: 'todo',
        input,
      },
    ],
  }
}

function toolResult(
  toolUseId: string,
  opts?: { isError?: boolean; content?: string },
): Message {
  return {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: opts?.content ?? (opts?.isError ? 'error' : 'ok'),
        is_error: opts?.isError,
      },
    ],
  }
}

describe('deriveActiveTodoBatch', () => {
  it('从未 todo → null', () => {
    expect(deriveActiveTodoBatch([{ role: 'user', content: 'hi' }])).toBeNull()
  })

  it('open 后未收尾 → unsettled', () => {
    const batch = deriveActiveTodoBatch([
      assistantTodo({
        action: 'open',
        items: [
          { id: 'a', content: 'A', status: 'in_progress' },
          { id: 'b', content: 'B', status: 'pending' },
        ],
      }),
    ])
    expect(batch?.settled).toBe(false)
    expect(batch?.todos.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('close 后 → settled', () => {
    const batch = deriveActiveTodoBatch([
      assistantTodo(
        {
          action: 'open',
          items: [{ id: 'a', content: 'A', status: 'in_progress' }],
        },
        'tu-1',
      ),
      assistantTodo({ action: 'close' }, 'tu-2'),
    ])
    expect(batch?.settled).toBe(true)
    expect(batch?.todos.every((t) => t.status === 'cancelled')).toBe(true)
  })

  it('全完成自动关 → settled', () => {
    const batch = deriveActiveTodoBatch([
      assistantTodo(
        {
          action: 'open',
          items: [{ id: 'a', content: 'A', status: 'in_progress' }],
        },
        'tu-1',
      ),
      assistantTodo({ action: 'update', id: 'a', status: 'completed' }, 'tu-2'),
    ])
    expect(batch?.settled).toBe(true)
    expect(batch?.todos[0]?.status).toBe('completed')
  })

  it('窗口无 todo 但有种子 → 返回种子', () => {
    const batch = deriveActiveTodoBatch([{ role: 'user', content: 'hi' }], [
      { id: 'a', content: 'A', status: 'in_progress' },
    ])
    expect(batch?.settled).toBe(false)
    expect(batch?.todos.map((t) => t.id)).toEqual(['a'])
  })

  it('窗口内有 todo 时忽略种子，以消息为准', () => {
    const batch = deriveActiveTodoBatch(
      [
        assistantTodo({
          action: 'open',
          items: [{ id: 'x', content: 'X', status: 'pending' }],
        }),
      ],
      [{ id: 'old', content: 'Old', status: 'in_progress' }],
    )
    expect(batch?.todos.map((t) => t.id)).toEqual(['x'])
  })
})

describe('extract helpers', () => {
  it('extractLatestUnfinishedTodos', () => {
    const unfinished = extractLatestUnfinishedTodos([
      assistantTodo({
        action: 'open',
        items: [
          { id: 'a', content: 'A', status: 'completed' },
          { id: 'b', content: 'B', status: 'pending' },
        ],
      }),
    ])
    expect(unfinished.map((t) => t.id)).toEqual(['b'])
  })

  it('paused 仍属于未完成连续性，但不会进入 end_turn actionable gate', () => {
    const messages = [
      assistantTodo({
        action: 'open',
        items: [
          { id: 'oauth', content: '检查 OAuth 授权', status: 'in_progress' },
        ],
      }),
      assistantTodo({
        action: 'update',
        id: 'oauth',
        status: 'paused',
        content: '等待用户完成 OAuth 授权',
      }, 'tu-2'),
    ]
    expect(extractLatestUnfinishedTodos(messages).map((t) => t.id)).toEqual(['oauth'])
    expect(extractLatestActionableTodos(messages)).toEqual([])
  })

  it('paused 当前项会暂停本轮，不把后续 pending 视为当前可执行', () => {
    const messages = [
      assistantTodo({
        action: 'open',
        items: [
          { id: 'oauth', content: '等待 OAuth', status: 'in_progress' },
          { id: 'fetch', content: '读取授权后的数据', status: 'pending' },
        ],
      }),
      assistantTodo({ action: 'update', id: 'oauth', status: 'paused' }, 'tu-2'),
    ]

    expect(extractLatestUnfinishedTodos(messages).map((todo) => todo.id)).toEqual(['oauth', 'fetch'])
    expect(extractLatestActionableTodos(messages)).toEqual([])
  })

  it('paused 后尝试启动其他项会被状态机忽略，end_turn gate 不会看到假 in_progress', () => {
    const messages = [
      assistantTodo({
        action: 'open',
        items: [
          { id: 'oauth', content: '检查 OAuth 授权', status: 'in_progress' },
          { id: 'next', content: '继续后续任务', status: 'pending' },
        ],
      }),
      assistantTodo({
        action: 'update',
        id: 'oauth',
        status: 'paused',
        content: '等待用户完成 OAuth 授权',
      }, 'tu-2'),
      assistantTodo({
        action: 'update',
        id: 'next',
        status: 'in_progress',
      }, 'tu-3'),
    ]

    expect(extractLatestUnfinishedTodos(messages).map((t) => `${t.id}:${t.status}`)).toEqual([
      'oauth:paused',
      'next:pending',
    ])
    expect(extractLatestActionableTodos(messages)).toEqual([])
  })

  it('多个 paused 后恢复其中一个的非法路径会被状态机收窄为单一 in_progress', () => {
    const messages = [
      assistantTodo({
        action: 'open',
        items: [
          { id: 'a', content: '等待 A', status: 'in_progress' },
          { id: 'b', content: '等待 B', status: 'pending' },
        ],
      }),
      assistantTodo({
        action: 'update',
        id: 'a',
        status: 'paused',
        content: '等待 A 解除阻塞',
      }, 'tu-2'),
      assistantTodo({
        action: 'update',
        id: 'b',
        status: 'paused',
        content: '等待 B 解除阻塞',
      }, 'tu-3'),
      assistantTodo({
        action: 'update',
        id: 'a',
        status: 'in_progress',
        content: 'A 已解除阻塞，继续处理',
      }, 'tu-4'),
    ]

    expect(extractLatestUnfinishedTodos(messages).map((t) => `${t.id}:${t.status}`)).toEqual([
      'a:in_progress',
      'b:pending',
    ])
    const actionable = extractLatestActionableTodos(messages).map((t) => `${t.id}:${t.status}`)
    expect(actionable).toEqual([
      'a:in_progress',
      'b:pending',
    ])
    expect(actionable.some((entry) => entry.endsWith(':paused'))).toBe(false)
  })

  it('extractInProgressTodo', () => {
    expect(
      extractInProgressTodo([
        assistantTodo({
          action: 'open',
          items: [
            { id: 'a', content: 'Doing A', status: 'in_progress' },
            { id: 'b', content: 'B', status: 'pending' },
          ],
        }),
      ]),
    ).toBe('Doing A')
  })

  it('deriveOpenTodoList closed → open null', () => {
    const state = deriveOpenTodoList([
      assistantTodo(
        {
          action: 'open',
          items: [{ id: 'a', content: 'A', status: 'completed' }],
        },
        'tu-1',
      ),
    ])
    // open with all completed auto-closes
    expect(state.open).toBeNull()
  })
})

describe('deriveOpenTodoList 提交边界（ live）', () => {
  const openInput = {
    action: 'open',
    items: [
      { id: '1', content: 'A', status: 'in_progress' },
      { id: '2', content: 'B', status: 'pending' },
    ],
  }

  it('正：空历史 + in-flight open（exclude 自身）→ open=null，可再 open', () => {
    const messages = [assistantTodo(openInput, 'tu-inflight')]
    // 不排除时会自撞成 already_open 前置态
    expect(deriveOpenTodoList(messages).open?.map((t) => t.id)).toEqual(['1', '2'])
    expect(
      deriveOpenTodoList(messages, undefined, {
        excludeToolUseIds: ['tu-inflight'],
      }).open,
    ).toBeNull()
  })

  it('正：成功 open 后同轮前序可见，exclude 仅当前 update', () => {
    const messages = [
      assistantTodo(openInput, 'tu-open'),
      // 同轮串行：open 的 result 可能尚未入 messages，但 tool_use 已在
      assistantTodo({ action: 'update', id: '1', status: 'completed' }, 'tu-upd'),
    ]
    const preUpdate = deriveOpenTodoList(messages, undefined, {
      excludeToolUseIds: ['tu-upd'],
    })
    expect(preUpdate.open?.map((t) => t.id)).toEqual(['1', '2'])
  })

  it('正：失败 open 不入账，后续 derive open=null', () => {
    const messages = [
      assistantTodo(openInput, 'tu-fail'),
      toolResult('tu-fail', { isError: true }),
    ]
    expect(deriveOpenTodoList(messages).open).toBeNull()
    expect(deriveActiveTodoBatch(messages)).toBeNull()
  })

  it('反：不 exclude 自身、仅一条 open tool_use → 前置态已 open（锁自撞回归）', () => {
    const messages = [assistantTodo(openInput, 'tu-self')]
    expect(deriveOpenTodoList(messages).open).not.toBeNull()
  })

  it('正：模拟 execute——exclude 自身后 open 成功（复现 session 首次 open）', () => {
    const messages = [assistantTodo(openInput, 'tu_9b2cd1b5')]
    const current = deriveOpenTodoList(messages, undefined, {
      excludeToolUseIds: ['tu_9b2cd1b5'],
    })
    const result = applyTodoAction(current, openInput)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.action).toBe('open')
      expect(result.snapshot).toHaveLength(2)
    }
  })
})

describe('todo execute + 会话锚（ /  截断）', () => {
  function todoTool(anchor?: TodoSessionAnchor) {
    const tool = createCoreTools({ todoSessionAnchor: anchor }).find((t) => t.name === 'todo')
    if (!tool) throw new Error('todo tool missing')
    return tool
  }

  function ctx(messages: Message[], toolUseId: string): ToolContext {
    return {
      threadId: 't',
      runtimeId: 'rt',
      agentRunId: 'ar',
      toolUseId,
      abortSignal: new AbortController().signal,
      messages,
    }
  }

  it('正：空窗口 + unsettled seed → update 成功，再 open 失败', async () => {
    const anchor: TodoSessionAnchor = {
      current: [
        { id: '1', content: 'A', status: 'in_progress' },
        { id: '2', content: 'B', status: 'pending' },
      ],
    }
    const tool = todoTool(anchor)
    // 上下文截断后 messages 里已无 todo 事件
    const emptyWindow: Message[] = [
      { role: 'user', content: '继续' },
      assistantTodo({ action: 'update', id: '1', status: 'completed' }, 'tu-upd'),
    ]
    const upd = await tool.execute(
      { action: 'update', id: '1', status: 'completed' },
      ctx(emptyWindow, 'tu-upd'),
    )
    expect(upd.isError).toBeFalsy()
    expect(anchor.current?.find((t) => t.id === '1')?.status).toBe('completed')
    expect(anchor.current?.find((t) => t.id === '2')?.status).toBe('pending')

    // 仍截断：窗口只有新的 open tool_use；种子仍为未关闭列表 → already_open
    const openAgain = await tool.execute(
      {
        action: 'open',
        items: [{ id: 'x', content: 'X', status: 'in_progress' }],
      },
      ctx(
        [
          { role: 'user', content: '新计划' },
          assistantTodo(
            {
              action: 'open',
              items: [{ id: 'x', content: 'X', status: 'in_progress' }],
            },
            'tu-open2',
          ),
        ],
        'tu-open2',
      ),
    )
    expect(openAgain.isError).toBe(true)
    const err = JSON.parse(openAgain.content as string) as { error_kind?: string }
    expect(err.error_kind).toBe('todo_list_already_open')
  })

  it('反：空窗口无 seed → update 得 TODO_LIST_NOT_OPEN', async () => {
    const tool = todoTool()
    const messages: Message[] = [
      { role: 'user', content: '继续' },
      assistantTodo({ action: 'update', id: '1', status: 'completed' }, 'tu-upd'),
    ]
    const r = await tool.execute(
      { action: 'update', id: '1', status: 'completed' },
      ctx(messages, 'tu-upd'),
    )
    expect(r.isError).toBe(true)
    const err = JSON.parse(r.content as string) as { error_kind?: string }
    expect(err.error_kind).toBe('todo_list_not_open')
  })
})
