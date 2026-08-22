import React from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import type { ChatSession } from '@tabtin/chat-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSidebarTrackersSection } from '../ChatSidebarTrackersSection'
import { SIDEBAR_MENU_TEXT, SIDEBAR_ROW_ACTIVE } from '@components/layout/sidebarUi'

const mocks = vi.hoisted(() => ({
  loadTrackerRunSessions: vi.fn(),
  onSelectRun: vi.fn(),
  openResourceTab: vi.fn(),
  openAutomationWorkbench: vi.fn(),
  setDialogState: vi.fn(),
  loadTasks: vi.fn(),
  onDeleteArchivedRuns: vi.fn(),
  // 可变态，单测里按场景改写
  chatState: {} as Record<string, unknown>,
  trackerState: {} as Record<string, unknown>,
  activePage: null as null | 'automation',
  automationDetailTaskId: null as string | null,
  selectedSpace: null as null | {
    id: string
    organization_id: string
    type?: string
    is_archived?: boolean
    name?: string
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOptions?: unknown) => {
      if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions
      if (
        defaultValueOrOptions
        && typeof defaultValueOrOptions === 'object'
        && typeof (defaultValueOrOptions as { defaultValue?: unknown }).defaultValue === 'string'
      ) {
        return (defaultValueOrOptions as { defaultValue: string }).defaultValue
      }
      return key
    },
  }),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.chatState),
    { getState: () => mocks.chatState },
  ),
}))

vi.mock('@/stores/useTrackerStore', () => ({
  useTrackerStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(mocks.trackerState),
    { getState: () => mocks.trackerState },
  ),
  useTrackerListState: () => ({
    tasks: (mocks.trackerState.tasks as unknown[]) ?? [],
  }),
}))

vi.mock('@components/tabtracker/trackerDetailNavigation', async () => {
  const actual = await vi.importActual<typeof import('@components/tabtracker/trackerDetailNavigation')>(
    '@components/tabtracker/trackerDetailNavigation',
  )
  return {
    ...actual,
    openAutomationWorkbench: mocks.openAutomationWorkbench,
    useTrackerAutomationNavStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
      detail: mocks.automationDetailTaskId
        ? { taskId: mocks.automationDetailTaskId, spaceId: 'space-1', title: '任务' }
        : null,
    }),
  }
})

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    activePage: mocks.activePage,
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      selectedSpace: mocks.selectedSpace,
      spaces: [
        {
          id: 'space-1',
          name: '默认工作空间',
          organization_id: 'wt-1',
          type: 'workspace',
          is_archived: false,
        },
      ],
    }),
}))

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'wt-1',
}))

vi.mock('@/i18n', () => ({
  default: { language: 'zh-CN' },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ openResourceTab: mocks.openResourceTab }),
}))

vi.mock('@/services/trackerApi', () => ({
  getDisplayableNextRunAt: () => null,
}))

vi.mock('@utils/localStorageMigration', () => ({
  migrateLegacyLocalStorageKey: vi.fn(),
}))

const SPACE_ID = 'space-1'

function makeRun(over: Record<string, unknown>): ChatSession {
  return {
    id: 'run',
    title: 'Run',
    status: 'active',
    organization_id: 'wt-1',
    space_id: SPACE_ID,
    created_at: '2026-06-03T09:00:00.000Z',
    updated_at: '2026-06-03T09:00:00.000Z',
    ...over,
  } as unknown as ChatSession
}

const RUN_A1 = makeRun({
  id: 'run-a1',
  title: 'Run A1',
  created_at: '2026-06-03T09:00:00.000Z',
  tracker_run: {
    run_id: 'r-a1', run_index: 1, run_status: 'success',
    tracker_id: 't-A', tracker_name: 'Tracker A', tracker_origin: 'user_created',
    trigger_type: 'scheduled', trigger_context: {}, started_at: '2026-06-03T09:00:00.000Z',
  },
})
const RUN_A2 = makeRun({
  id: 'run-a2',
  title: 'Run A2',
  created_at: '2026-06-04T09:00:00.000Z',
  tracker_run: {
    run_id: 'r-a2', run_index: 2, run_status: 'failed',
    tracker_id: 't-A', tracker_name: 'Tracker A', tracker_origin: 'user_created',
    trigger_type: 'scheduled', trigger_context: {}, started_at: '2026-06-04T09:00:00.000Z',
  },
})
const RUN_B1 = makeRun({
  id: 'run-b1',
  title: 'Run B1',
  tracker_run: {
    run_id: 'r-b1', run_index: 1, run_status: 'running',
    tracker_id: 't-B', tracker_name: 'Tracker B', tracker_origin: 'user_created',
    trigger_type: 'scheduled', trigger_context: {},
  },
})

