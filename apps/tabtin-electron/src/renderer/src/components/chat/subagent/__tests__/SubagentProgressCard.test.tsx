/**
 * SubagentProgressCard.test.tsx — 静态派发标记渲染回归（多 Agent UI 阶段 1）
 *
 * 2026-06-07 dogfood：卡片从极简「派发标记」回补用户判断需要的信息：
 * 标题、状态、模型、当前进展摘要。完整 transcript / 工具历史仍在执行流 modal。
 *
 * 本测试锁：
 *   - 5 种状态都渲染任务名 + 状态摘要
 *   - running 渲染模型、步数和当前工具摘要
 *   - 终态失败计数不再内联（去 modal）
 *   - SpeakerBadge 头部接入
 *
 * drill-in（点击 → 执行流 modal）见 SubagentProgressCard.drillInModal.test.tsx。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen } from '@testing-library/react'

// Hoist mock state 让多个 test 控制 speaker store 返回值
const { speakerState } = vi.hoisted(() => ({
  speakerState: {
    speakersBySessionId: {} as Record<string, Record<string, unknown>>,
  },
}))

// 覆盖 setup.ts 中"忽略 defaultValue"的 react-i18next mock——SubagentProgressCard
// 大量使用 `t(key, { defaultValue: '中文' })` 模式。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; count?: number }) => {
      if (key.startsWith('toolName.')) {
        const name = key.slice('toolName.'.length)
        if (name && name !== 'unknown') return name
      }
      let dv = opts?.defaultValue ?? key
      if (opts?.count !== undefined) dv = dv.replace(/\{\{count\}\}/g, String(opts.count))
      return dv
    },
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('@stores/useSpeakerRegistryStore', () => {
  const useStore = (selector: (state: typeof speakerState) => unknown) => selector(speakerState)
  return {
    useSpeakerRegistryStore: Object.assign(useStore, { getState: () => speakerState }),
  }
})

vi.mock('../../../../stores/useSpeakerRegistryStore', () => {
  const useStore = (selector: (state: typeof speakerState) => unknown) => selector(speakerState)
  return {
    useSpeakerRegistryStore: Object.assign(useStore, { getState: () => speakerState }),
  }
})

import { SubagentProgressCard } from '../SubagentProgressCard'

const SESSION_ID = 'session-w1-test'
const RUN_ID = 'run-w1-test-1234'

beforeEach(() => {
  speakerState.speakersBySessionId = {}
})

afterEach(() => {
  vi.useRealTimers()
})

// ─── 状态渲染矩阵：标题 + 进展摘要 ────────────────────────────────────

describe('SubagentProgressCard 静态派发标记渲染', () => {
  it.each([
    ['pending', '探索方案 A'],
    ['running', '跑工具'],
    ['queued', '排队中的任务'],
    ['completed', '完成的任务'],
    ['failed', '失败的任务'],
    ['cancelled', '取消的任务'],
  ] as const)('%s 状态：渲染任务名、状态摘要、无取消按钮', (status, taskName) => {
    render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label={taskName}
        task={`完整 prompt：${taskName}`}
        status={status}
      />,
    )
    expect(screen.getByText(taskName)).toBeTruthy()
    expect(screen.queryByText(/完整 prompt/)).toBeNull()
    expect(screen.getAllByText(/已派发|进行中|排队中|已完成|失败|已取消/).length).toBeGreaterThan(0)
    // 取消入口已搬去执行流 modal
    expect(screen.queryByTitle('取消子任务')).toBeNull()
  })

  it('running 渲染模型、步数和当前工具进展，进展 ShinyText、图标不转', () => {
    const { container } = render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label="跑工具"
        task="请完整读取文件并汇总输出"
        status="running"
        model="kimi-k2.6"
        stepCount={3}
        latestTool="read_file"
        latestToolInput="apps/tabtin-electron/package.json"
        latestSuccess
        elapsedMs={1200}
        onCancel={vi.fn()}
      />,
    )
    expect(screen.getByText('跑工具')).toBeTruthy()
    expect(screen.getByText(/kimi-k2\.6/)).toBeTruthy()
    expect(screen.getByText(/3 步/)).toBeTruthy()
    expect(screen.getByText(/read_file/)).toBeTruthy()
    expect(screen.getByText(/package\.json/)).toBeTruthy()
    expect(screen.getByText(/1 秒/)).toBeTruthy()
    expect(screen.queryByTitle('取消子任务')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(container.querySelector('[data-testid="shiny-text"]')).not.toBeNull()
  })

  it('running 时没有新 progress 事件也会本地持续计时，终态后冻结', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-17T08:00:00.000Z'))
    const startedAt = Date.now() - 1_200
    const { rerender } = render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label="长命令"
        status="running"
        latestTool="run_terminal_command"
        startedAt={startedAt}
        elapsedMs={1_200}
      />,
    )

    expect(screen.getByText(/1 秒/)).toBeTruthy()
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText(/3 秒/)).toBeTruthy()

    rerender(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label="长命令"
        status="completed"
        stats={{ duration_ms: 1_200 }}
        elapsedMs={1_200}
      />,
    )
    expect(screen.getByText(/1 秒/)).toBeTruthy()
    act(() => vi.advanceTimersByTime(2_000))
    expect(screen.getByText(/1 秒/)).toBeTruthy()
  })

  it('completed + toolHistory 含失败：不再内联「含 N 次失败」（去 modal）', () => {
    render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label="混合结果"
        task="完整 prompt 不应该作为标题"
        status="completed"
        toolHistory={[
          { tool_name: 'read_file', tool_call_id: 'tc1', success: true, elapsed_ms: 100 },
          { tool_name: 'grep_search', tool_call_id: 'tc2', success: false, elapsed_ms: 50, error: 'tool_timeout' },
        ]}
      />,
    )
    expect(screen.getByText('混合结果')).toBeTruthy()
    expect(screen.queryByText(/含.*次失败/)).toBeNull()
  })
})

// ─── SpeakerBadge 接入头部 ────────────────────────────────────────────

describe('SubagentProgressCard SpeakerBadge 头部', () => {
  it('speakerId 存在 + speaker 已注册 → 头部显示 SpeakerBadge', () => {
    speakerState.speakersBySessionId = {
      [SESSION_ID]: {
        'speaker-x': {
          speaker_id: 'speaker-x',
          kind: 'sub_agent',
          display_name: '数据分析员 · 4f2a',
          display_short_id: '4f2a',
          display_color: '#4f8aff',
          status: 'running',
        },
      },
    }

    render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        task="带 speaker"
        status="running"
        speakerId="speaker-x"
      />,
    )

    const badge = screen.getByTestId('speaker-badge')
    expect(badge.textContent).toContain('数据分析员')
  })

  it('speakerId 缺省 → SpeakerBadge 不渲染', () => {
    render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        task="无 speaker"
        status="running"
      />,
    )
    expect(screen.queryByTestId('speaker-badge')).toBeNull()
  })
})
