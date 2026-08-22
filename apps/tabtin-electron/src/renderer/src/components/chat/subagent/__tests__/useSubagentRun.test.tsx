/**
 * useSubagentRun.test.tsx — W1 / D11 hook 回归
 *
 * 锁住：useSubagentRun 必须用 useShallow 比较——同字段值新对象引用不引发
 * re-render；任一字段变才 re-render。这是高频 SUBAGENT_PROGRESS 场景下
 * 不让 SubagentProgressCard 每帧重绘的关键。
 *
 * 测试策略：
 *   - 用真 zustand store（不 mock）做 set/upsert 操作
 *   - 监测 hook 返回值身份 / re-render 次数
 *   - 验证：同字段值 set 一遍 → 仍是同一引用（useShallow 命中）
 *           字段变化 → 新引用 + 触发 re-render
 */

import React, { useRef } from 'react'
import { describe, it, expect, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import { useSubagentRun } from '../useSubagentRun'

const SESSION_ID = 'session-hook-test'
const RUN_ID = 'run-hook-test-abc'

function TestComponent({ onRender }: { onRender: (value: unknown, renderCount: number) => void }) {
  const renderCountRef = useRef(0)
  renderCountRef.current += 1
  const run = useSubagentRun(SESSION_ID, RUN_ID)
  onRender(run, renderCountRef.current)
  return <div data-testid="hook-test" />
}

beforeEach(() => {
  // 清掉 store 之前测试残留的 subagent runs
  useChatRuntimeStore.setState({ subagentRunsBySessionId: {} })
})

describe('useSubagentRun', () => {
  it('sessionId / subagentRunId 缺省 → undefined', () => {
    let lastValue: unknown
    function NullSessionComp() {
      lastValue = useSubagentRun(null, RUN_ID)
      return null
    }
    render(<NullSessionComp />)
    expect(lastValue).toBeUndefined()
  })

  it('store 无对应 run → undefined', () => {
    let lastValue: unknown
    function EmptyComp() {
      lastValue = useSubagentRun(SESSION_ID, RUN_ID)
      return null
    }
    render(<EmptyComp />)
    expect(lastValue).toBeUndefined()
  })

  it('store 有 run → 返回完整对象', () => {
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: {
        [SESSION_ID]: [
          {
            subagentRunId: RUN_ID,
            status: 'running',
            stepCount: 3,
            latestTool: 'read_file',
            task: 'do something',
          },
        ],
      },
    })

    let lastValue: ReturnType<typeof useSubagentRun>
    function Comp() {
      lastValue = useSubagentRun(SESSION_ID, RUN_ID)
      return null
    }
    render(<Comp />)
    expect(lastValue?.subagentRunId).toBe(RUN_ID)
    expect(lastValue?.status).toBe('running')
    expect(lastValue?.stepCount).toBe(3)
    expect(lastValue?.latestTool).toBe('read_file')
  })

  it('useShallow：字段不变（新对象引用 same content）→ 不触发 re-render', () => {
    const initial = {
      subagentRunId: RUN_ID,
      status: 'running' as const,
      stepCount: 1,
      latestTool: 'read_file',
    }
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { [SESSION_ID]: [initial] },
    })

    const renders: Array<{ value: unknown; count: number }> = []
    render(<TestComponent onRender={(v, c) => renders.push({ value: v, count: c })} />)

    const initialRenders = renders.length

    // 触发 store update：新数组 + 新对象，但字段内容完全相同
    act(() => {
      useChatRuntimeStore.setState({
        subagentRunsBySessionId: {
          [SESSION_ID]: [{ ...initial }],
        },
      })
    })

    // useShallow 应该判定"字段相同"，跳过 re-render
    expect(renders.length).toBe(initialRenders)
  })

  it('字段变化（如 stepCount）→ 触发 re-render', () => {
    const initial = {
      subagentRunId: RUN_ID,
      status: 'running' as const,
      stepCount: 1,
      latestTool: 'read_file',
    }
    useChatRuntimeStore.setState({
      subagentRunsBySessionId: { [SESSION_ID]: [initial] },
    })

    const renders: Array<{ value: unknown; count: number }> = []
    render(<TestComponent onRender={(v, c) => renders.push({ value: v, count: c })} />)
    const initialRenders = renders.length

    // stepCount 变化
    act(() => {
      useChatRuntimeStore.setState({
        subagentRunsBySessionId: {
          [SESSION_ID]: [{ ...initial, stepCount: 2 }],
        },
      })
    })

    expect(renders.length).toBeGreaterThan(initialRenders)
    const lastRender = renders[renders.length - 1]
    expect((lastRender.value as { stepCount: number }).stepCount).toBe(2)
  })
})
