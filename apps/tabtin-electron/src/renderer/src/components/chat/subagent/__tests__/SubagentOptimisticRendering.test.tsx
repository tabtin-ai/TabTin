/**
 * SubagentOptimisticRendering.test.tsx — 「连接中闪烁」根治回归（2026-05-29 dogfood）
 *
 * 背景：主 Agent 一次派 N 个子 Agent 时，聚合卡曾在窗口期（主流里 tool_use
 * (agent) 块已可见、但后端 SUBAGENT_STARTED relay 未回传）显示 N 行「连接中…」
 * 骨架，relay 回来后整行替换成真实行 → ~1s 闪烁。
 *
 * 根治方案：BlockTimeline 对反查不到的 toolCallId 用 tool_use(agent) 块本地合成
 * 乐观占位 run（带任务摘要），列表第一帧就齐全；行 key 绑 parentToolCallId 锚点，
 * SUBAGENT_STARTED 到达后真实 run 原地顶替不 remount。
 *
 * 2026-06-04 收敛：对话内派发标记改静态——乐观行不再显示「启动中」状态文字，
 * 也无逐行取消 / 「取消全部」（live 状态去 chip、取消走行内 stop）。本测因此改锁：
 *   A. 乐观行渲染**任务名**（非状态文字）、带 isOptimistic 标记、不可就地展开。
 *   B. BlockTimeline 端到端：store 空 → 渲染 N 行乐观（任务名可见，无「连接中」
 *      骨架）；SUBAGENT_STARTED 到达 → 同一行原地变真实 run，DOM 不 remount。
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'

const { speakerState, useSpaceIdForSessionMock, openSubagentTabMock } = vi.hoisted(() => ({
  speakerState: {
    speakersBySessionId: {} as Record<string, Record<string, unknown>>,
  },
  useSpaceIdForSessionMock: vi.fn().mockReturnValue('space-1'),
  openSubagentTabMock: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; duration?: string }) => {
      if (key.startsWith('toolName.')) {
        const name = key.slice('toolName.'.length)
        if (name && name !== 'unknown') return name
      }
      if (key === 'subagent.aggregate.connecting') return '连接中…'
      let dv = opts?.defaultValue ?? key
      if (opts?.count !== undefined) dv = dv.replace(/\{\{count\}\}/g, String(opts.count))
      if (opts?.duration !== undefined) dv = dv.replace(/\{\{duration\}\}/g, opts.duration)
      return dv
    },
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@stores/useSpeakerRegistryStore', () => {
  const useStore = (selector: (state: typeof speakerState) => unknown) => selector(speakerState)
  return { useSpeakerRegistryStore: Object.assign(useStore, { getState: () => speakerState }) }
})
vi.mock('../../../../stores/useSpeakerRegistryStore', () => {
  const useStore = (selector: (state: typeof speakerState) => unknown) => selector(speakerState)
  return { useSpeakerRegistryStore: Object.assign(useStore, { getState: () => speakerState }) }
})

// 就地展开后 SubagentAggregateView 会渲染 SubagentDetailPane（重依赖一堆 store +
// MessageList）。本测聚焦乐观补行 / 端到端不闪烁，把 Pane 换成轻量 stub。
vi.mock('../SubagentDetailPane', () => ({
  SubagentDetailPane: (props: { subagentRunId: string }) => (
    <div data-testid="mock-detail-pane" data-run-id={props.subagentRunId} />
  ),
}))

vi.mock('../../hooks/useSpaceIdForSession', () => ({
  useSpaceIdForSession: (sessionId: string | null) => useSpaceIdForSessionMock(sessionId),
}))

vi.mock('../openSubagentTab', () => ({
  openSubagentTab: openSubagentTabMock,
}))

import { SubagentAggregateView } from '../SubagentAggregateView'
import { BlockTimeline } from '../../blocks/BlockTimeline'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import type { SubagentRun } from '../../../../stores/chat/shared/types'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'

const SESSION_ID = 'sess-optimistic'

function makeRun(overrides: Partial<SubagentRun> & { subagentRunId: string }): SubagentRun {
  return { status: 'running', ...overrides } as SubagentRun
}

/** 构造一个 tool_use(agent) 的 ContentBlockEntry（block.id = 父 LLM tool_use.id）。 */
function makeAgentBlock(
  index: number,
  toolCallId: string,
  input?: Record<string, unknown>,
): ContentBlockEntry {
  return {
    index,
    block_id: toolCallId,
    block: {
      type: 'tool_use',
      id: toolCallId,
      name: 'agent',
      input: input ?? { prompt: '执行子任务' },
    },
    finalized: true,
    partial: false,
  } as unknown as ContentBlockEntry
}

