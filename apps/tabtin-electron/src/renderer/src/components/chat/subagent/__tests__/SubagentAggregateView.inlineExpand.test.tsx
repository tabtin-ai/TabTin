/**
 * SubagentAggregateView.inlineExpand.test.tsx — 点行就地展开执行流回归
 *
 * 取代旧 SubagentAggregateView.drillInModal.test.tsx（2026-06-07 交互改造）：
 * 聚合行点击从「拉起 app 级执行流 modal（useSubagentFlowModalStore.open）」改为
 * 「在该行正下方就地向下展开 SubagentDetailPane」，手风琴单选。
 *
 * 覆盖：
 *   1. 点行 → 行下方出现 inline 详情（带被点行 runId）+ 行 aria-expanded=true
 *   2. 再点同一行 → 收起（手风琴 toggle）
 *   3. 点另一行 → 互斥切换（前一个收起、只展开后点的）
 *   4. sessionId=null → 行不可展开（点击无详情）
 *   5. stop 按钮（DOM 存在、hover 显现）→ 调 cancelSubagentRun，不触发展开
 *   6. 终态行无 stop / 乐观占位行不可展开
 *   7. 阅读流条目（标题/模型/进展）渲染口径不变
 *   8. 活跃行：进展 ShinyText、图标不转圈
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'

const { speakerState } = vi.hoisted(() => ({
  speakerState: {
    speakersBySessionId: {} as Record<string, Record<string, unknown>>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number; duration?: string }) => {
      if (key.startsWith('toolName.')) {
        const name = key.slice('toolName.'.length)
        if (name && name !== 'unknown') return name
      }
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
  return {
    useSpeakerRegistryStore: Object.assign(useStore, {
      getState: () => speakerState,
    }),
  }
})
vi.mock('../../../../stores/useSpeakerRegistryStore', () => {
  const useStore = (selector: (state: typeof speakerState) => unknown) => selector(speakerState)
  return {
    useSpeakerRegistryStore: Object.assign(useStore, {
      getState: () => speakerState,
    }),
  }
})

// 就地展开后 SubagentAggregateView 直接渲染 SubagentDetailPane（重依赖一堆 store +
// MessageList）。本测只验「展开/收起契约」，把 Pane 换成轻量 stub，断言它收到正确
// 的 subagentRunId 即可——Pane 内部渲染由 SubagentDetailPane 自身测试覆盖。
vi.mock('../SubagentDetailPane', () => ({
  SubagentDetailPane: (props: { subagentRunId: string; compactHeader?: boolean }) => (
    <div data-testid="mock-detail-pane" data-run-id={props.subagentRunId} data-compact-header={props.compactHeader ? 'true' : 'false'}>
      detail
    </div>
  ),
}))

import { SubagentAggregateView } from '../SubagentAggregateView'
import { SubagentDisclosureProvider } from '../SubagentDisclosureContext'
import { SubagentStickyStackProvider } from '../SubagentStickyStackContext'
import { useChatRuntimeStore } from '@stores/useChatRuntimeStore'
import type { SubagentRun } from '../../../../stores/chat/shared/types'

function makeRun(overrides: Partial<SubagentRun> & { subagentRunId: string }): SubagentRun {
  return {
    status: 'running',
    label: 'work',
    task: 'do something',
    ...overrides,
  } as SubagentRun
}

function clickRow(container: HTMLElement, runId: string) {
  const row = container.querySelector(`[data-testid="subagent-inline-row-${runId}"]`)
  expect(row).not.toBeNull()
  fireEvent.click(row as Element)
}

function queryDetail(container: HTMLElement, runId: string) {
  return container.querySelector(`[data-testid="subagent-inline-detail-${runId}"]`)
}

beforeEach(() => {
  speakerState.speakersBySessionId = {}
  useChatRuntimeStore.setState({ subagentCancellingByRunId: {} } as never)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SubagentAggregateView 点行就地展开', () => {
  it('虚拟行卸载再挂载后保持展开，不随滚出视口自动折叠', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-persist',
        parentToolCallId: 'agent:0',
        status: 'running',
      }),
    ]
    const Harness = ({ visible }: { visible: boolean }) => (
      <SubagentDisclosureProvider>{visible && <SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />}</SubagentDisclosureProvider>
    )
    const { container, rerender } = render(<Harness visible />)

    clickRow(container, 'run-persist')
    expect(queryDetail(container, 'run-persist')).not.toBeNull()

    rerender(<Harness visible={false} />)
    expect(queryDetail(container, 'run-persist')).toBeNull()
    rerender(<Harness visible />)
    expect(queryDetail(container, 'run-persist')).not.toBeNull()
  })

  it('派发汇总使用静态机器人符号，不再切换成 Git 分叉符号', () => {
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'run-icon', status: 'completed' })]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)

    const header = container.querySelector('[data-testid="subagent-dispatch-header"]')
    expect(header?.querySelector('[data-testid="subagent-orchestration-icon"]')).not.toBeNull()
    expect(header?.querySelector('.lucide-bot')).not.toBeNull()
    expect(header?.querySelector('.lucide-git-branch')).toBeNull()
    expect(header?.querySelector('.animate-spin')).toBeNull()
  })

  it('点行 → 行下方展开 inline 详情（带被点行 runId）+ 行标记展开态', () => {
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'run-aaaa', status: 'running' })]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)

    // 初始未展开
    expect(queryDetail(container, 'run-aaaa')).toBeNull()

    clickRow(container, 'run-aaaa')

    const detail = queryDetail(container, 'run-aaaa')
    expect(detail).not.toBeNull()
    expect(detail!.className).toContain('min-h-0')
    expect(detail!.className).toContain('overflow-visible')
    expect(detail!.className).not.toContain('max-h-')
    const pane = detail!.querySelector('[data-testid="mock-detail-pane"]')
    expect(pane?.getAttribute('data-run-id')).toBe('run-aaaa')
    expect(pane?.getAttribute('data-compact-header')).toBe('true')

    const row = container.querySelector('[data-testid="subagent-inline-row-run-aaaa"]')
    expect(row?.getAttribute('aria-expanded')).toBe('true')
    expect(row?.getAttribute('data-subagent-expanded')).toBe('true')
    // ：根层 sticky 用 style.top=0（不再写死 top-0 class），供嵌套累加
    expect(row?.parentElement?.className).toContain('sticky')
    expect(row?.parentElement?.className).toContain('z-sticky')
    expect(row?.parentElement?.className).not.toContain('top-0')
    expect(row?.parentElement?.getAttribute('data-subagent-sticky-offset')).toBe('0')
    expect((row?.parentElement as HTMLElement | null)?.style.top).toBe('0px')
  })

  it('嵌套 Provider offset 时，展开行 sticky top 跟父 offset', () => {
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'run-nested', status: 'running' })]
    const { container } = render(
      <SubagentStickyStackProvider offsetPx={40}>
        <SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />
      </SubagentStickyStackProvider>,
    )

    clickRow(container, 'run-nested')
    const row = container.querySelector('[data-testid="subagent-inline-row-run-nested"]')
    expect(row?.parentElement?.getAttribute('data-subagent-sticky-offset')).toBe('40')
    expect((row?.parentElement as HTMLElement).style.top).toBe('40px')
  })

  it('再点同一行 → 收起（手风琴 toggle）', () => {
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'run-toggle', status: 'completed' })]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)

    clickRow(container, 'run-toggle')
    expect(queryDetail(container, 'run-toggle')).not.toBeNull()

    clickRow(container, 'run-toggle')
    expect(queryDetail(container, 'run-toggle')).toBeNull()
  })

  it('点另一行 → 互斥切换（前一个收起，只展开后点的）', () => {
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'sub-1', status: 'completed' }), makeRun({ subagentRunId: 'sub-2', status: 'completed' })]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={2} />)

    clickRow(container, 'sub-1')
    expect(queryDetail(container, 'sub-1')).not.toBeNull()
    expect(queryDetail(container, 'sub-2')).toBeNull()

    clickRow(container, 'sub-2')
    // 手风琴单选：sub-1 收起、sub-2 展开
    expect(queryDetail(container, 'sub-1')).toBeNull()
    expect(queryDetail(container, 'sub-2')).not.toBeNull()
  })

  it('sessionId=null → 行不可展开（点击无详情）', () => {
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'r-null', status: 'running' })]
    const { container } = render(<SubagentAggregateView sessionId={null} runs={runs} expectedCount={1} />)

    const row = container.querySelector('[data-testid="subagent-inline-row-r-null"]')
    // 不可展开：无 button role / aria-expanded
    expect(row?.getAttribute('aria-expanded')).toBeNull()

    clickRow(container, 'r-null')
    expect(queryDetail(container, 'r-null')).toBeNull()
  })

  it('活跃行的工作台、停止与展开操作成组同时显隐；点击停止不触发展开', () => {
    const cancelSpy = vi.fn().mockResolvedValue(undefined)
    useChatRuntimeStore.setState({
      cancelSubagentRun: cancelSpy,
      subagentCancellingByRunId: {},
      cancellingBySessionId: {},
    } as never)
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'run-live', status: 'running' })]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const stop = container.querySelector('[data-testid="subagent-inline-stop-run-live"]')
    const actions = container.querySelector('[data-testid="subagent-inline-actions-run-live"]')
    expect(actions).not.toBeNull()
    expect(stop?.parentElement).toBe(actions)
    expect(actions?.querySelector('.lucide-chevron-right')).not.toBeNull()
    expect(stop).not.toBeNull()
    expect(stop?.querySelector('.lucide-square')).not.toBeNull()
    expect(stop?.textContent).toBe('')
    expect(stop?.getAttribute('title')).toContain('制止子 Agent')
    // ：操作组静息隐身，hover / focus 时三个行尾操作一同显现。
    expect((actions as HTMLElement).className).toContain('opacity-0')
    expect((actions as HTMLElement).className).toContain('absolute')
    expect((actions as HTMLElement).className).toContain('pointer-events-none')
    expect((actions as HTMLElement).className).toContain('group-hover/row:pointer-events-auto')
    expect((actions as HTMLElement).className).toContain('group-hover/row:opacity-100')
    expect((actions as HTMLElement).className).toContain('focus-within:opacity-100')
    expect((stop as HTMLElement).className).not.toContain('opacity-0')
    fireEvent.click(stop as Element)
    expect(cancelSpy).toHaveBeenCalledWith('run-live')
    // stop 不冒泡到行级展开
    expect(queryDetail(container, 'run-live')).toBeNull()
  })

  it('终态行（completed）不显示 stop 按钮', () => {
    const runs: SubagentRun[] = [makeRun({ subagentRunId: 'run-done', status: 'completed' })]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    expect(container.querySelector('[data-testid="subagent-inline-stop-run-done"]')).toBeNull()
  })

  it('活跃行：进展 ShinyText、图标不转圈', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-shiny',
        status: 'running',
        label: '查竞品定价',
        stepCount: 1,
        latestTool: 'web_search',
      }),
    ]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const row = container.querySelector('[data-testid="subagent-inline-row-run-shiny"]')
    expect(row).not.toBeNull()
    expect(row!.querySelector('.animate-spin')).toBeNull()
    expect(row!.querySelector('[data-testid="shiny-text"]')).not.toBeNull()
    expect(row!.textContent).toContain('进行中')
    expect(row!.textContent).toContain('web_search')
  })

  it('多个子任务同时活跃时每一行都显示 ShinyText', () => {
    const { container } = render(
      <SubagentAggregateView
        sessionId="sess-1"
        runs={[
          makeRun({
            subagentRunId: 'run-shiny-1',
            parentToolCallId: 'toolu-1',
            status: 'running',
          }),
          makeRun({
            subagentRunId: 'run-shiny-2',
            parentToolCallId: 'toolu-2',
            status: 'running',
          }),
        ]}
        expectedCount={2}
      />,
    )

    const shinyTexts = container.querySelectorAll<HTMLElement>('[data-testid="shiny-text"]')
    expect(shinyTexts).toHaveLength(2)
    expect([...shinyTexts].every((node) => node.dataset.shinyActive === 'true')).toBe(true)
  })

  it('终态行：无旋转、无 ShinyText', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-static',
        status: 'completed',
        label: '已完成任务',
        summary: '写好了',
      }),
    ]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const row = container.querySelector('[data-testid="subagent-inline-row-run-static"]')
    expect(row).not.toBeNull()
    expect(row!.querySelector('.animate-spin')).toBeNull()
    expect(row!.querySelector('[data-testid="shiny-text"]')).toBeNull()
  })

  it('乐观占位行不可展开（子 session 未落盘）', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'agent:0',
        status: 'pending',
        isOptimistic: true,
      }),
    ]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const row = container.querySelector('[data-testid="subagent-inline-row-agent:0"]')
    expect(row?.getAttribute('aria-expanded')).toBeNull()
    clickRow(container, 'agent:0')
    expect(queryDetail(container, 'agent:0')).toBeNull()
  })
})

describe('SubagentAggregateView 阅读流条目', () => {
  it('标题优先使用派发时的 description/label，而不是完整 prompt/task', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-title',
        status: 'running',
        role: '内行星撰稿人',
        label: '撰写内行星科普文章',
        task: '请你作为内行星撰稿人，完整整理水星、金星、地球、火星的科普文章，要求覆盖大量背景和交付标准。',
      }),
    ]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const row = container.querySelector('[data-testid="subagent-inline-row-run-title"]') as HTMLElement
    expect(row).not.toBeNull()
    const text = row.textContent ?? ''
    expect(text).toContain('撰写内行星科普文章')
    expect(text).toContain('内行星撰稿人')
    expect(text).not.toContain('完整整理水星')
  })

  it('role 缺省 → 渲染 label，不硬凑「负责」连接词', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-norole',
        status: 'running',
        role: undefined,
        label: '撰写外行星科普文章',
      }),
    ]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const row = container.querySelector('[data-testid="subagent-inline-row-run-norole"]') as HTMLElement
    expect(row).not.toBeNull()
    const text = row.textContent ?? ''
    expect(text).toContain('撰写外行星科普文章')
    expect(text).not.toContain('负责')
  })

  it('渲染模型与当前进展', () => {
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-progress',
        status: 'running',
        role: '代码审查员',
        label: '检查卡片 UI',
        task: '检查子 Agent 卡片 UI 的完整实现细节',
        model: 'kimi-k2.6',
        stepCount: 2,
        latestTool: 'read_file',
        latestToolInput: 'SubagentAggregateView.tsx',
        elapsedMs: 2_000,
      }),
    ]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const row = container.querySelector('[data-testid="subagent-inline-row-run-progress"]') as HTMLElement
    expect(row).not.toBeNull()
    const text = row.textContent ?? ''
    expect(text).toContain('代码审查员')
    expect(text).toContain('kimi-k2.6')
    expect(text).toContain('2 步')
    expect(text).toContain('read_file')
    expect(text).toContain('SubagentAggregateView.tsx')
    expect(text).toContain('2 秒')
  })

  it('running 时没有新 progress 事件也会本地持续计时', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T08:00:00.000Z'))
    const runs: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-ticking',
        status: 'running',
        role: '命令执行员',
        label: '跑长命令',
        latestTool: 'run_terminal_command',
        startedAt: Date.now() - 2_000,
        elapsedMs: 2_000,
      }),
    ]
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={1} />)
    const row = container.querySelector('[data-testid="subagent-inline-row-run-ticking"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.textContent ?? '').toContain('2 秒')

    act(() => vi.advanceTimersByTime(2_000))
    expect(row.textContent ?? '').toContain('4 秒')
  })
})

describe('SubagentAggregateView 行入场动效', () => {
  beforeEach(() => {
    speakerState.speakersBySessionId = {}
    useChatRuntimeStore.setState({ subagentCancellingByRunId: {} } as never)
  })

  it('历史首屏行不带 enter；新增行标记 data-motion-enter + CSS 类', () => {
    const initial: SubagentRun[] = [
      makeRun({
        subagentRunId: 'run-hist',
        parentToolCallId: 'toolu_hist',
        status: 'completed',
      }),
    ]
    const { rerender, container } = render(<SubagentAggregateView sessionId="sess-1" runs={initial} expectedCount={1} />)

    const hist = container.querySelector('[data-testid="subagent-inline-row-run-hist"]') as HTMLElement
    expect(hist).not.toBeNull()
    expect(hist.getAttribute('data-motion-enter')).toBeNull()
    expect(hist.className).not.toContain('chat-motion-subagent-enter')

    const next: SubagentRun[] = [
      ...initial,
      makeRun({
        subagentRunId: 'run-new',
        parentToolCallId: 'toolu_new',
        status: 'running',
        label: '新派发',
      }),
    ]
    rerender(<SubagentAggregateView sessionId="sess-1" runs={next} expectedCount={2} />)

    const fresh = container.querySelector('[data-testid="subagent-inline-row-run-new"]') as HTMLElement
    expect(fresh).not.toBeNull()
    expect(fresh.getAttribute('data-motion-enter')).toBe('true')
    expect(fresh.className).toContain('chat-motion-subagent-enter')
    const meta = fresh.querySelector('.chat-motion-meta-enter')
    expect(meta).not.toBeNull()

    // 历史行仍不重播
    const histAgain = container.querySelector('[data-testid="subagent-inline-row-run-hist"]') as HTMLElement
    expect(histAgain.getAttribute('data-motion-enter')).toBeNull()
  })

  it('重新展开「剩余行」不重播入场（首屏已登记 seen）', () => {
    const runs: SubagentRun[] = Array.from({ length: 8 }, (_, i) =>
      makeRun({
        subagentRunId: `run-${i}`,
        parentToolCallId: `toolu_${i}`,
        status: 'completed',
        label: `任务 ${i}`,
      }),
    )
    const { container } = render(<SubagentAggregateView sessionId="sess-1" runs={runs} expectedCount={8} />)

    const toggle = container.querySelector('[data-testid="subagent-aggregate-rows-toggle"]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle as Element)

    const revealed = container.querySelector('[data-testid="subagent-inline-row-run-7"]') as HTMLElement
    expect(revealed).not.toBeNull()
    expect(revealed.getAttribute('data-motion-enter')).toBeNull()
    expect(revealed.className).not.toContain('chat-motion-subagent-enter')
  })

  it('连续新增两行时各自按 240ms 落定，后一次更新不取消前一行清理', () => {
    vi.useFakeTimers()
    try {
      const initial = [
        makeRun({
          subagentRunId: 'r0',
          parentToolCallId: 't0',
          status: 'completed',
        }),
      ]
      const { rerender, container } = render(<SubagentAggregateView sessionId="sess-1" runs={initial} expectedCount={1} />)

      rerender(
        <SubagentAggregateView
          sessionId="sess-1"
          runs={[
            ...initial,
            makeRun({
              subagentRunId: 'r1',
              parentToolCallId: 't1',
              status: 'running',
            }),
          ]}
          expectedCount={2}
        />,
      )
      act(() => vi.advanceTimersByTime(100))
      rerender(
        <SubagentAggregateView
          sessionId="sess-1"
          runs={[
            ...initial,
            makeRun({
              subagentRunId: 'r1',
              parentToolCallId: 't1',
              status: 'running',
            }),
            makeRun({
              subagentRunId: 'r2',
              parentToolCallId: 't2',
              status: 'running',
            }),
          ]}
          expectedCount={3}
        />,
      )

      act(() => vi.advanceTimersByTime(140))
      expect(container.querySelector('[data-testid="subagent-inline-row-r1"]')?.getAttribute('data-motion-enter')).toBeNull()
      expect(container.querySelector('[data-testid="subagent-inline-row-r2"]')?.getAttribute('data-motion-enter')).toBe('true')

      act(() => vi.advanceTimersByTime(100))
      expect(container.querySelector('[data-testid="subagent-inline-row-r2"]')?.getAttribute('data-motion-enter')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('活跃行进展仍只用 ShinyText，不因入场再加第二持续动效类', () => {
    const { rerender, container } = render(
      <SubagentAggregateView
        sessionId="sess-1"
        runs={[
          makeRun({
            subagentRunId: 'r0',
            parentToolCallId: 't0',
            status: 'running',
          }),
        ]}
        expectedCount={1}
      />,
    )
    rerender(
      <SubagentAggregateView
        sessionId="sess-1"
        runs={[
          makeRun({
            subagentRunId: 'r0',
            parentToolCallId: 't0',
            status: 'running',
          }),
          makeRun({
            subagentRunId: 'r1',
            parentToolCallId: 't1',
            status: 'running',
            label: '新',
          }),
        ]}
        expectedCount={2}
      />,
    )
    const row = container.querySelector('[data-testid="subagent-inline-row-r1"]') as HTMLElement
    expect(row.className).toContain('chat-motion-subagent-enter')
    // 入场类是一次性；不应出现第二个持续动画类（如 breathe / pulse）
    expect(row.className).not.toMatch(/animate-pulse|chat-motion-awaiting/)
  })
})
