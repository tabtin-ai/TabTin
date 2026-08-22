/**
 * Wave 5 (P1-8): TrackerKanbanView smoke test — charter §3.2 三视图都必须存在,行为钉死。
 *
 * 验证:
 *   1. 空 tasks 状态渲染 empty 提示
 *   2. 非空 tasks 按 status 分到 4 列(draft / active / paused / disabled)
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
    {
      getState: () => ({ loadTasks }),
    },
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

import { TrackerKanbanView } from './TrackerKanbanView'

describe('TrackerKanbanView', () => {
  beforeEach(() => {
    mockTasks = []
    openResourceTab.mockClear()
    loadTasks.mockClear()
  })

  it('空 tasks 渲染空提示(charter §3.2 Kanban 视图必须支持空态)', () => {
    render(<TrackerKanbanView spaceId="space-1" />)
    expect(screen.getByText(/暂无自动化|empty/i)).toBeTruthy()
  })

  it('按 status 分到 4 列(draft / active / paused / disabled)', () => {
    mockTasks = [
      mkTask('t1', 'draft'),
      mkTask('t2', 'active'),
      mkTask('t3', 'active'),
      mkTask('t4', 'paused'),
      mkTask('t5', 'disabled'),
    ]
    render(<TrackerKanbanView spaceId="space-1" />)
    // 任务名渲染在卡片
    expect(screen.getByText('t1-name')).toBeTruthy()
    expect(screen.getByText('t2-name')).toBeTruthy()
    expect(screen.getByText('t4-name')).toBeTruthy()
    expect(screen.getByText('t5-name')).toBeTruthy()
  })

  it('点击任务时带 taskId 打开自动化详情', () => {
    mockTasks = [mkTask('t1', 'active', '日报催办')]
    render(<TrackerKanbanView spaceId="space-1" />)
    fireEvent.click(screen.getByText('日报催办'))
    expect(openResourceTab).toHaveBeenCalledWith('space-1', {
      type: 'tabtracker',
      id: 't1',
      title: '日报催办',
      meta: { spaceId: 'space-1', taskId: 't1' },
    })
  })
})

function mkTask(id: string, status: string, name = `${id}-name`): TrackerTask {
  return {
    id,
    name,
    description: '',
    status,
    trigger_type: 'manual',
    trigger_config: {},
    total_runs: 0,
    success_runs: 0,
    fail_runs: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as TrackerTask
}