beforeEach(() => {
  useSpaceIdForSessionMock.mockReset()
  useSpaceIdForSessionMock.mockReturnValue('space-1')
  openSubagentTabMock.mockClear()
  speakerState.speakersBySessionId = {}
  useChatRuntimeStore.setState({
    subagentRunsBySessionId: {},
    subagentCancellingByRunId: {},
  } as never)
})

describe('SubagentAggregateView — 乐观占位行 UI 契约（静态派发标记）', () => {
  it('isOptimistic 行显示任务名、带 optimistic 标记、不可就地展开、无「连接中」骨架', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'agent:0',
        parentToolCallId: 'agent:0',
        status: 'pending',
        isOptimistic: true,
        task: '回复数字 1',
      }),
    ]
    const { container, queryByText } = render(
      <SubagentAggregateView
        sessionId={SESSION_ID}
        runs={runs}
        onCancel={vi.fn()}
        expectedCount={1}
      />,
    )

    // 渲染任务名（非状态文字）
    expect(queryByText('回复数字 1')).not.toBeNull()
    expect(container.querySelector('[data-testid="subagent-skeleton-row"]')).toBeNull()

    // 乐观行标记位
    const row = container.querySelector('[data-testid="subagent-inline-row-agent:0"]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-subagent-optimistic')).toBe('true')

    // 点击不展开（乐观行子 session 还没落盘，不可展开）
    act(() => {
      ;(row as HTMLElement).click()
    })
    expect(container.querySelector('[data-testid="subagent-inline-detail-agent:0"]')).toBeNull()
  })

  it('真实 run（非乐观）可就地展开', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'real-uuid',
        parentToolCallId: 'agent:0',
        status: 'running',
        task: 'work',
      }),
    ]
    const { container } = render(
      <SubagentAggregateView
        sessionId={SESSION_ID}
        runs={runs}
        onCancel={vi.fn()}
        expectedCount={1}
      />,
    )
    const row = container.querySelector('[data-testid="subagent-inline-row-real-uuid"]')
    expect(row).not.toBeNull()
    expect(row?.getAttribute('data-subagent-optimistic')).toBeNull()
    act(() => {
      ;(row as HTMLElement).click()
    })
    const detail = container.querySelector('[data-testid="subagent-inline-detail-real-uuid"]')
    expect(detail).not.toBeNull()
    expect(
      detail!.querySelector('[data-testid="mock-detail-pane"]')?.getAttribute('data-run-id'),
    ).toBe('real-uuid')
  })

  it('收起态可直接在工作台打开，且不会同时展开行内详情', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'real-uuid',
        parentToolCallId: 'agent:0',
        status: 'running',
        role: '代码调研员',
        label: '调查相关代码路径',
        task: '查找实现入口',
      }),
    ]
    const { container } = render(
      <SubagentAggregateView sessionId={SESSION_ID} runs={runs} expectedCount={1} />,
    )

    const openButton = container.querySelector('[data-testid="subagent-inline-open-workbench-real-uuid"]')
    const stopButton = container.querySelector('[data-testid="subagent-inline-stop-real-uuid"]')
    const actions = container.querySelector('[data-testid="subagent-inline-actions-real-uuid"]')
    expect(openButton).not.toBeNull()
    expect(stopButton).not.toBeNull()
    expect(openButton?.parentElement).toBe(actions)
    expect(stopButton?.parentElement).toBe(actions)
    expect(actions?.querySelector('.lucide-chevron-right')).not.toBeNull()
    expect((actions as HTMLElement).className).toContain('opacity-0')
    expect((actions as HTMLElement).className).toContain('absolute')
    expect((actions as HTMLElement).className).toContain('pointer-events-none')
    expect((actions as HTMLElement).className).toContain('group-hover/row:pointer-events-auto')
    expect((actions as HTMLElement).className).toContain('group-hover/row:opacity-100')
    act(() => {
      ;(openButton as HTMLButtonElement).click()
    })

    expect(openSubagentTabMock).toHaveBeenCalledWith({
      parentSessionId: SESSION_ID,
      subagentRunId: 'real-uuid',
      spaceId: 'space-1',
      displayName: '代码调研员',
      label: '调查相关代码路径',
      task: '查找实现入口',
      parentToolCallId: 'agent:0',
      speakerId: undefined,
    })
    expect(container.querySelector('[data-testid="subagent-inline-detail-real-uuid"]')).toBeNull()
  })

  it('乐观占位与缺少工作区上下文时不显示工作台入口', () => {
    const optimisticRun = makeRun({
      subagentRunId: 'agent:0',
      status: 'pending',
      isOptimistic: true,
    })
    const { container, rerender } = render(
      <SubagentAggregateView sessionId={SESSION_ID} runs={[optimisticRun]} expectedCount={1} />,
    )
    expect(container.querySelector('[data-testid^="subagent-inline-open-workbench-"]')).toBeNull()

    useSpaceIdForSessionMock.mockReturnValue(null)
    rerender(
      <SubagentAggregateView
        sessionId={SESSION_ID}
        runs={[makeRun({ subagentRunId: 'real-uuid', status: 'completed' })]}
        expectedCount={1}
      />,
    )
    expect(container.querySelector('[data-testid^="subagent-inline-open-workbench-"]')).toBeNull()
  })

  it('派发标记头显示子任务数（派发了 N 个子任务）', () => {
    const runs: SubagentRun[] = [
      makeRun({ subagentRunId: 'agent:0', parentToolCallId: 'agent:0', status: 'pending', isOptimistic: true }),
      makeRun({ subagentRunId: 'agent:1', parentToolCallId: 'agent:1', status: 'pending', isOptimistic: true }),
    ]
    const { container } = render(
      <SubagentAggregateView sessionId={SESSION_ID} runs={runs} expectedCount={2} />,
    )
    const header = container.querySelector('[data-testid="subagent-dispatch-header"]')
    expect(header).not.toBeNull()
    expect(header?.textContent).toContain('2')
  })
})

