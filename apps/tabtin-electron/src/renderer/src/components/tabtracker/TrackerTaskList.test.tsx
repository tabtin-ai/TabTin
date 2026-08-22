import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { TrackerTask } from '@/services/trackerApi'

let mockTasks: TrackerTask[] = []
const loadTasks = vi.fn()
const loadMoreTasks = vi.fn()
const openResourceTab = vi.fn()
const setCurrentTab = vi.fn()
const closeAppPage = vi.fn()
const listAgents = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string | { defaultValue?: string }) => {
      if (typeof fallback === 'string') return fallback
      if (fallback?.defaultValue) {
        return Object.entries(fallback).reduce(
          (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
          fallback.defaultValue,
        )
      }
      return key.split('.').pop() ?? key
    },
  }),
}))

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerListState: () => ({
    tasks: mockTasks,
    isLoading: false,
    loadError: false,
    hasMore: false,
  }),
  useTrackerStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({}),
    { getState: () => ({ loadTasks, loadMoreTasks }) },
  ),
}))

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'org-1',
}))

vi.mock('@tabtin/app-shell', () => ({
  AgentApiService: {
    listAgents: (...args: unknown[]) => listAgents(...args),
  },
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: Object.assign(
    () => undefined,
    { getState: () => ({ openResourceTab }) },
  ),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  DetailedRowListSkeleton: () => <div data-testid="skeleton" />,
}))

vi.mock('@components/ui', () => {
  const passthrough = (tag: string) =>
    ({ children, ...rest }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement(tag, rest, children as React.ReactNode)
  return {
    ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
      <div className={className}>{children}</div>
    ),
    Button: ({ children, ...rest }: React.ComponentProps<'button'>) => (
      <button {...rest}>{children}</button>
    ),
    Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectTrigger: passthrough('div'),
    SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
    SelectContent: passthrough('div'),
    SelectItem: ({ children, value }: { children: React.ReactNode; value?: string }) => (
      <div role="option" data-value={value}>{children}</div>
    ),
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    DropdownMenuContent: passthrough('div'),
    DropdownMenuItem: ({
      children,
      onSelect,
      ...rest
    }: React.PropsWithChildren<{ onSelect?: () => void } & Record<string, unknown>>) => (
      <button type="button" onClick={() => onSelect?.()} {...rest}>
        {children}
      </button>
    ),
  }
})

vi.mock('../context-space/ContextPageToolbar', () => ({
  ContextPageToolbar: ({ actions, searchPlaceholder, searchValue, onSearchChange }: {
    actions?: React.ReactNode
    searchPlaceholder?: string
    searchValue?: string
    onSearchChange?: (value: string) => void
  }) => (
    <div data-testid="tracker-toolbar">
      {actions}
      <input
        aria-label={searchPlaceholder}
        value={searchValue}
        onChange={event => onSearchChange?.(event.target.value)}
      />
    </div>
  ),
}))

vi.mock('./TrackerTaskRowActions', () => ({
  TrackerTaskRowActions: () => <button type="button" aria-label="row actions" />,
}))

vi.mock('@/services/trackerApi', () => ({
  getDisplayableNextRunAt: (task: TrackerTask) => task.next_run_at ?? null,
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: () => 'desktop:foreground-scope',
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({ setCurrentTab }),
  },
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({ closeAppPage }),
  },
}))

import { TrackerTaskList } from './TrackerTaskList'

