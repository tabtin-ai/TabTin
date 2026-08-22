/**
 * useSubagentLiveStore.test.ts — PRD §4.18 子 Agent 实时流 store 回归
 *
 * 测什么：
 *   - applyChildEvent：增量 apply envelope，messages 数组随之累积；in-place 修改
 *     状态机内部对象，但每次 selectReplayMessages 派生新 array 引用
 *   - LRU 50：终态 run 超过 50 时按 lastTouched 最老的 evict；running 不进候选
 *   - markRunTerminal：幂等；只翻一次 isTerminal=true
 *   - clearByRunId / clearByParentSession / clear：精确清理
 *   - chain 字段：首次写入后不被后续 apply 覆盖
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useSubagentLiveStore, flushSubagentLiveBatch } from '../subagentLive'

function envMessageStart(messageId: string, role: 'user' | 'assistant' = 'assistant') {
  return {
    type: 'agent.stream.message_start',
    payload: { message_id: messageId, role },
  }
}

function envContentBlockStart(messageId: string, index: number, block: Record<string, unknown>) {
  return {
    type: 'agent.stream.content_block_start',
    payload: { message_id: messageId, index, block },
  }
}

function envContentBlockDelta(messageId: string, index: number, delta: Record<string, unknown>) {
  return {
    type: 'agent.stream.content_block_delta',
    payload: { message_id: messageId, index, delta },
  }
}

function envDone(messageId: string) {
  return {
    type: 'agent.stream.done',
    payload: { message_id: messageId },
  }
}

beforeEach(() => {
  useSubagentLiveStore.getState().clear()
})

describe('useSubagentLiveStore', () => {
  it('applyChildEvent: message_start 创建消息 + delta 累积文本', () => {
    const store = useSubagentLiveStore.getState()
    const runId = 'run-1'

    store.applyChildEvent(runId, envMessageStart('msg-1'), 'parent-session')
    store.applyChildEvent(runId, envContentBlockStart('msg-1', 0, { type: 'text', text: '' }))
    store.applyChildEvent(runId, envContentBlockDelta('msg-1', 0, { type: 'text_delta', text: 'Hello' }))
    store.applyChildEvent(runId, envContentBlockDelta('msg-1', 0, { type: 'text_delta', text: ' world' }))
    flushSubagentLiveBatch()

    const entry = useSubagentLiveStore.getState().runsByRunId[runId]
    expect(entry).toBeTruthy()
    expect(entry?.messages).toHaveLength(1)
    expect(entry?.messages[0]?.content).toBe('Hello world')
    expect(entry?.parentSessionId).toBe('parent-session')
  })

  it('messages array 每次 apply 后引用变化（让 React selector 触发 re-render）', () => {
    const store = useSubagentLiveStore.getState()
    const runId = 'run-1'

    store.applyChildEvent(runId, envMessageStart('msg-1'))
    flushSubagentLiveBatch()
    const arr1 = useSubagentLiveStore.getState().runsByRunId[runId]?.messages
    store.applyChildEvent(runId, envContentBlockStart('msg-1', 0, { type: 'text', text: '' }))
    flushSubagentLiveBatch()
    const arr2 = useSubagentLiveStore.getState().runsByRunId[runId]?.messages
    store.applyChildEvent(runId, envContentBlockDelta('msg-1', 0, { type: 'text_delta', text: 'x' }))
    flushSubagentLiveBatch()
    const arr3 = useSubagentLiveStore.getState().runsByRunId[runId]?.messages

    expect(arr1).not.toBe(arr2)
    expect(arr2).not.toBe(arr3)
  })

  it('parentSessionId / chain 首次写入后不被后续 apply 覆盖', () => {
    const store = useSubagentLiveStore.getState()
    const runId = 'run-1'

    store.applyChildEvent(runId, envMessageStart('msg-1'), 'session-A', ['run-1'])
    // 第二次 apply 故意传不同的 parent + chain（模拟代码 bug / 多路 forward 不一致）
    store.applyChildEvent(runId, envMessageStart('msg-2'), 'session-B', ['xxx', 'run-1'])

    const entry = useSubagentLiveStore.getState().runsByRunId[runId]
    expect(entry?.parentSessionId).toBe('session-A') // 保持最早值
    expect(entry?.chain).toEqual(['run-1'])
  })

  it('LRU 50：新 run 加入瞬间检查终态计数；终态 ≥50 时 evict 最老的', () => {
    const store = useSubagentLiveStore.getState()
    // 创建 50 个终态 run（apply 时上一轮全 < 50 → 不 evict；markTerminal 把当前
    // 这个翻成 terminal）。循环结束时存储 50 个 terminal run。
    for (let i = 0; i < 50; i++) {
      const runId = `terminal-${i}`
      store.applyChildEvent(runId, envMessageStart(`msg-${i}`), 'session-A')
      store.markRunTerminal(runId)
    }
    expect(Object.keys(useSubagentLiveStore.getState().runsByRunId)).toHaveLength(50)

    // 第 51 个新 run 加入瞬间：terminal 列表 50 个 ≥ 50，触发 evict 1 个最老的
    // （terminal-0）；新加的 terminal-50 还是 running 态（还没 markTerminal）。
    store.applyChildEvent('terminal-50', envMessageStart('msg-50'), 'session-A')
    const after = useSubagentLiveStore.getState().runsByRunId
    expect(Object.keys(after)).toHaveLength(50) // terminal-1..terminal-50
    expect(after['terminal-0']).toBeUndefined()
    expect(after['terminal-50']).toBeTruthy()
    expect(after['terminal-50']?.isTerminal).toBe(false)
  })

  it('LRU 不 evict running 状态的 run（即使在 50 之外）', () => {
    const store = useSubagentLiveStore.getState()
    // 60 个 running run（不 markTerminal）
    for (let i = 0; i < 60; i++) {
      const runId = `running-${i}`
      store.applyChildEvent(runId, envMessageStart(`msg-${i}`), 'session-A')
    }
    // running 都不在 LRU 候选，不应该被 evict
    expect(Object.keys(useSubagentLiveStore.getState().runsByRunId)).toHaveLength(60)
  })

  it('markRunTerminal 幂等 + 翻一次 isTerminal=true', () => {
    const store = useSubagentLiveStore.getState()
    const runId = 'run-1'
    store.applyChildEvent(runId, envMessageStart('msg-1'))
    expect(useSubagentLiveStore.getState().runsByRunId[runId]?.isTerminal).toBe(false)

    store.markRunTerminal(runId)
    expect(useSubagentLiveStore.getState().runsByRunId[runId]?.isTerminal).toBe(true)

    // 重复 markTerminal 应当幂等不改 state（state 引用同）
    const prevState = useSubagentLiveStore.getState().runsByRunId
    store.markRunTerminal(runId)
    expect(useSubagentLiveStore.getState().runsByRunId).toBe(prevState)
  })

  it('markRunTerminal 对不存在的 runId 不创建新 entry', () => {
    const store = useSubagentLiveStore.getState()
    store.markRunTerminal('nonexistent')
    expect(useSubagentLiveStore.getState().runsByRunId['nonexistent']).toBeUndefined()
  })

  it('clearByRunId 精确清掉单个 run', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent('run-a', envMessageStart('msg-a'), 'session-1')
    store.applyChildEvent('run-b', envMessageStart('msg-b'), 'session-1')
    store.clearByRunId('run-a')
    const remaining = useSubagentLiveStore.getState().runsByRunId
    expect(remaining['run-a']).toBeUndefined()
    expect(remaining['run-b']).toBeTruthy()
  })

  it('clearByParentSession 清掉同一父 session 下所有 run', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent('run-a', envMessageStart('msg-a'), 'session-1')
    store.applyChildEvent('run-b', envMessageStart('msg-b'), 'session-1')
    store.applyChildEvent('run-c', envMessageStart('msg-c'), 'session-2')
    store.clearByParentSession('session-1')
    const remaining = useSubagentLiveStore.getState().runsByRunId
    expect(remaining['run-a']).toBeUndefined()
    expect(remaining['run-b']).toBeUndefined()
    expect(remaining['run-c']).toBeTruthy()
  })

  it('clear 全清', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent('run-a', envMessageStart('msg-a'))
    store.applyChildEvent('run-b', envMessageStart('msg-b'))
    store.clear()
    expect(Object.keys(useSubagentLiveStore.getState().runsByRunId)).toHaveLength(0)
  })

  it('child_event 缺 message_id：silent skip 不创建 entry', () => {
    const store = useSubagentLiveStore.getState()
    store.applyChildEvent('run-1', { type: 'agent.stream.lifecycle', payload: { phase: 'start' } } as never, 'session-1')
    // entry 创建了（store 在首次 apply 就建 entry），但 messages 为空
    const entry = useSubagentLiveStore.getState().runsByRunId['run-1']
    expect(entry?.messages).toEqual([])
  })

  it('done 事件不影响 messages 累积（仅作终态触发点的判定材料，状态翻转由 markRunTerminal 触发）', () => {
    const store = useSubagentLiveStore.getState()
    const runId = 'run-1'
    store.applyChildEvent(runId, envMessageStart('msg-1'))
    store.applyChildEvent(runId, envContentBlockStart('msg-1', 0, { type: 'text', text: '' }))
    store.applyChildEvent(runId, envContentBlockDelta('msg-1', 0, { type: 'text_delta', text: 'final' }))
    store.applyChildEvent(runId, envDone('msg-1'))
    flushSubagentLiveBatch()

    const entry = useSubagentLiveStore.getState().runsByRunId[runId]
    expect(entry?.messages[0]?.content).toBe('final')
    // done 本身不会让 store 自动标 terminal（那是 handler 的职责，store 只接受外部 markRunTerminal 通知）
    expect(entry?.isTerminal).toBe(false)
  })

  it('终态后迟到的 delta 不再累积，避免已完成子 run 继续烧主线程', () => {
    const store = useSubagentLiveStore.getState()
    const runId = 'run-1'
    store.applyChildEvent(runId, envMessageStart('msg-1'), 'parent-session')
    store.applyChildEvent(runId, envContentBlockStart('msg-1', 0, { type: 'text', text: '' }))
    store.applyChildEvent(runId, envContentBlockDelta('msg-1', 0, { type: 'text_delta', text: 'done' }))
    flushSubagentLiveBatch()
    store.markRunTerminal(runId)

    store.applyChildEvent(runId, envContentBlockDelta('msg-1', 0, { type: 'text_delta', text: ' extra' }))
    flushSubagentLiveBatch()

    const entry = useSubagentLiveStore.getState().runsByRunId[runId]
    expect(entry?.isTerminal).toBe(true)
    expect(entry?.messages[0]?.content).toBe('done')
  })
})
