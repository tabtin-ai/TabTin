/**
 * useSubagentRuns.test.tsx — W3 聚合视图共享 hook 回归
 *
 * `useSubagentRuns(sessionId, ids)` 是 W3 聚合视图（BlockTimeline 检测连续
 * subagent tool_use block 后）的核心反查 hook —— 把"父 LLM 给的 tool_use.id
 * 数组（toolu_xxx）"反查到对应 SubagentRun 列表，并按 ids 顺序返回。
 *
 * 锁住以下契约：
 *   1. **按 ids 顺序返回**：不是 store 内的自然顺序，让聚合视图行序与父
 *      message 中 tool_use block 物理顺序一致
 *   2. **双向匹配**：每个 id 既可命中 `r.subagentRunId`（精确）也可命中
 *      `r.parentToolCallId`（反查）
 *   3. **部分匹配 + filter undefined**：传入 5 个 id 但 store 只有 3 个匹
 *      配时，返回的 3 个 run 按入参顺序保留位置（不返回 undefined 占位）
 *   4. **EMPTY_RUNS 引用稳定**：连续两次都查不到时返回**同一**空数组引
 *      用——避免 useShallow 因为新空数组引用判定"变了"触发无意义 re-render
 *
 * 测试策略：
 *   - 用真 zustand store（不 mock），让 selector 走真链路
 *   - 监测 hook 返回值身份 / re-render 次数验证 useShallow 命中
 */

import React, { useRef } from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act, renderHook } from '@testing-library/react'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useSubagentRuns } from '../useSubagentRuns'
import type { SubagentRun } from '../../../../stores/chat/shared/types'

const SESSION_ID = 'session-runs-test'

function makeRun(overrides: Partial<SubagentRun> & { subagentRunId: string }): SubagentRun {
  return {
    status: 'running',
    ...overrides,
  } as SubagentRun
}

beforeEach(() => {
  useChatRuntimeStore.setState({ subagentRunsBySessionId: {} })
})

describe('useSubagentRuns — 顺序保持', () => {
  it('按 ids 顺序返回（与 store 内自然顺序无关）', () => {
    const r1 = makeRun({ subagentRunId: 'r1' })
    const r2 = makeRun({ subagentRunId: 'r2' })
    const r3 = makeRun({ subagentRunId: 'r3' })
    // store 内是 [r1, r2, r3]，hook 入参 [r3, r1, r2] —— 应按入参顺序返
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { [SESSION_ID]: [r1, r2, r3] },
    })

    const { result } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['r3', 'r1', 'r2']),
    )
    expect(result.current.map((r) => r.subagentRunId)).toEqual(['r3', 'r1', 'r2'])
  })

  it('入参为空数组 → 空数组', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [SESSION_ID]: [makeRun({ subagentRunId: 'r1' })],
      },
    })
    const { result } = renderHook(() => useSubagentRuns(SESSION_ID, []))
    expect(result.current).toEqual([])
  })

  it('sessionId=null → 空数组', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [SESSION_ID]: [makeRun({ subagentRunId: 'r1' })],
      },
    })
    const { result } = renderHook(() => useSubagentRuns(null, ['r1']))
    expect(result.current).toEqual([])
  })
})

describe('useSubagentRuns — 双向匹配', () => {
  it('parentToolCallId 反查：传入父 toolu_xxx 能命中', () => {
    const r1 = makeRun({
      subagentRunId: 'run-uuid-1',
      parentToolCallId: 'toolu_aaa',
    })
    const r2 = makeRun({
      subagentRunId: 'run-uuid-2',
      parentToolCallId: 'toolu_bbb',
    })
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { [SESSION_ID]: [r1, r2] },
    })
    const { result } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['toolu_aaa', 'toolu_bbb']),
    )
    expect(result.current).toHaveLength(2)
    expect(result.current[0].subagentRunId).toBe('run-uuid-1')
    expect(result.current[1].subagentRunId).toBe('run-uuid-2')
  })

  it('混合匹配：subagentRunId 精确 + parentToolCallId 反查同时存在', () => {
    const r1 = makeRun({ subagentRunId: 'run-1' })
    const r2 = makeRun({
      subagentRunId: 'run-2',
      parentToolCallId: 'toolu_xxx',
    })
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { [SESSION_ID]: [r1, r2] },
    })
    const { result } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['run-1', 'toolu_xxx']),
    )
    expect(result.current.map((r) => r.subagentRunId)).toEqual(['run-1', 'run-2'])
  })
})

