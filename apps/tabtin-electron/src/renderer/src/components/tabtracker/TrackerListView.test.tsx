/**
 * Wave 5 (P1-8): TrackerListView smoke test — charter §3.2 三视图都必须存在,行为钉死。
 *
 * 波次 4 Stage 2.5 一刀切：原 TrackerAgendaView 已 rename 为 TrackerListView。
 *
 * 验证:
 *   1. 空 tasks 状态渲染 empty 提示
 *   2. 非空 tasks 渲染时间分组(today / tomorrow / thisWeek / later / noSchedule)
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import type { TrackerTask } from '@/services/trackerApi'

let mockTasks: TrackerTask[] = []
const openResourceTab = vi.fn()
const loadTasks = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | object) =>
      typeof fallback === 'string' ? fallback : (key.split('.').pop() ?? key),
  }),
}))

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({
      tasks: mockTasks,
      isLoading: false,
      loadError: false,
    }),
    { getState: () => ({ loadTasks }) },
  ),
}))

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'wt-1',
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (sel: (s: unknown) => unknown) => sel({ openResourceTab }),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => <div data-testid="skeleton" />,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Button: ({ children, ...rest }: React.ComponentProps<'button'>) => (
    <button {...rest}>{children}</button>
  ),
}))

import { TrackerListView } from './TrackerListView'

describe('TrackerListView', () => {
  beforeEach(() => {
    mockTasks = []
    openResourceTab.mockClear()
    loadTasks.mockClear()
  })

  it('空 tasks 渲染空提示(charter §3.2 时间分组列表视图必须支持空态)', () => {
    render(<TrackerListView spaceId="space-1" />)
    // 空态文案 / Calendar icon 都可识别
    const empty = screen.queryByText(/暂无|empty/i)
    expect(empty || screen.queryByTestId('agenda-empty')).toBeTruthy()
  })

  it('非空 tasks 渲染至少一个分组', () => {
    const today = new Date()
    today.setHours(today.getHours() + 1) // 1 小时后,落 today 组
    mockTasks = [
      {
        id: 't1',
        name: '今日 Tracker',
        description: '',
        status: 'active',
        trigger_type: 'cron',
        trigger_config: {},
        next_run_at: today.toISOString(),
        total_runs: 0,
        success_runs: 0,
        fail_runs: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as TrackerTask,
    ]
    render(<TrackerListView spaceId="space-1" />)
    expect(screen.getByText('今日 Tracker')).toBeTruthy()
  })

  it('点击任务时带 taskId 打开自动化详情', () => {
    const nextRun = new Date()
    nextRun.setHours(nextRun.getHours() + 1)
    mockTasks = [
      {
        id: 't1',
        name: '日报催办',
        description: '',
        status: 'active',
        trigger_type: 'cron',
        trigger_config: {},
        next_run_at: nextRun.toISOString(),
        total_runs: 0,
        success_runs: 0,
        fail_runs: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as TrackerTask,
    ]
    render(<TrackerListView spaceId="space-1" />)
    fireEvent.click(screen.getByText('日报催办'))
    expect(openResourceTab).toHaveBeenCalledWith('space-1', {
      type: 'tabtracker',
      id: 't1',
      title: '日报催办',
      meta: { spaceId: 'space-1', taskId: 't1' },
    })
  })
})