const RUN_DELETED = makeRun({
  id: 'run-deleted-1',
  title: 'Deleted Run',
  created_at: '2026-06-05T09:00:00.000Z',
  tracker_run: {
    run_id: 'r-deleted-1', run_index: 1, run_status: 'success',
    tracker_id: 't-deleted', tracker_name: '已删除的日报任务', tracker_origin: 'user_created',
    trigger_type: 'manual', tracker_trigger_type: 'cron', trigger_context: {},
    started_at: '2026-06-05T09:00:00.000Z',
  },
})

const RUN_DELETED_MANUAL_TASK = makeRun({
  id: 'run-deleted-manual-1',
  title: 'Deleted Manual Run',
  tracker_run: {
    run_id: 'r-deleted-manual-1', run_index: 1, run_status: 'success',
    tracker_id: 't-deleted-manual', tracker_name: '已删除的手动任务', tracker_origin: 'user_created',
    trigger_type: 'scheduled', tracker_trigger_type: 'manual', trigger_context: {},
  },
})

const TASKS = [
  { id: 't-A', name: 'Tracker A', status: 'active', trigger_type: 'cron' },
  { id: 't-B', name: 'Tracker B', status: 'paused', trigger_type: 'interval' },
  { id: 't-manual', name: '手动任务', status: 'active', trigger_type: 'manual' },
  { id: 't-webhook', name: '网络回调任务', status: 'active', trigger_type: 'webhook' },
  { id: 't-table', name: '表格事件任务', status: 'active', trigger_type: 'table_event' },
  { id: 't-extension', name: '扩展事件任务', status: 'active', trigger_type: 'extension_event' },
]

function setupState(over?: Partial<Record<string, unknown>>) {
  mocks.chatState = {
    // 故意乱序传入,验证组件按 run_index 倒序重排
    trackerRunSessionsBySpaceId: { [SPACE_ID]: [RUN_A1, RUN_A2, RUN_B1] },
    trackerRunLoadingBySpaceId: {},
    trackerRunErrorBySpaceId: {},
    trackerRunLoadedBySpaceId: { [SPACE_ID]: true },
    currentSessionId: null,
    currentSessionIdBySpaceId: {},
    loadTrackerRunSessions: mocks.loadTrackerRunSessions,
    ...over,
  }
  mocks.trackerState = {
    tasks: TASKS,
    setDialogState: mocks.setDialogState,
    loadTasks: mocks.loadTasks,
  }
}

function collapseTrackersSection() {
  fireEvent.click(screen.getByLabelText('收起自动化'))
}