describe('useSubagentRuns — 部分匹配', () => {
  it('传入 5 个 id 但 store 只有 3 个 → 返回 3 个匹配的，按入参顺序', () => {
    const runs = [
      makeRun({ subagentRunId: 'r1' }),
      makeRun({ subagentRunId: 'r3' }),
      makeRun({ subagentRunId: 'r5' }),
    ]
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { [SESSION_ID]: runs },
    })
    const { result } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['r1', 'r2', 'r3', 'r4', 'r5']),
    )
    // r2 / r4 缺失被 filter 掉，剩下的按入参顺序
    expect(result.current.map((r) => r.subagentRunId)).toEqual(['r1', 'r3', 'r5'])
  })

  it('全部 id 都查不到 → 空数组', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [SESSION_ID]: [makeRun({ subagentRunId: 'r1' })],
      },
    })
    const { result } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['missing-1', 'missing-2']),
    )
    expect(result.current).toEqual([])
  })

  it('store 中无对应 session 条目 → 空数组', () => {
    const { result } = renderHook(() =>
      useSubagentRuns('non-existent-session', ['anything']),
    )
    expect(result.current).toEqual([])
  })
})

describe('useSubagentRuns — EMPTY_RUNS 引用稳定', () => {
  // 关键回归：useShallow 比较时 [] !== []，如果每次返回新空数组引用，会让
  // 所有"无匹配"路径都触发 re-render。EMPTY_RUNS 模块级共享单例避免这种
  // 浪费——本测验证连续多次调用返回同一引用。
  it('连续两次都空 → 返回同一引用（不触发 re-render）', () => {
    const renders: Array<{ runs: SubagentRun[]; count: number }> = []
    function TestComp({ ids }: { ids: readonly string[] }) {
      const renderCountRef = useRef(0)
      renderCountRef.current += 1
      const runs = useSubagentRuns(SESSION_ID, ids)
      renders.push({ runs, count: renderCountRef.current })
      return <div data-testid="empty-test" />
    }

    const ids = ['missing-a', 'missing-b']
    const { rerender } = render(<TestComp ids={ids} />)
    const initialRenderCount = renders.length

    // 触发 store 变化（其他 session 的 run）—— 不影响本 hook 的查询路径
    act(() => {
      useChatRuntimeStore.setState({
        subagentRunsBySessionId: {
          'other-session': [makeRun({ subagentRunId: 'irrelevant' })],
        },
      })
    })

    // useShallow + 同一 EMPTY_RUNS 引用 → 不应触发新 re-render
    expect(renders.length).toBe(initialRenderCount)

    // 用同样的 ids 再 rerender 一次 —— React 父强制 re-render，hook 内
    // selector 仍命中 EMPTY_RUNS 单例
    rerender(<TestComp ids={ids} />)
    // 父强制 re-render 必然算一次，但 hook 返回值身份应仍稳定
    const last = renders[renders.length - 1]
    const prev = renders[renders.length - 2]
    expect(last.runs).toBe(prev.runs)
  })

  it('从 "无匹配" 切到 "有匹配" → 返回新引用 + 触发 re-render', () => {
    let lastRuns: SubagentRun[] = []
    const renders: number[] = []
    function TestComp() {
      const renderCountRef = useRef(0)
      renderCountRef.current += 1
      const runs = useSubagentRuns(SESSION_ID, ['r1'])
      lastRuns = runs
      renders.push(renderCountRef.current)
      return null
    }
    render(<TestComp />)
    expect(lastRuns).toEqual([])
    const initial = renders.length

    act(() => {
      useChatRuntimeStore.setState({
        subagentRunsBySessionId: {
          [SESSION_ID]: [makeRun({ subagentRunId: 'r1', stepCount: 2 })],
        },
      })
    })
    expect(renders.length).toBeGreaterThan(initial)
    expect(lastRuns).toHaveLength(1)
    expect(lastRuns[0].subagentRunId).toBe('r1')
  })
})

describe('useSubagentRuns — tool_call_id 派发边 + FIFO', () => {
  it('parentToolCallId 反查限定在派发 owner 内', () => {
    const mainChild = makeRun({ subagentRunId: 'main', parentToolCallId: 'agent_0', dispatchedByRunId: '' })
    const nestedChild = makeRun({
      subagentRunId: 'nested',
      parentToolCallId: 'agent_0',
      dispatchedByRunId: 'leader-a',
    })
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { [SESSION_ID]: [mainChild, nestedChild] },
    })
    const { result: mainResult } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['agent_0'], ''),
    )
    expect(mainResult.current[0]?.subagentRunId).toBe('main')

    const { result: nestedResult } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['agent_0'], 'leader-a'),
    )
    expect(nestedResult.current.map(r => r.subagentRunId)).toEqual(['nested'])
  })

  it('同一 parentToolCallId FIFO 配对', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [SESSION_ID]: [
          makeRun({ subagentRunId: 'r1', parentToolCallId: 'agent_0' }),
          makeRun({ subagentRunId: 'r2', parentToolCallId: 'agent_0' }),
        ],
      },
    })
    const { result } = renderHook(() =>
      useSubagentRuns(SESSION_ID, ['agent_0', 'agent_0'], ''),
    )
    expect(result.current.map(r => r.subagentRunId)).toEqual(['r1', 'r2'])
  })
})
