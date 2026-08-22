import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { useTrackerAutomationNavStore } from './trackerDetailNavigation'

const {
  dialogState,
  eventStreamHandlers,
  spaceStoreState,
  patchTaskFromWS,
  removeTaskFromWS,
  setDialogState,
  loadTasks,
} = vi.hoisted(() => ({
  dialogState: {
    open: false,
    createSpaceId: undefined as string | undefined,
    editTask: undefined as unknown,
  },
  eventStreamHandlers: {
    bySpace: new Map<string, {
      spaceId?: string | null
      onTrackerCreated?: (payload: { tracker_id?: string }) => void
      onTrackerUpdated?: (payload: { tracker_id?: string }) => void
      onTrackerDeleted?: (payload: { tracker_id?: string }) => void
      onRunCompleted?: (payload: { tracker_id?: string }) => void
      onRunFailed?: (payload: { tracker_id?: string }) => void
      onReconnected?: () => void
    }>(),
  },
  spaceStoreState: {
    spaces: [
      { id: 'space-1', name: '当前工作空间', organization_id: 'org-1', type: 'workspace', is_archived: false },
      { id: 'space-2', name: '设计工作空间', organization_id: 'org-1', type: 'workspace', is_archived: false },
      { id: 'space-archived', name: '归档工作空间', organization_id: 'org-1', type: 'workspace', is_archived: true },
      { id: 'team-space', name: '团队 Space', organization_id: 'org-1', type: 'team_space', is_archived: false },
      { id: 'other-org-space', name: '其它组织工作空间', organization_id: 'org-2', type: 'workspace', is_archived: false },
    ],
  },
  patchTaskFromWS: vi.fn(),
  removeTaskFromWS: vi.fn(),
  setDialogState: vi.fn(),
  loadTasks: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      return opts?.defaultValue ?? key.split('.').pop() ?? key
    },
  }),
}))

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'org-1',
}))

vi.mock('@/hooks/useTrackerEventStream', () => ({
  useTrackerEventStream: (handlers: {
    spaceId?: string | null
    onTrackerCreated?: (payload: { tracker_id?: string }) => void
    onTrackerUpdated?: (payload: { tracker_id?: string }) => void
    onTrackerDeleted?: (payload: { tracker_id?: string }) => void
    onRunCompleted?: (payload: { tracker_id?: string }) => void
    onRunFailed?: (payload: { tracker_id?: string }) => void
    onReconnected?: () => void
  }) => {
    if (handlers.spaceId) eventStreamHandlers.bySpace.set(handlers.spaceId, handlers)
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (sel: (s: unknown) => unknown) => sel(spaceStoreState),
}))

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({
      dialogState,
      setDialogState,
    }),
    {
      getState: () => ({
        loadTasks,
        patchTaskFromWS,
        removeTaskFromWS,
      }),
    },
  ),
}))

vi.mock('./trackerScope', () => ({
  getTrackerTaskSpaceId: (taskSpaceId: string | null | undefined, fallback: string) =>
    taskSpaceId || fallback,
}))

vi.mock('../context-space/StandaloneModulePage', () => ({
  StandaloneModulePage: ({
    icon,
    title,
    actions,
    children,
  }: {
    icon: React.ReactNode
    title: React.ReactNode
    actions?: React.ReactNode
    children: React.ReactNode
  }) => (
    <div>
      <div data-testid="standalone-module-icon">{icon}</div>
      <h1>{title}</h1>
      {actions}
      {children}
    </div>
  ),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  PaneLoadingSkeleton: () => <div>loading</div>,
}))

vi.mock('./TrackerTaskList', () => ({
  TrackerTaskList: (props: {
    searchQuery?: string
    onOpenDetail?: (task: { id: string; name: string; space_id: string }) => void
  }) => (
    <div data-testid="tracker-task-list" data-search-query={props.searchQuery ?? ''}>
      <button
        type="button"
        data-testid="open-inline-from-list"
        onClick={() => props.onOpenDetail?.({
          id: 'task-inline',
          name: '页内任务',
          space_id: 'space-task',
        })}
      >
        open-inline-from-list
      </button>
    </div>
  ),
}))