describe('ChatSidebarTrackersSection — 三级展开', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.loadTrackerRunSessions.mockClear()
    mocks.onSelectRun.mockClear()
    mocks.openResourceTab.mockClear()
    mocks.openAutomationWorkbench.mockClear()
    mocks.setDialogState.mockClear()
    mocks.onDeleteArchivedRuns.mockClear()
    mocks.selectedSpace = null
    mocks.activePage = null
    mocks.automationDetailTaskId = null
    setupState()
  })

  it('分区默认展开，直接可见任务行', () => {
    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)

    expect(screen.getByLabelText('收起自动化')).toBeTruthy()
    expect(screen.getByTestId('chat-sidebar-tracker-detail-t-A')).toBeTruthy()
    expect(screen.queryByTestId('chat-sidebar-trackers-workspace-badge')).toBeNull()
    expect(screen.getByTestId('chat-sidebar-tracker-detail-t-manual').textContent)
      .toContain('手动任务')
    expect(screen.queryByText('网络回调任务')).toBeNull()
    expect(screen.queryByText('表格事件任务')).toBeNull()
    expect(screen.queryByText('扩展事件任务')).toBeNull()
  })

  it('收起后需手动展开才可见任务行', () => {
    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)
    collapseTrackersSection()

    expect(screen.getByLabelText('展开自动化')).toBeTruthy()
    expect(screen.queryByTestId('chat-sidebar-tracker-detail-t-A')).toBeNull()
  })

  it('展开分区后，展开 tracker 行触发懒加载且 run 按 run_index 倒序', () => {
    const { container } = render(
      <ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />,
    )

    // 任务行展开前看不到 run
    expect(container.querySelector('[data-testid="chat-sidebar-tracker-run-run-a1"]')).toBeNull()

    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-toggle-t-A'))

    expect(mocks.loadTrackerRunSessions).toHaveBeenCalledWith(SPACE_ID, 'wt-1')

    const runRows = Array.from(
      container.querySelectorAll('[data-testid^="chat-sidebar-tracker-run-"]'),
    ).map(el => el.getAttribute('data-testid'))
    // 只含 t-A 的 run，且第 2 次（failed）排在第 1 次（success）前面。
    expect(runRows).toEqual([
      'chat-sidebar-tracker-run-run-a2',
      'chat-sidebar-tracker-run-run-a1',
    ])
    expect(screen.getByTestId('chat-sidebar-tracker-run-run-a2').textContent).not.toContain('#2')
    // t-B 未展开,其 run 不出现
    expect(container.querySelector('[data-testid="chat-sidebar-tracker-run-run-b1"]')).toBeNull()
  })

  it('分组标题使用 WORKSPACE 同款 section header', () => {
    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)

    const sectionHeader = screen.getByText('自动化').closest('div')
    expect(sectionHeader).not.toBeNull()
    expect(sectionHeader?.className).toContain('mx-1.5')
    expect(sectionHeader?.className).toContain('px-1.5')
  })

  it('点击 run 行把所属 Workspace 与会话交给父级导航，不开资源 tab', () => {
    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)
    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-toggle-t-A'))

    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-run-run-a2'))
    expect(mocks.onSelectRun).toHaveBeenCalledWith(SPACE_ID, 'run-a2')
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
  })

  it('点击列表项主体进自动化页内详情,且不展开 run 列表', () => {
    const { container } = render(
      <ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />,
    )

    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-detail-t-A'))

    expect(mocks.openAutomationWorkbench).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't-A', spaceId: SPACE_ID }),
    )
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
    // 详情入口不应触发展开 / 懒加载
    expect(mocks.loadTrackerRunSessions).not.toHaveBeenCalled()
    expect(container.querySelector('[data-testid="chat-sidebar-tracker-run-run-a1"]')).toBeNull()
  })

  it('传入 tabScopeKey 时仍走自动化页内详情（不再写 Context Tab）', () => {
    const TAB_SCOPE = 'conversation:session-1'
    render(
      <ChatSidebarTrackersSection
        spaceId={SPACE_ID}
        onSelectRun={mocks.onSelectRun}
        tabScopeKey={TAB_SCOPE}
      />,
    )

    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-detail-t-A'))

    expect(mocks.openAutomationWorkbench).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 't-A', spaceId: SPACE_ID }),
    )
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
  })

  it('展开但该 tracker 无 run 时显示占位', () => {
    setupState({ trackerRunSessionsBySpaceId: { [SPACE_ID]: [RUN_A1, RUN_A2] } })
    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)

    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-toggle-t-B'))
    expect(screen.getByText('暂无执行记录')).toBeTruthy()
  })

  it('localStorage 已展开且未 loaded 时挂载即懒加载，不显示暂无', () => {
    localStorage.setItem(
      'tabtin:chat-sidebar:trackers-expanded:wt-1',
      JSON.stringify(['t-A']),
    )
    setupState({
      trackerRunSessionsBySpaceId: { [SPACE_ID]: [] },
      trackerRunLoadedBySpaceId: {},
      trackerRunLoadingBySpaceId: {},
      trackerRunErrorBySpaceId: {},
    })

    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)

    expect(mocks.loadTrackerRunSessions).toHaveBeenCalledWith(SPACE_ID, 'wt-1')
    expect(screen.getByText('加载执行记录…')).toBeTruthy()
    expect(screen.queryByText('暂无执行记录')).toBeNull()
  })

  it('未 loaded 且无 error 时展开行显示加载中而非暂无', () => {
    setupState({
      trackerRunSessionsBySpaceId: { [SPACE_ID]: [] },
      trackerRunLoadedBySpaceId: {},
      trackerRunLoadingBySpaceId: {},
      trackerRunErrorBySpaceId: {},
    })
    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)
    mocks.loadTrackerRunSessions.mockClear()

    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-toggle-t-A'))

    expect(screen.getByText('加载执行记录…')).toBeTruthy()
    expect(screen.queryByText('暂无执行记录')).toBeNull()
  })

  it('侧栏选中其它 Space 时，新建进自动化并带上该 Space 的创建 dialog', () => {
    mocks.selectedSpace = {
      id: 'space-ipdt4b',
      organization_id: 'wt-1',
      type: 'workspace',
      is_archived: false,
      name: 'Space-ipdt4b',
    }
    render(
      <ChatSidebarTrackersSection
        spaceId={SPACE_ID}
        onSelectRun={mocks.onSelectRun}
        tabScopeKey="desktop:scope"
      />,
    )

    fireEvent.click(screen.getByLabelText('+ 新建自动化任务'))

    expect(mocks.openAutomationWorkbench).toHaveBeenCalledWith()
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
    expect(mocks.setDialogState).toHaveBeenCalledWith({
      open: true,
      createSpaceId: 'space-ipdt4b',
    })
  })

  it('空态单行「创建首个自动化」进自动化主画布并打开创建 dialog', () => {
    mocks.trackerState.tasks = []
    mocks.chatState.trackerRunSessionsBySpaceId = { [SPACE_ID]: [] }
    render(
      <ChatSidebarTrackersSection
        spaceId={SPACE_ID}
        onSelectRun={mocks.onSelectRun}
        tabScopeKey="conversation:draft:space-1"
      />,
    )

    const createRow = screen.getByTestId('chat-sidebar-trackers-empty-create')
    expect(createRow.textContent).toContain('创建首个自动化')
    expect(screen.queryByTestId('chat-sidebar-trackers-empty-caption')).toBeNull()
    expect(createRow.className).toContain('py-1.5')
    expect(createRow.className).toContain(SIDEBAR_MENU_TEXT)
    fireEvent.click(createRow)

    expect(mocks.openAutomationWorkbench).toHaveBeenCalledWith()
    expect(mocks.openResourceTab).not.toHaveBeenCalled()
    expect(mocks.setDialogState).toHaveBeenCalledWith({
      open: true,
      createSpaceId: SPACE_ID,
    })
  })

  it('已删除的定时任务有历史 Run 时保留只读任务节点和 Run 入口', () => {
    setupState({
      trackerRunSessionsBySpaceId: {
        [SPACE_ID]: [RUN_A1, RUN_A2, RUN_B1, RUN_DELETED, RUN_DELETED_MANUAL_TASK],
      },
    })
    render(<ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />)

    expect(screen.getByTestId('chat-sidebar-tracker-archived-t-deleted').textContent)
      .toContain('已删除的日报任务')
    expect(screen.queryByTestId('chat-sidebar-tracker-detail-t-deleted')).toBeNull()
    expect(screen.getByTestId('chat-sidebar-tracker-archived-t-deleted-manual').textContent)
      .toContain('已删除的手动任务')

    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-toggle-t-deleted'))
    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-run-run-deleted-1'))
    expect(mocks.onSelectRun).toHaveBeenCalledWith(SPACE_ID, 'run-deleted-1')
  })

  it('已删除任务允许确认后永久删除全部历史 Run 对话', async () => {
    setupState({
      trackerRunSessionsBySpaceId: {
        [SPACE_ID]: [RUN_DELETED],
      },
    })
    render(
      <ChatSidebarTrackersSection
        spaceId={SPACE_ID}
        onSelectRun={mocks.onSelectRun}
        onDeleteArchivedRuns={mocks.onDeleteArchivedRuns}
      />,
    )

    fireEvent.click(screen.getByLabelText('删除历史记录'))
    expect(screen.getByText('删除自动化历史')).toBeTruthy()
    expect(screen.getByText('将永久删除该任务的全部执行记录和对应对话，无法恢复。')).toBeTruthy()

    await act(async () => {
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除历史记录' }))
    })

    await vi.waitFor(() => {
      expect(mocks.onDeleteArchivedRuns).toHaveBeenCalledWith(
        SPACE_ID,
        ['run-deleted-1'],
      )
    })
  })

  it('自动化详情打开时只高亮任务；返回列表后 Run 会话仍保留但不再视觉高亮', () => {
    mocks.activePage = 'automation'
    mocks.automationDetailTaskId = 't-A'
    setupState({ currentSessionId: 'run-a2' })
    const { rerender } = render(
      <ChatSidebarTrackersSection spaceId={SPACE_ID} onSelectRun={mocks.onSelectRun} />,
    )

    expect(screen.getByTestId('chat-sidebar-tracker-row-t-A').className).toContain(SIDEBAR_ROW_ACTIVE)
    fireEvent.click(screen.getByTestId('chat-sidebar-tracker-toggle-t-A'))
    expect(screen.getByTestId('chat-sidebar-tracker-run-run-a2').className).not.toContain(SIDEBAR_ROW_ACTIVE)

    mocks.automationDetailTaskId = null
    // React.memo 在 props 完全相同时会跳过 rerender；真实应用里 Zustand 状态变化会
    // 主动通知组件。这里改变无业务影响的 tabScopeKey，模拟一次真实 store 通知。
    rerender(
      <ChatSidebarTrackersSection
        spaceId={SPACE_ID}
        onSelectRun={mocks.onSelectRun}
        tabScopeKey="automation:list"
      />,
    )
    expect(screen.getByTestId('chat-sidebar-tracker-row-t-A').className).not.toContain(SIDEBAR_ROW_ACTIVE)
    expect(mocks.chatState.currentSessionId).toBe('run-a2')
  })

})
