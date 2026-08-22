/**
 * subagentStreamHandler.test.ts — PRD §4.18 SUBAGENT_STREAM_EVENT 拆包回归
 *
 * 测什么：
 *   - 正常路径：拆包 child_event 后调 useSubagentLiveStore.applyChildEvent，
 *     parentSessionId 取自 ctx.sessionId
 *   - done / lifecycle.end → markRunTerminal（只关闭详情 transcript，不改聚合卡状态）
 *   - 缺 subagent_run_id：silent skip 不调 apply
 *   - child_event 形态非法（缺 type / payload）：silent skip 不调 apply
 *   - chain 字段透传到 store
 *
 * 测试策略：用 vi.spyOn(useSubagentLiveStore.getState(), 'applyChildEvent') 等
 * 直接观测 store action 调用——与 subagentHandler.test.ts 风格一致（通过 mock
 * store + ctx 观测调用入参），但本 handler 通过 useSubagentLiveStore 单例间接
 * 写 store，所以测试用 spy 而非 makeCtx-style mock。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleSubagentStreamEvent } from '../subagentStreamHandler'
import { useSubagentLiveStore, flushSubagentLiveBatch } from '../../../../subagentLive'
import { StreamEvents } from '@tabtin/agent-wire'
import type { HandlerContext } from '../../../stream/handlers/streamHandlerTypes'
import type { SubagentRun } from '../../../shared/types'

const store = {
  subagentRunsBySessionId: {} as Record<string, SubagentRun[]>,
  markSubagentRunTerminalForSession: vi.fn((
    sessionId: string,
    subagentRunId: string,
    status: Extract<SubagentRun['status'], 'completed' | 'failed' | 'cancelled'>,
  ) => {
    const runs = store.subagentRunsBySessionId[sessionId] ?? []
    const idx = runs.findIndex(run => run.subagentRunId === subagentRunId)
    if (idx < 0) return
    const current = runs[idx]
    if (current.status === 'completed' || current.status === 'failed' || current.status === 'cancelled') return
    store.subagentRunsBySessionId[sessionId] = [
      ...runs.slice(0, idx),
      { ...current, status },
      ...runs.slice(idx + 1),
    ]
  }),
}

function makeCtx(sessionId = 'parent-session-1'): HandlerContext {
  return {
    sessionId,
    get: () => store as never,
    set: vi.fn(),
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: { sessions: { get: vi.fn() } } as never,
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
    notifyPrefix: '',
  } as never
}

beforeEach(() => {
  useSubagentLiveStore.getState().clear()
  store.subagentRunsBySessionId = {}
  store.markSubagentRunTerminalForSession.mockClear()
})

describe('handleSubagentStreamEvent', () => {
  it('正常路径：拆包 child_event 调 applyChildEvent，parentSessionId 来自 ctx.sessionId', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          parent_run_id: null,
          subagent_chain: ['run-a'],
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1', role: 'assistant' },
          },
        },
      },
      makeCtx('session-X'),
    )
    flushSubagentLiveBatch()

    const entry = useSubagentLiveStore.getState().runsByRunId['run-a']
    expect(entry).toBeTruthy()
    expect(entry?.parentSessionId).toBe('session-X')
    expect(entry?.chain).toEqual(['run-a'])
    expect(entry?.messages).toHaveLength(1)
  })

  it('child_event done → markRunTerminal', () => {
    // 先 apply 一条让 entry 存在
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1', role: 'assistant' },
          },
        },
      },
      makeCtx(),
    )
    expect(useSubagentLiveStore.getState().runsByRunId['run-a']?.isTerminal).toBe(false)

    // done event → 翻 isTerminal=true
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: { type: 'agent.stream.done', payload: { message_id: 'msg-1' } },
        },
      },
      makeCtx(),
    )
    expect(useSubagentLiveStore.getState().runsByRunId['run-a']?.isTerminal).toBe(true)
    expect(store.markSubagentRunTerminalForSession).not.toHaveBeenCalled()
  })

  it('child_event done 不直接收敛聚合卡状态', () => {
    store.subagentRunsBySessionId['parent-session-1'] = [
      { subagentRunId: 'run-a', status: 'running', stepCount: 3 } as SubagentRun,
    ]

    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: { type: 'agent.stream.done', payload: { message_id: 'msg-1' } },
        },
      },
      makeCtx(),
    )

    expect(store.subagentRunsBySessionId['parent-session-1'][0]).toMatchObject({
      subagentRunId: 'run-a',
      status: 'running',
      stepCount: 3,
    })
    expect(store.markSubagentRunTerminalForSession).not.toHaveBeenCalled()
  })

  it('child_event lifecycle.end → markRunTerminal', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1', role: 'assistant' },
          },
        },
      },
      makeCtx(),
    )

    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: { type: 'agent.stream.lifecycle', payload: { phase: 'end' } },
        },
      },
      makeCtx(),
    )
    expect(useSubagentLiveStore.getState().runsByRunId['run-a']?.isTerminal).toBe(true)
    expect(store.markSubagentRunTerminalForSession).not.toHaveBeenCalled()
  })

  it('child_event lifecycle.end 不覆盖已有 failed/cancelled 终态', () => {
    store.subagentRunsBySessionId['parent-session-1'] = [
      { subagentRunId: 'run-failed', status: 'failed', error: 'boom' } as SubagentRun,
      { subagentRunId: 'run-cancelled', status: 'cancelled', error: 'stopped' } as SubagentRun,
    ]

    for (const runId of ['run-failed', 'run-cancelled']) {
      handleSubagentStreamEvent(
        {
          type: StreamEvents.SUBAGENT_STREAM_EVENT,
          payload: {
            subagent_run_id: runId,
            child_event: { type: 'agent.stream.lifecycle', payload: { phase: 'end' } },
          },
        },
        makeCtx(),
      )
    }

    expect(store.subagentRunsBySessionId['parent-session-1'][0].status).toBe('failed')
    expect(store.subagentRunsBySessionId['parent-session-1'][1].status).toBe('cancelled')
  })

  it('lifecycle.start 不触发 markRunTerminal', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: { type: 'agent.stream.lifecycle', payload: { phase: 'start' } },
        },
      },
      makeCtx(),
    )
    const entry = useSubagentLiveStore.getState().runsByRunId['run-a']
    expect(entry?.isTerminal).toBe(false)
  })

  it('缺 subagent_run_id：silent skip 不创建 entry', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1' },
          },
        },
      },
      makeCtx(),
    )
    expect(Object.keys(useSubagentLiveStore.getState().runsByRunId)).toHaveLength(0)
  })

  it('child_event 缺 type：silent skip 不创建 entry', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: { payload: {} },
        },
      },
      makeCtx(),
    )
    expect(Object.keys(useSubagentLiveStore.getState().runsByRunId)).toHaveLength(0)
  })

  it('child_event 缺 payload：silent skip 不创建 entry', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: { type: 'agent.stream.message_start' },
        },
      },
      makeCtx(),
    )
    expect(Object.keys(useSubagentLiveStore.getState().runsByRunId)).toHaveLength(0)
  })

  it('嵌套 chain 字段透传到 store', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-grandchild',
          parent_run_id: 'run-child',
          subagent_chain: ['run-child', 'run-grandchild'],
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1', role: 'assistant' },
          },
        },
      },
      makeCtx(),
    )
    const entry = useSubagentLiveStore.getState().runsByRunId['run-grandchild']
    expect(entry?.chain).toEqual(['run-child', 'run-grandchild'])
  })

  it('subagent_chain 非数组：silent 走 undefined chain', () => {
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          subagent_chain: 'not-an-array',
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1' },
          },
        },
      },
      makeCtx(),
    )
    const entry = useSubagentLiveStore.getState().runsByRunId['run-a']
    expect(entry).toBeTruthy()
    expect(entry?.chain).toBeUndefined()
  })

  it('多次 apply 同 runId 累积内容到同一条 message（实时流增量）', () => {
    const ctx = makeCtx()
    const runId = 'run-a'
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: runId,
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1', role: 'assistant' },
          },
        },
      },
      ctx,
    )
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: runId,
          child_event: {
            type: 'agent.stream.content_block_start',
            payload: { message_id: 'msg-1', index: 0, block: { type: 'text', text: '' } },
          },
        },
      },
      ctx,
    )
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: runId,
          child_event: {
            type: 'agent.stream.content_block_delta',
            payload: { message_id: 'msg-1', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
          },
        },
      },
      ctx,
    )
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: runId,
          child_event: {
            type: 'agent.stream.content_block_delta',
            payload: { message_id: 'msg-1', index: 0, delta: { type: 'text_delta', text: ' there' } },
          },
        },
      },
      ctx,
    )
    flushSubagentLiveBatch()

    const entry = useSubagentLiveStore.getState().runsByRunId[runId]
    expect(entry?.messages).toHaveLength(1)
    expect(entry?.messages[0]?.content).toBe('Hi there')
  })

  it('终态后迟到的 wrapped delta 不再写入 live store', () => {
    const ctx = makeCtx()
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: {
            type: 'agent.stream.message_start',
            payload: { message_id: 'msg-1', role: 'assistant' },
          },
        },
      },
      ctx,
    )
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: {
            type: 'agent.stream.content_block_start',
            payload: { message_id: 'msg-1', index: 0, block: { type: 'text', text: '' } },
          },
        },
      },
      ctx,
    )
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: {
            type: 'agent.stream.content_block_delta',
            payload: { message_id: 'msg-1', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          },
        },
      },
      ctx,
    )
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: { type: 'agent.stream.done', payload: { message_id: 'msg-1' } },
        },
      },
      ctx,
    )
    handleSubagentStreamEvent(
      {
        type: StreamEvents.SUBAGENT_STREAM_EVENT,
        payload: {
          subagent_run_id: 'run-a',
          child_event: {
            type: 'agent.stream.content_block_delta',
            payload: { message_id: 'msg-1', index: 0, delta: { type: 'text_delta', text: ' late' } },
          },
        },
      },
      ctx,
    )
    flushSubagentLiveBatch()

    const entry = useSubagentLiveStore.getState().runsByRunId['run-a']
    expect(entry?.isTerminal).toBe(true)
    expect(entry?.messages[0]?.content).toBe('ok')
  })
})