describe('TrackerTaskList', () => {
  beforeEach(() => {
    mockTasks = []
    loadTasks.mockClear()
    loadMoreTasks.mockClear()
    openResourceTab.mockClear()
    setCurrentTab.mockClear()
    closeAppPage.mockClear()
    listAgents.mockReset().mockImplementation(() => new Promise(() => {}))
  })

  it('无 onOpenDetail 时点击任务行：切回 Agent 工作台再 openResourceTab', () => {
    mockTasks = [mkTask('t-test', 'test')]

    render(<TrackerTaskList spaceId="space-default" />)

    fireEvent.click(screen.getByText('test'))

    expect(closeAppPage).toHaveBeenCalledOnce()
    expect(setCurrentTab).toHaveBeenCalledWith('agent')
    expect(openResourceTab).toHaveBeenCalledWith(
      'desktop:foreground-scope',
      expect.objectContaining({
        type: 'tabtracker',
        id: 't-test',
        meta: expect.objectContaining({
          spaceId: 'space-alpha',
          taskId: 't-test',
        }),
      }),
    )
    expect(closeAppPage.mock.invocationCallOrder[0])
      .toBeLessThan(setCurrentTab.mock.invocationCallOrder[0])
    expect(setCurrentTab.mock.invocationCallOrder[0])
      .toBeLessThan(openResourceTab.mock.invocationCallOrder[0])
  })

  it('有 onOpenDetail 时点击任务行走页内回调，不切主导航', () => {
    mockTasks = [mkTask('t-test', 'test')]
    const onOpenDetail = vi.fn()

    render(<TrackerTaskList spaceId="space-default" onOpenDetail={onOpenDetail} />)

    fireEvent.click(screen.getByText('test'))

    expect(onOpenDetail).toHaveBeenCalledWith(expect.objectContaining({ id: 't-test' }))
    expect(setCurrentTab).not.toHaveBeenCalled()
    expect(openResourceTab).not.toHaveBeenCalled()
  })

  it('使用白底描边分区卡片展示名称、工作空间、指令、计划、状态与 Agent', async () => {
    const longName = '每天同步全部客户成功跟进任务并生成一份非常长的晨会提醒'
    mockTasks = [mkTask('t1', longName, { status: 'draft', agent_id: 'agent-1' })]
    listAgents.mockResolvedValue([{ id: 'agent-1', name: '计划执行助手' }])

    render(<TrackerTaskList spaceId="space-current" />)

    const root = screen.getByTestId('tracker-task-list-root')
    expect(root.className).toContain('flex')
    expect(screen.queryByTestId('tracker-task-table-header')).toBeNull()
    const content = screen.getByTestId('tracker-task-list-content')
    expect(content.className).toContain('w-full')
    expect(content.className).not.toContain('max-w-6xl')
    const list = screen.getByRole('list')
    expect(list.className).toContain('grid')
    expect(list.className).toContain('grid-cols-[repeat(auto-fill,minmax(min(480px,100%),1fr))]')

    const row = screen.getByTestId('tracker-task-row-t1')
    expect(row.tagName.toLowerCase()).toBe('article')
    expect(row.className).toContain('rounded-[10px]')
    expect(row.className).toContain('border')
    expect(row.className).toContain('bg-background')
    expect(row.querySelector('button')?.className).toContain('pt-3')
    expect(row.querySelector('button')?.className).toContain('pb-2.5')

    const name = screen.getByText(longName)
    expect(name.className).toContain('truncate')
    expect(screen.getByText('Space Alpha')).toBeTruthy()
    expect(screen.getByText('整理今天所有要跟进的客户成功事项')).toBeTruthy()
    expect(screen.getByText('paused')).toBeTruthy()
    expect(await screen.findByText('计划执行助手')).toBeTruthy()
  })

  it('Agent 名称加载完成前不闪现“Agent 不可用”', async () => {
    mockTasks = [mkTask('t-agent-loading', '等待 Agent 名称', { agent_id: 'agent-1' })]
    let resolveAgents: ((agents: Array<{ id: string; name: string }>) => void) | undefined
    listAgents.mockImplementation(() => new Promise(resolve => {
      resolveAgents = resolve
    }))

    render(<TrackerTaskList spaceId="space-current" />)

    expect(screen.queryByText('agentUnavailable')).toBeNull()
    expect(screen.getByTestId('tracker-agent-label-loading-t-agent-loading')).toBeTruthy()

    await act(async () => {
      resolveAgents?.([{ id: 'agent-1', name: '计划执行助手' }])
    })
    expect(screen.queryByTestId('tracker-agent-label-loading-t-agent-loading')).toBeNull()
    expect(screen.getByText('计划执行助手')).toBeTruthy()
  })

  it('暂停任务仍展示可理解的执行时间，不暴露 cron 技术提示', () => {
    mockTasks = [mkTask('daily-paused', '每日资讯', {
      status: 'paused',
      trigger_config: { cron_expression: '0 9 * * *' },
      next_run_at: null,
    })]

    render(<TrackerTaskList spaceId="space-alpha" />)

    expect(screen.getByText('每天 09:00 自动执行一次')).toBeTruthy()
    expect(screen.queryByText(/cron/i)).toBeNull()
  })

  it('定时一次任务直接展示明确的执行时间', () => {
    mockTasks = [mkTask('at-once', '发布提醒', {
      trigger_type: 'at',
      trigger_config: { at: '2026-08-15T01:30:00.000Z' },
      next_run_at: null,
    })]

    render(<TrackerTaskList spaceId="space-alpha" />)

    expect(screen.getByText(/^2026-08-15 \d{2}:30 执行一次$/)).toBeTruthy()
    expect(screen.queryByText('noNextRun')).toBeNull()
  })

  it('展示手动和定时任务，隐藏事件触发任务', () => {
    mockTasks = [
      mkTask('cron', '每天汇总', { trigger_type: 'cron' }),
      mkTask('interval', '每两小时检查', { trigger_type: 'interval' }),
      mkTask('at', '发布提醒', { trigger_type: 'at' }),
      mkTask('manual', '手动任务', { trigger_type: 'manual' }),
      mkTask('webhook', '网络回调任务', { trigger_type: 'webhook' }),
      mkTask('table', '表格事件任务', { trigger_type: 'table_event' }),
      mkTask('extension', '扩展事件任务', { trigger_type: 'extension_event' }),
    ]

    render(<TrackerTaskList spaceId="space-alpha" />)

    expect(screen.getByText('每天汇总')).toBeTruthy()
    expect(screen.getByText('每两小时检查')).toBeTruthy()
    expect(screen.getByText('发布提醒')).toBeTruthy()
    expect(screen.getByText('手动任务')).toBeTruthy()
    expect(screen.queryByText('网络回调任务')).toBeNull()
    expect(screen.queryByText('表格事件任务')).toBeNull()
    expect(screen.queryByText('扩展事件任务')).toBeNull()
    expect(loadTasks).toHaveBeenCalledWith('org-1', undefined)
    expect(screen.queryByTestId('tracker-resource-scope-switcher')).toBeNull()
  })
})

function mkTask(id: string, name: string, overrides: Partial<TrackerTask> = {}): TrackerTask {
  return {
    id,
    name,
    description: '每天 09:00 输出摘要',
    status: 'active',
    trigger_type: 'cron',
    trigger_config: {},
    skill_key: '',
    skill_params: { instructions: '整理今天所有要跟进的客户成功事项' },
    space_id: 'space-alpha',
    space_name: 'Space Alpha',
    next_run_at: '2026-07-12T01:00:00.000Z',
    total_runs: 0,
    success_runs: 0,
    fail_runs: 0,
    created_at: '2026-07-11T00:00:00.000Z',
    updated_at: '2026-07-11T00:00:00.000Z',
    ...overrides,
  } as unknown as TrackerTask
}