describe('BlockTimeline — 窗口期乐观补行（端到端根治回归）', () => {
  it('store 空 + 2 个 agent 块 → 渲染 2 行乐观（任务名可见），无「连接中」骨架', () => {
    const blocks = [
      makeAgentBlock(0, 'agent:0', { prompt: '回复数字 1' }),
      makeAgentBlock(1, 'agent:1', { prompt: '回复数字 2' }),
    ]
    const { container, queryByText } = render(
      <BlockTimeline
        blocks={blocks}
        sessionId={SESSION_ID}
        messageId="msg-1"
        isLastAssistantMsg
        isStreaming
      />,
    )

    // 聚合卡渲染（≥2 个连续 subagent block）
    expect(container.querySelector('[data-testid="block-subagent-aggregate"]')).not.toBeNull()
    // 两行都是乐观占位（任务名可见）
    const rows = container.querySelectorAll('[data-subagent-optimistic="true"]')
    expect(rows.length).toBe(2)
    expect(queryByText('回复数字 1')).not.toBeNull()
    expect(queryByText('回复数字 2')).not.toBeNull()
    // 关键：没有「连接中…」骨架（旧实现窗口期会渲染这个）
    expect(queryByText('连接中…')).toBeNull()
    expect(container.querySelector('[data-testid="subagent-skeleton-row"]')).toBeNull()
  })

  it('SUBAGENT_STARTED 到达后：行原地变真实 run，DOM 节点不 remount（无闪烁）', () => {
    const blocks = [
      makeAgentBlock(0, 'agent:0', { prompt: '回复数字 1' }),
      makeAgentBlock(1, 'agent:1', { prompt: '回复数字 2' }),
    ]
    const { container, queryByText } = render(
      <BlockTimeline
        blocks={blocks}
        sessionId={SESSION_ID}
        messageId="msg-1"
        isLastAssistantMsg
        isStreaming
      />,
    )

    // 锚点 = parentToolCallId 'agent:0'；乐观阶段 inline-row testid 用占位
    // subagentRunId（= 'agent:0'）。记录 DOM 节点引用以验证不 remount。
    const optimisticRow = container.querySelector('[data-testid="subagent-inline-row-agent:0"]')
    expect(optimisticRow).not.toBeNull()
    expect(optimisticRow?.getAttribute('data-subagent-optimistic')).toBe('true')

    // 模拟后端 SUBAGENT_STARTED 到达：upsert 真实 run（subagentRunId=runtime UUID，
    // parentToolCallId=父 tool_use.id 'agent:0'）。
    act(() => {
      useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
        subagentRunId: 'runtime-uuid-0',
        parentToolCallId: 'agent:0',
        status: 'running',
        task: '回复数字 1',
      })
      useChatRuntimeStore.getState().upsertSubagentRunForSession(SESSION_ID, {
        subagentRunId: 'runtime-uuid-1',
        parentToolCallId: 'agent:1',
        status: 'running',
        task: '回复数字 2',
      })
    })

    // 真实 run 顶替后：testid 切到真实 subagentRunId，乐观标记消失，状态变进行中。
    const realRow = container.querySelector('[data-testid="subagent-inline-row-runtime-uuid-0"]')
    expect(realRow).not.toBeNull()
    expect(realRow?.getAttribute('data-subagent-optimistic')).toBeNull()
    expect(realRow?.getAttribute('data-subagent-status')).toBe('running')

    // 行 key 绑 parentToolCallId 锚点 → 顶替时复用同一 DOM 节点（不 remount）。
    expect(realRow).toBe(optimisticRow)

    // 「连接中」始终没出现过
    expect(queryByText('连接中…')).toBeNull()
  })

  it('非实时窗口（历史回看，isStreaming=false）store 空 → 不误显乐观行，走 skeleton 兜底', () => {
    const blocks = [
      makeAgentBlock(0, 'agent:0', { prompt: '历史任务 1' }),
      makeAgentBlock(1, 'agent:1', { prompt: '历史任务 2' }),
    ]
    const { container } = render(
      <BlockTimeline
        blocks={blocks}
        sessionId={SESSION_ID}
        messageId="msg-history"
        isLastAssistantMsg={false}
        isStreaming={false}
      />,
    )

    // 不应有任何乐观占位行
    expect(container.querySelectorAll('[data-subagent-optimistic="true"]').length).toBe(0)
    // 缺位交给 skeleton 兜底（头部计数仍为 2，列表 2 行 skeleton）
    expect(container.querySelectorAll('[data-testid="subagent-skeleton-row"]').length).toBe(2)
  })

  it('单个 agent 块非实时 store miss → 组件不再发起局部对账', () => {
    const reconcileSpy = vi
      .spyOn(useChatRuntimeStore.getState(), 'reconcileSubagentRunsFromArchive')
      .mockResolvedValue(undefined)
    const blocks = [
      makeAgentBlock(0, 'agent:0', { prompt: '历史单任务' }),
    ]

    render(
      <BlockTimeline
        blocks={blocks}
        sessionId={SESSION_ID}
        messageId="msg-single-history"
        isLastAssistantMsg={false}
        isStreaming={false}
      />,
    )

    expect(reconcileSpy).not.toHaveBeenCalled()
    reconcileSpy.mockRestore()
  })

  it('流式中但 block 未 finalize → 即使非 last message 也合成乐观（block 流式即实时窗口）', () => {
    const blocks = [
      { ...makeAgentBlock(0, 'agent:0', { prompt: 'x' }), finalized: false } as unknown as ContentBlockEntry,
      { ...makeAgentBlock(1, 'agent:1', { prompt: 'y' }), finalized: false } as unknown as ContentBlockEntry,
    ]
    const { container } = render(
      <BlockTimeline
        blocks={blocks}
        sessionId={SESSION_ID}
        messageId="msg-streaming"
        isLastAssistantMsg={false}
        isStreaming={false}
      />,
    )
    // block 未 finalize 本身即实时窗口 → 乐观占位
    expect(container.querySelectorAll('[data-subagent-optimistic="true"]').length).toBe(2)
  })
})