vi.mock('./TrackerDetail', () => ({
  TrackerDetail: (props: {
    spaceId: string
    taskId: string
    onNavigateBack?: () => void
  }) => (
    <div
      data-testid="tracker-inline-detail"
      data-space-id={props.spaceId}
      data-task-id={props.taskId}
    >
      <button type="button" data-testid="inline-detail-back" onClick={() => props.onNavigateBack?.()}>
        back
      </button>
    </div>
  ),
}))

vi.mock('./CreateTrackerDialog', () => ({
  CreateTrackerDialog: ({
    open,
    initialValues,
  }: {
    open: boolean
    initialValues?: Record<string, unknown>
  }) => (
    open
      ? (
        <div
          data-testid="create-tracker-dialog"
          data-initial-values={JSON.stringify(initialValues ?? null)}
        />
        )
      : null
  ),
}))

import { TrackerPanel } from './TrackerPanel'

describe('TrackerPanel 自动化页壳 ', () => {
  beforeEach(() => {
    dialogState.open = false
    dialogState.createSpaceId = undefined
    dialogState.editTask = undefined
    eventStreamHandlers.bySpace.clear()
    useTrackerAutomationNavStore.setState({ seq: 0, detail: null })
    setDialogState.mockReset().mockImplementation(next => {
      Object.assign(dialogState, next)
    })
    loadTasks.mockReset()
    patchTaskFromWS.mockReset()
    removeTaskFromWS.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('标题为自动化，无顶部 tab，默认直接展示任务列表', async () => {
    render(<TrackerPanel spaceId="space-1" />)

    expect(screen.getByRole('heading', { name: '自动化' })).toBeTruthy()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByText('模板')).toBeNull()
    expect(screen.queryByText('触发任务')).toBeNull()
    expect(await screen.findByTestId('tracker-task-list')).toBeTruthy()
    expect(screen.queryByText('日历视图')).toBeNull()
    expect(screen.queryByRole('button', { name: /^周$/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^月$/ })).toBeNull()

    const moduleIcon = screen.getByTestId('standalone-module-icon').querySelector('svg')
    expect(moduleIcon?.getAttribute('class')).toContain('h-7')
    expect(moduleIcon?.getAttribute('class')).toContain('w-7')
  })

  it('主列表固定加载组织范围，不再提供工作空间范围下拉', async () => {
    render(<TrackerPanel spaceId="space-1" />)

    await screen.findByTestId('tracker-task-list')
    expect(loadTasks).toHaveBeenCalledWith('org-1', undefined)
    expect(screen.queryByTestId('select-scope-space-2')).toBeNull()
  })

  it('页头使用紧凑搜索和图标新建，搜索词传给列表', async () => {
    render(<TrackerPanel spaceId="space-1" />)

    const list = await screen.findByTestId('tracker-task-list')
    expect(screen.getByRole('button', { name: 'search' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'search' }))
    const searchInput = screen.getByRole('searchbox', { name: 'search' })
    fireEvent.change(searchInput, { target: { value: '日报' } })
    expect(list.getAttribute('data-search-query')).toBe('日报')

    fireEvent.click(screen.getByRole('button', { name: '关闭搜索' }))
    expect(list.getAttribute('data-search-query')).toBe('')
    expect(screen.queryByRole('searchbox')).toBeNull()
  })

  it('detailNavigation=inline 时点列表任务在页内打开详情', async () => {
    render(<TrackerPanel spaceId="space-1" detailNavigation="inline" />)
    await screen.findByTestId('tracker-task-list')

    fireEvent.click(screen.getByTestId('open-inline-from-list'))
    const detail = await screen.findByTestId('tracker-inline-detail')
    expect(detail.getAttribute('data-task-id')).toBe('task-inline')
    expect(detail.getAttribute('data-space-id')).toBe('space-task')
    expect(useTrackerAutomationNavStore.getState().detail?.taskId).toBe('task-inline')
  })

  it('默认 detailNavigation=tab（即使无 tabScopeKey）不启用页内详情', async () => {
    render(<TrackerPanel spaceId="space-1" />)

    fireEvent.click(screen.getByTestId('open-inline-from-list'))
    expect(screen.queryByTestId('tracker-inline-detail')).toBeNull()
    expect(screen.getByTestId('tracker-task-list')).toBeTruthy()
  })

  it('detailNavigation=tab 时不启用页内详情回调', async () => {
    render(<TrackerPanel spaceId="space-1" tabScopeKey="desktop:scope" detailNavigation="tab" />)

    fireEvent.click(screen.getByTestId('open-inline-from-list'))
    expect(screen.queryByTestId('tracker-inline-detail')).toBeNull()
    expect(screen.getByTestId('tracker-task-list')).toBeTruthy()
  })

  it('消费侧栏 automationNav：打开页内详情', async () => {
    useTrackerAutomationNavStore.setState({ seq: 0, detail: null })
    render(<TrackerPanel spaceId="space-1" detailNavigation="inline" />)

    await act(async () => {
      useTrackerAutomationNavStore.getState().openDetail({
        taskId: 'from-sidebar',
        spaceId: 'space-1',
        title: '侧栏任务',
      })
    })

    const detail = await screen.findByTestId('tracker-inline-detail')
    expect(detail.getAttribute('data-task-id')).toBe('from-sidebar')
  })

  it('组织范围订阅全部工作空间，局部订阅只处理运行终态与重连', () => {
    render(<TrackerPanel spaceId="space-1" />)
    expect([...eventStreamHandlers.bySpace.keys()].sort()).toEqual(['space-1', 'space-2'])
    expect(eventStreamHandlers.bySpace.get('space-1')?.onReconnected).toBeTypeOf('function')
    expect(eventStreamHandlers.bySpace.get('space-2')?.onReconnected).toBeUndefined()

    expect(eventStreamHandlers.bySpace.get('space-2')?.onTrackerUpdated).toBeUndefined()

    act(() => eventStreamHandlers.bySpace.get('space-2')?.onRunCompleted?.({ tracker_id: 'tk-2' }))
    expect(patchTaskFromWS).toHaveBeenCalledOnce()
    expect(patchTaskFromWS).toHaveBeenCalledWith('tk-2')

    const listLoadsBeforeReconnect = loadTasks.mock.calls.length
    act(() => eventStreamHandlers.bySpace.get('space-1')?.onReconnected?.())
    expect(loadTasks.mock.calls.length).toBeGreaterThan(listLoadsBeforeReconnect)
    expect(loadTasks).toHaveBeenLastCalledWith('org-1', undefined, undefined, { force: true })
  })

  it('CRUD 交给全局订阅，页面打开时不重复请求任务详情', () => {
    render(<TrackerPanel spaceId="space-1" />)

    expect(eventStreamHandlers.bySpace.get('space-1')?.onTrackerCreated).toBeUndefined()
    expect(eventStreamHandlers.bySpace.get('space-2')?.onTrackerUpdated).toBeUndefined()
    expect(eventStreamHandlers.bySpace.get('space-1')?.onTrackerDeleted).toBeUndefined()

    act(() => {
      eventStreamHandlers.bySpace.get('space-2')?.onRunFailed?.({ tracker_id: 'd' })
    })

    expect(patchTaskFromWS).toHaveBeenCalledOnce()
    expect(patchTaskFromWS).toHaveBeenLastCalledWith('d')
    expect(removeTaskFromWS).not.toHaveBeenCalled()
  })

  it.each(['team-space', 'space-archived', 'space-not-loaded'])(
    '组织范围不绕过有效工作空间筛选加入当前 Space：%s',
    currentSpaceId => {
      render(<TrackerPanel spaceId={currentSpaceId} />)

      expect([...eventStreamHandlers.bySpace.keys()].sort()).toEqual(['space-1', 'space-2'])
      expect(eventStreamHandlers.bySpace.get('space-1')?.onReconnected).toBeTypeOf('function')
      expect(eventStreamHandlers.bySpace.get('space-2')?.onReconnected).toBeUndefined()
      expect(eventStreamHandlers.bySpace.has(currentSpaceId)).toBe(false)
    },
  )

})
