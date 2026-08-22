/**
 * SubagentProgressCard.queued.test.tsx — queued 派发标记
 *
 * queued = 在等执行槽：Clock 静态；仍显示排队文案与等待说明。活跃进展的
 * ShinyText（图标不转圈）见 AggregateView  用例。无内联取消按钮。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const { speakerState } = vi.hoisted(() => ({
  speakerState: {
    speakersBySessionId: {} as Record<string, Record<string, unknown>>,
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
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

import { SubagentProgressCard } from '../SubagentProgressCard'

const SESSION_ID = 'session-w4-queued'
const RUN_ID = 'run-w4-queued-abc'

beforeEach(() => {
  speakerState.speakersBySessionId = {}
})

describe('SubagentProgressCard queued 静态标记', () => {
  it('queued 渲染任务名、排队状态和等待说明', () => {
    render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label="排队中的任务"
        task="完整排队任务 prompt 不应该作为标题"
        status="queued"
        stepCount={0}
        latestTool={undefined}
        elapsedMs={0}
      />,
    )
    expect(screen.getByText('排队中的任务')).toBeTruthy()
    expect(screen.getAllByText(/排队中/).length).toBeGreaterThan(0)
    expect(screen.getByText(/等待空闲执行槽/)).toBeTruthy()
    expect(screen.queryByText(/步/)).toBeNull()
  })

  it('queued 无内联取消按钮（取消入口在执行流 modal）', () => {
    render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label="可取消的排队任务"
        task="完整 prompt"
        status="queued"
        onCancel={vi.fn()}
      />,
    )
    expect(screen.queryByTitle('取消子任务')).toBeNull()
  })

  it('queued 字形静态不旋转（排队≠执行中）', () => {
    const { container } = render(
      <SubagentProgressCard
        subagentRunId={RUN_ID}
        sessionId={SESSION_ID}
        label="排队中"
        task="完整 prompt"
        status="queued"
      />,
    )
    expect(container.querySelector('.animate-spin')).toBeNull()
  })
})
