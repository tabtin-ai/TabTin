import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ChatSession } from '@tabtin/chat-client'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSessionSwitcher } from '../ChatSessionSwitcher'
import { useSpaceStore } from '@/stores/useSpaceStore'
import { useDeviceStore } from '@/stores/useDeviceStore'
import { useAppPageStore } from '@/stores/useAppPageStore'

const storeMocks = vi.hoisted(() => ({
  activateSpace: vi.fn(),
  activateForegroundSpace: vi.fn(),
  setDraftExecutionSpaceForWorkspace: vi.fn(),
  setWorkspaceListSortMode: vi.fn(),
  workspaceListSortMode: 'name' as 'name' | 'activity',
}))

const virtualizerMocks = vi.hoisted(() => ({
  scrollToIndex: vi.fn(),
}))

// 可按用例注入的 useChatStore 状态（pill 派生自这两份 HITL 卡片态）。
const chatStoreState = vi.hoisted(() => ({
  forkingSessionId: null as string | null,
  pendingApprovalBySessionId: {} as Record<string, unknown>,
  pendingAskUserBySessionId: {} as Record<string, unknown>,
  messagesBySessionId: {} as Record<string, Array<{
    id?: string
    role?: string
    content?: string
    metadata?: Record<string, unknown>
  }>>,
  setDraftExecutionSpaceForWorkspace: storeMocks.setDraftExecutionSpaceForWorkspace,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOptions?: unknown) => {
      if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions
      // i18next 风格的 ``t(key, { defaultValue })`` 也要回吐默认值,否则
      // 隐患 5 折叠分组的中文文案（自动化任务执行记录 / 加载失败 / 重试）断言抓不到。
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

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string | number }) => ({
    getTotalSize: () => count * 56,
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({
      index,
      key: getItemKey ? getItemKey(index) : `virtual-${index}`,
      start: index * 56,
    })),
    measure: vi.fn(),
    measureElement: vi.fn(),
    scrollToIndex: virtualizerMocks.scrollToIndex,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
  ConfirmDialog: () => null,
  ContextMenu: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div>{children}</div> : null),
  ContextMenuDivider: () => <hr />,
  ContextMenuItem: ({ label, onClick }: { label: string; onClick?: () => void }) => (
    <button onClick={onClick}>{label}</button>
  ),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
  }: {
    children: React.ReactNode
    onSelect?: () => void
    disabled?: boolean
  }) => (
    <button disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  toast: {
    success: vi.fn(),
  },
}))

vi.mock('@components/common/ListSkeletons', () => ({
  ChatHistorySkeleton: () => <div data-testid="chat-history-skeleton" />,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: typeof chatStoreState) => unknown) => selector(chatStoreState),
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: (selector: (state: { activateSpace: (spaceId: string) => boolean }) => unknown) =>
    selector({ activateSpace: storeMocks.activateSpace }),
}))

vi.mock('@/stores/useWorkbenchSceneStore', () => ({
  useWorkbenchSceneStore: (selector: (state: { activateForegroundSpace: (spaceId: string) => void }) => unknown) =>
    selector({ activateForegroundSpace: storeMocks.activateForegroundSpace }),
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (
    selector: (state: {
      workspaceListSortMode: 'name' | 'activity'
      setWorkspaceListSortMode: (mode: 'name' | 'activity') => void
    }) => unknown,
  ) =>
    selector({
      workspaceListSortMode: storeMocks.workspaceListSortMode,
      setWorkspaceListSortMode: storeMocks.setWorkspaceListSortMode,
    }),
}))

vi.mock('@/utils/chat-session-sort', () => ({
  useSortedSessions: (sessions: ChatSession[]) =>
    [...sessions].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
  sortSessionsByActivity: (sessions: ChatSession[]) =>
    [...sessions].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()),
  groupSessionsByTime: (sessions: ChatSession[]) => [{ key: 'today', sessions }],
  // Wave 5: Tracker Run 会话识别。隐患 5 / 方案 ① 走"父组件单独传 trackerRunSessions"
  // 路径,sessions prop 不再含 tracker。但保留 mock 为"按 session.tracker_run 字段判断"
  // 让测试可以构造老路径(sessions 里含 tracker)和新路径(trackerRunSessions prop)。
  isTrackerRunSession: (s: ChatSession & { tracker_run?: unknown }) => Boolean(s.tracker_run),
  getSessionActivityTs: (session: ChatSession) => new Date(session.updated_at).getTime(),
}))

vi.mock('../SessionStatusIcon', () => ({
  SessionStatusIcon: () => <span data-testid="session-status-icon" />,
}))

const baseSession = {
  id: 'session-1',
  title: '测试对话',
  created_at: '2026-04-03T10:00:00.000Z',
  updated_at: '2026-04-03T10:00:00.000Z',
  message_count: 1,
} as ChatSession

describe('ChatSessionSwitcher', () => {
  beforeEach(() => {
    if (!HTMLElement.prototype.scrollIntoView) {
      HTMLElement.prototype.scrollIntoView = vi.fn()
    }
    localStorage.clear()
    chatStoreState.forkingSessionId = null
    chatStoreState.pendingApprovalBySessionId = {}
    chatStoreState.pendingAskUserBySessionId = {}
    chatStoreState.messagesBySessionId = {}
    virtualizerMocks.scrollToIndex.mockReset()
    storeMocks.activateSpace.mockReset()
    storeMocks.activateForegroundSpace.mockReset()
    storeMocks.setDraftExecutionSpaceForWorkspace.mockReset()
    storeMocks.setWorkspaceListSortMode.mockReset()
    storeMocks.workspaceListSortMode = 'name'
    storeMocks.activateSpace.mockReturnValue(true)
    useSpaceStore.setState({ spaces: [], selectedSpace: null, agentCache: {} })
    useDeviceStore.setState({
      currentDevice: { id: 'device-local', name: 'Local Mac', status: 'online' } as NonNullable<ReturnType<typeof useDeviceStore.getState>['currentDevice']>,
      devices: [
        { id: 'device-local', name: 'Local Mac', status: 'online' },
        { id: 'device-remote', name: 'Remote Mac', status: 'offline' },
      ] as ReturnType<typeof useDeviceStore.getState>['devices'],
    })
    useAppPageStore.setState({ activePage: null, activeProjectId: null })
  })

  it('列表视图不会渲染嵌套 button，且操作按钮不会误触发行选择', () => {
    const onSelectSession = vi.fn()
    const onForkSession = vi.fn()
    const onDeleteSession = vi.fn()

    const { container } = render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={onSelectSession}
        onForkSession={onForkSession}
        onDeleteSession={onDeleteSession}
      />,
    )

    expect(container.querySelector('button button')).toBeNull()

    const row = screen.getByText('测试对话').closest('[role="button"]') as HTMLElement | null
    expect(row).not.toBeNull()
    expect(row?.tagName).toBe('DIV')

    fireEvent.click(screen.getByLabelText('session.forkSession'))
    expect(onForkSession).toHaveBeenCalledWith(baseSession.id)
    expect(onSelectSession).not.toHaveBeenCalled()

    fireEvent.click(row!)
    expect(onSelectSession).toHaveBeenCalledWith(baseSession.id)

    onSelectSession.mockClear()
    fireEvent.keyDown(row!, { key: 'Enter' })
    expect(onSelectSession).toHaveBeenCalledWith(baseSession.id)

    onSelectSession.mockClear()
    fireEvent.keyDown(row!, { key: ' ' })
    expect(onSelectSession).toHaveBeenCalledWith(baseSession.id)
  })

  it('列表滚动区只允许纵向滚动，避免侧栏出现横向滚动条', () => {
    const { container } = render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
      />,
    )

    const scrollContainer = container.querySelector('.overflow-y-auto')
    expect(scrollContainer).not.toBeNull()
    expect(scrollContainer?.classList.contains('overflow-x-hidden')).toBe(true)
    expect(scrollContainer?.classList.contains('min-w-0')).toBe(true)
  })

  it('会话有活跃审批/提问待答时渲染「待处理」pill', () => {
    chatStoreState.pendingApprovalBySessionId = { [baseSession.id]: { sessionId: baseSession.id } }

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.getByText('待处理')).toBeTruthy()
  })

  it('会话无活跃 HITL 卡片态时不渲染「待处理」pill', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
      />,
    )

    expect(screen.queryByText('待处理')).toBeNull()
  })

  it('列表视图在已有对话激活时仍显示新任务入口', () => {
    const onCreateSession = vi.fn()

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        onCreateSession={onCreateSession}
      />,
    )

    const newConversationButton = screen.getByRole('button', { name: '新任务' })
    fireEvent.click(newConversationButton)

    expect(onCreateSession).toHaveBeenCalledTimes(1)
  })

  it('顶部新任务入口旁展示当前选中工作空间名称', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[{ ...baseSession, space_id: 'space-alpha', message_count: 1 }]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        scopeKey="space-alpha"
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    expect(screen.getByTitle('新任务 · Alpha Agent')).toBeTruthy()
    expect(screen.getAllByText('Alpha Agent').length).toBeGreaterThan(0)
  })

  it('预建空会话被滤出列表后顶部仍保持选中态（直到发出消息）', () => {
    // 列表 sessions 已滤掉空会话；draftLookupSessions 仍含预建草稿，顶部须保持 active。
    const blankSession = {
      ...baseSession,
      id: 'blank-1',
      title: '',
      space_id: 'space-alpha',
      message_count: 0,
    } as ChatSession

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        draftLookupSessions={[blankSession]}
        currentSessionId={blankSession.id}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onCreateSessionInSpace={vi.fn()}
        scopeKey="space-alpha"
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const topEntry = screen.getByTitle('新任务 · Alpha Agent')
    expect(topEntry.getAttribute('aria-current')).toBe('page')
    expect(screen.getAllByTitle('新任务 · Alpha Agent')).toHaveLength(1)
  })

  it('当前已是空新任务时顶部入口为选中态，列表不露预建行，对应 Space 的 + 禁用', () => {
    const onCreateSession = vi.fn()
    const onCreateSessionInSpace = vi.fn()
    const blankSession = {
      ...baseSession,
      id: 'blank-1',
      title: '',
      space_id: 'space-alpha',
      message_count: 0,
    } as ChatSession

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[blankSession]}
        currentSessionId={blankSession.id}
        onSelectSession={vi.fn()}
        onCreateSession={onCreateSession}
        onCreateSessionInSpace={onCreateSessionInSpace}
        scopeKey="space-alpha"
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const topEntry = screen.getByTitle('新任务 · Alpha Agent')
    expect(topEntry.getAttribute('aria-current')).toBe('page')
    expect(screen.getAllByTitle('新任务 · Alpha Agent')).toHaveLength(1)
    fireEvent.click(topEntry)
    expect(onCreateSession).not.toHaveBeenCalled()

    const spaceCreate = screen.getByRole('button', { name: '当前已是新任务' })
    expect((spaceCreate as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(spaceCreate)
    expect(onCreateSessionInSpace).not.toHaveBeenCalled()
  })

  it('当前 Workspace 有导入档案时，即使处于空新任务也允许点击 Workspace + 创建任务', () => {
    const onCreateSessionInSpace = vi.fn()
    const blankSession = {
      ...baseSession,
      id: 'blank-1',
      title: '',
      space_id: 'space-alpha',
      message_count: 0,
    } as ChatSession

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[blankSession]}
        currentSessionId={blankSession.id}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onCreateSessionInSpace={onCreateSessionInSpace}
        scopeKey="space-alpha"
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
        externalArchivesBySpaceId={{
          'space-alpha': [{
            source: 'codex',
            sourceSessionId: 'mock-codex-import-1',
            title: '模拟导入任务',
            messageCount: 2,
            cwd: '/tmp/mock',
          }],
        }}
      />,
    )

    const spaceCreate = screen.getByRole('button', { name: '在此工作空间新建任务' })
    expect((spaceCreate as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(spaceCreate)
    expect(onCreateSessionInSpace).toHaveBeenCalledWith('space-alpha')
  })

  it('当前会话已注入外部历史消息时，即使计数还是 0，顶部新任务入口仍可创建', () => {
    const onCreateSession = vi.fn()
    const importedSession = {
      ...baseSession,
      id: 'imported-1',
      title: '[$skill-creator] 导入会话',
      space_id: 'space-alpha',
      message_count: 0,
    } as ChatSession
    chatStoreState.messagesBySessionId = {
      [importedSession.id]: [{
        id: 'ext-imported-1',
        role: 'user',
        content: '外部历史正文',
        metadata: { external_archive: true },
      }],
    }

    render(
      <ChatSessionSwitcher
        variant="tabs"
        sessions={[importedSession]}
        currentSessionId={importedSession.id}
        onSelectSession={vi.fn()}
        onCreateSession={onCreateSession}
        onDeleteSession={vi.fn()}
        scopeKey="space-alpha"
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const createButton = screen.getByRole('button', { name: '新建' })
    expect((createButton as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(createButton)
    expect(onCreateSession).toHaveBeenCalledTimes(1)
  })

  it('草稿态禁用对应 Space 的 +，其它 Space 的 + 仍可用', () => {
    const onCreateSessionInSpace = vi.fn()

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        showDraftSession
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onCreateSessionInSpace={onCreateSessionInSpace}
        scopeKey="space-alpha"
        draftBadgeSpaceId="space-alpha"
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'space-beta': 'Beta Agent',
        }}
      />,
    )

    const disabledCreate = screen.getByRole('button', { name: '当前已是新任务' })
    expect((disabledCreate as HTMLButtonElement).disabled).toBe(true)

    const otherCreate = screen.getByRole('button', { name: '在此工作空间新建任务' })
    expect((otherCreate as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(otherCreate)
    expect(onCreateSessionInSpace).toHaveBeenCalledWith('space-beta')
  })

  it('技能库/自动化全屏盖住时，工作空间旁 + 仍可点并回到新任务', () => {
    const onCreateSessionInSpace = vi.fn()
    useAppPageStore.setState({ activePage: 'automation', activeProjectId: null })

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        showDraftSession
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onCreateSessionInSpace={onCreateSessionInSpace}
        scopeKey="space-alpha"
        draftBadgeSpaceId="space-alpha"
        spaceNameById={{ 'space-alpha': '默认工作空间' }}
      />,
    )

    const spaceCreate = screen.getByRole('button', { name: '在此工作空间新建任务' })
    expect((spaceCreate as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(spaceCreate)
    expect(onCreateSessionInSpace).toHaveBeenCalledWith('space-alpha')
  })

  it('只为允许的工作空间行展示新任务入口', () => {
    const onCreateSessionInSpace = vi.fn()

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
        onCreateSessionInSpace={onCreateSessionInSpace}
        canCreateSessionInSpace={spaceId => spaceId === 'space-alpha'}
        scopeKey="space-alpha"
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'project-1': '发布 Project',
        }}
      />,
    )

    const createButtons = screen.getAllByRole('button', { name: '在此工作空间新建任务' })
    expect(createButtons).toHaveLength(1)
    fireEvent.click(createButtons[0])
    expect(onCreateSessionInSpace).toHaveBeenCalledWith('space-alpha')
  })

  it('草稿态的新任务入口展示当前 Space 名称', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        showDraftSession
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        scopeKey="space-alpha"
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    expect(screen.getByTitle('新任务 · Alpha Agent')).toBeTruthy()
    expect(screen.queryByText('草稿')).toBeNull()
  })

  it('草稿态的新任务入口优先展示执行 Space 名称', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        showDraftSession
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        scopeKey="space-alpha"
        draftBadgeSpaceId="space-beta"
        spaceNameById={{ 'space-alpha': 'Alpha Agent', 'space-beta': 'Beta Agent' }}
      />,
    )

    expect(screen.getByTitle('新任务 · Beta Agent')).toBeTruthy()
    expect(screen.queryByTitle('新任务 · Alpha Agent')).toBeNull()
  })

  it('草稿态：新任务由顶部入口承载选中态，不再注入 WORKSPACE 分区', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        showDraftSession
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        scopeKey="space-alpha"
        draftBadgeSpaceId="space-alpha"
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const draftEntry = screen.getByTitle('新任务 · Alpha Agent')
    expect(screen.getAllByTitle('新任务 · Alpha Agent')).toHaveLength(1)
    // 顶部入口在 WORKSPACE 分区标题之前。
    const sectionHeader = screen.getByText('Spaces')
    expect(
      draftEntry.compareDocumentPosition(sectionHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(draftEntry.getAttribute('aria-current')).toBe('page')
  })

  it('草稿态在 Space 列表未同步时回退到 selectedSpace 名称', () => {
    useSpaceStore.setState({
      spaces: [],
      selectedSpace: { id: 'space-alpha', name: 'Alpha Agent' } as NonNullable<ReturnType<typeof useSpaceStore.getState>['selectedSpace']>,
    })

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        showDraftSession
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        scopeKey="space-alpha"
      />,
    )

    expect(screen.getByTitle('新任务 · Alpha Agent')).toBeTruthy()
    expect(screen.queryByText('草稿')).toBeNull()
  })

  it('Space 分组标题在远程执行设备离线时展示离线标签', () => {
    useSpaceStore.setState({
      spaces: [{
        id: 'space-alpha',
        name: 'Alpha Agent',
        control_device_id: 'device-remote',
      }] as ReturnType<typeof useSpaceStore.getState>['spaces'],
    })

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[{
          ...baseSession,
          id: 'session-alpha',
          title: 'Alpha 对话',
          space_id: 'space-alpha',
        }]}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const tag = screen.getByTestId('execution-device-status-tag')
    expect(tag.textContent).toContain('远程')
    expect(tag.textContent).toContain('离线')
    expect(tag.getAttribute('data-tone')).toBe('remote')
    expect(tag.getAttribute('data-secondary-tone')).toBe('offline')
  })

  it('Space 分组标题在本机执行时不展示远程标签', () => {
    useSpaceStore.setState({
      spaces: [{
        id: 'space-alpha',
        name: 'Alpha Agent',
        control_device_id: 'device-local',
      }] as ReturnType<typeof useSpaceStore.getState>['spaces'],
    })

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[{
          ...baseSession,
          id: 'session-alpha',
          title: 'Alpha 对话',
          space_id: 'space-alpha',
        }]}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    expect(screen.queryByTestId('execution-device-status-tag')).toBeNull()
  })

  it('列表视图传入 spaceNameById 后按 Space 分组展示对话', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
        updated_at: '2026-04-03T11:00:00.000Z',
      },
      {
        ...baseSession,
        id: 'session-beta',
        title: 'Beta 对话',
        space_id: 'space-beta',
        updated_at: '2026-04-03T10:00:00.000Z',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'space-beta': 'Beta Agent',
        }}
      />,
    )

    expect(screen.getByText('Alpha Agent')).toBeTruthy()
    expect(screen.getByText('Beta Agent')).toBeTruthy()
    expect(screen.queryByText('今天')).toBeNull()
    expect(screen.getByText('Alpha 对话')).toBeTruthy()
    expect(screen.getByText('Beta 对话')).toBeTruthy()
  })

  it('当前对话所属 Space 分组标题显示选中态', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
        updated_at: '2026-04-03T11:00:00.000Z',
      },
      {
        ...baseSession,
        id: 'session-beta',
        title: 'Beta 对话',
        space_id: 'space-beta',
        updated_at: '2026-04-03T10:00:00.000Z',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-beta"
        onSelectSession={vi.fn()}
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'space-beta': 'Beta Agent',
        }}
      />,
    )

    const activeHeader = screen.getByText('Beta Agent').closest('[role="button"]') as HTMLElement | null
    const inactiveHeader = screen.getByText('Alpha Agent').closest('[role="button"]') as HTMLElement | null
    // 选中态改由 aria-current 语义标记表达：与会话行统一视觉后，Space 头不再加背景高亮，
    // 仅保留语义 active（无障碍）与 accent 图标。
    expect(activeHeader?.getAttribute('aria-current')).toBe('true')
    expect(inactiveHeader?.getAttribute('aria-current')).toBeNull()
  })

  it('点击 Space 分组标题只收起子任务，不切换工作空间', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const header = screen.getByText('Alpha Agent').closest('[role="button"]') as HTMLElement | null
    expect(header).not.toBeNull()
    expect(screen.getByText('Alpha 对话')).toBeTruthy()

    fireEvent.click(header!)

    expect(storeMocks.activateSpace).not.toHaveBeenCalled()
    expect(storeMocks.activateForegroundSpace).not.toHaveBeenCalled()
    expect(storeMocks.setDraftExecutionSpaceForWorkspace).not.toHaveBeenCalled()
    expect(screen.queryByText('Alpha 对话')).toBeNull()
  })

  it('Space 分组标题支持键盘收起', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const header = screen.getByText('Alpha Agent').closest('[role="button"]') as HTMLElement | null
    expect(header).not.toBeNull()

    fireEvent.keyDown(header!, { key: 'Enter' })

    expect(storeMocks.activateSpace).not.toHaveBeenCalled()
    expect(storeMocks.activateForegroundSpace).not.toHaveBeenCalled()
    expect(screen.queryByText('Alpha 对话')).toBeNull()
  })

  it('Space 分组内会话按最近活跃时间倒序展示（最新在上）', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-old',
        title: '初次问候',
        space_id: 'space-alpha',
        updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        ...baseSession,
        id: 'session-new',
        title: '新建文档与大纲撰写',
        space_id: 'space-alpha',
        updated_at: '2026-06-01T00:00:00.000Z',
      },
      {
        ...baseSession,
        id: 'session-mid',
        title: '问候与开场',
        space_id: 'space-alpha',
        updated_at: '2026-03-01T00:00:00.000Z',
      },
    ] as ChatSession[]

    const { container } = render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-new"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const text = container.textContent ?? ''
    const idxNew = text.indexOf('新建文档与大纲撰写')
    const idxMid = text.indexOf('问候与开场')
    const idxOld = text.indexOf('初次问候')
    expect(idxNew).toBeGreaterThanOrEqual(0)
    expect(idxMid).toBeGreaterThan(idxNew)
    expect(idxOld).toBeGreaterThan(idxMid)
  })

  it('Space 展开时直接显示全部对话，不渲染更多与收起入口', () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      ...baseSession,
      id: `session-${index + 1}`,
      title: `Alpha 对话 ${index + 1}`,
      space_id: 'space-alpha',
      updated_at: new Date(Date.UTC(2026, 3, 3, 14, 0, 0) - index * 60000).toISOString(),
    })) as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-1"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    expect(screen.getByText('Alpha 对话 1')).toBeTruthy()
    expect(screen.getByText('Alpha 对话 2')).toBeTruthy()
    expect(screen.getByText('Alpha 对话 3')).toBeTruthy()
    expect(screen.getByText('Alpha 对话 4')).toBeTruthy()
    expect(screen.getByText('Alpha 对话 25')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '更多' })).toBeNull()
    expect(screen.queryByRole('button', { name: '收起' })).toBeNull()
  })

  it('多个 Space 展开时分别直接显示全部对话', () => {
    const sessions = [
      ...Array.from({ length: 4 }, (_, index) => ({
        ...baseSession,
        id: `alpha-${index + 1}`,
        title: `Alpha 对话 ${index + 1}`,
        space_id: 'space-alpha',
        updated_at: `2026-04-03T1${4 - index}:00:00.000Z`,
      })),
      ...Array.from({ length: 4 }, (_, index) => ({
        ...baseSession,
        id: `beta-${index + 1}`,
        title: `Beta 对话 ${index + 1}`,
        space_id: 'space-beta',
        updated_at: `2026-04-03T0${8 - index}:00:00.000Z`,
      })),
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="alpha-1"
        onSelectSession={vi.fn()}
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'space-beta': 'Beta Agent',
        }}
      />,
    )

    expect(screen.getByText('Alpha 对话 4')).toBeTruthy()
    expect(screen.getByText('Beta 对话 4')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '更多' })).toBeNull()
    expect(screen.queryByRole('button', { name: '收起' })).toBeNull()
  })

  it('点击 Space 文件夹行直接收起并恢复子对话', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    const spaceTitle = screen.getByText('Alpha Agent')
    const spaceHeader = spaceTitle.closest('[role="button"]') as HTMLElement | null
    expect(spaceHeader).not.toBeNull()
    expect(screen.getByText('Alpha 对话')).toBeTruthy()

    fireEvent.click(spaceHeader!)

    expect(storeMocks.activateSpace).not.toHaveBeenCalled()
    expect(storeMocks.activateForegroundSpace).not.toHaveBeenCalled()
    expect(screen.queryByText('Alpha 对话')).toBeNull()

    fireEvent.click(spaceHeader!)
    expect(screen.getByText('Alpha 对话')).toBeTruthy()
  })

  it('列表视图按 Space 分组时展示没有对话的 Space', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'space-empty': 'Empty Agent',
        }}
      />,
    )

    // 空工作空间仍出现在分组树（组头 count=0）；不再注入「暂无任务」占位行，
    // 空白任务由顶部「新任务」入口承载。
    expect(screen.getByText('Alpha Agent')).toBeTruthy()
    expect(screen.getByText('Empty Agent')).toBeTruthy()
    expect(screen.queryByText('暂无任务')).toBeNull()
  })

  it('工作空间组头顺序跟随 spaceNameById 声明序，不随会话活跃度漂移', () => {
    const sessions = [
      {
        ...baseSession,
        id: 'session-beta',
        title: 'Beta 对话',
        space_id: 'space-beta',
        updated_at: '2026-07-11T18:00:00.000Z',
      },
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
        updated_at: '2026-07-10T10:00:00.000Z',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-beta"
        onSelectSession={vi.fn()}
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'space-beta': 'Beta Agent',
        }}
      />,
    )

    const alphaHeader = screen.getByText('Alpha Agent')
    const betaHeader = screen.getByText('Beta Agent')
    expect(
      alphaHeader.compareDocumentPosition(betaHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('按最近活跃排序时，组头优先跟随组内任务活跃时间', () => {
    storeMocks.workspaceListSortMode = 'activity'
    const sessions = [
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
        updated_at: '2026-07-10T10:00:00.000Z',
      },
      {
        ...baseSession,
        id: 'session-beta',
        title: 'Beta 对话',
        space_id: 'space-beta',
        updated_at: '2026-07-09T10:00:00.000Z',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{
          'space-alpha': 'Alpha Agent',
          'space-beta': 'Beta Agent',
        }}
        spaceLastActivityById={{
          'space-alpha': '2026-07-10T10:00:00.000Z',
          'space-beta': '2026-07-11T18:00:00.000Z',
        }}
      />,
    )

    const alphaHeader = screen.getByText('Alpha Agent')
    const betaHeader = screen.getByText('Beta Agent')
    expect(
      alphaHeader.compareDocumentPosition(betaHeader) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
  })

  it('展示排序控件时可切换按名称 / 按最近活跃', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
        showWorkspaceSortControl
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '工作空间排序' }))
    fireEvent.click(screen.getByRole('button', { name: /按最近活跃/ }))
    expect(storeMocks.setWorkspaceListSortMode).toHaveBeenCalledWith('activity')
  })

  it('列表视图可在 Space 分组标题末尾渲染创建 Space 入口', () => {
    const onCreateSpace = vi.fn()

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        spaceNameById={{ 'space-1': 'Alpha Agent' }}
        createSpaceAction={(
          <button type="button" onClick={onCreateSpace}>
            新建 Space
          </button>
        )}
      />,
    )

    expect(screen.getByText('Spaces')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '新建 Space' }))

    expect(onCreateSpace).toHaveBeenCalledTimes(1)
  })

  it('Space 分组设置按钮打开对应工作空间设置且不影响子对话展示', () => {
    const onOpenSpaceSettings = vi.fn()
    const sessions = [
      {
        ...baseSession,
        id: 'session-alpha',
        title: 'Alpha 对话',
        space_id: 'space-alpha',
      },
    ] as ChatSession[]

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={sessions}
        currentSessionId="session-alpha"
        onSelectSession={vi.fn()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
        onOpenSpaceSettings={onOpenSpaceSettings}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '工作空间设置' }))

    expect(onOpenSpaceSettings).toHaveBeenCalledWith('space-alpha')
    expect(screen.getByText('Alpha 对话')).toBeTruthy()
  })

  it('置顶状态切换时同 id 会话只渲染一次', () => {
    const duplicateNewer = {
      ...baseSession,
      id: 'session-duplicate',
      title: '重复对话（新）',
      space_id: 'space-alpha',
      updated_at: '2026-04-03T12:00:00.000Z',
    } as ChatSession
    const duplicateOlder = {
      ...duplicateNewer,
      title: '重复对话（旧）',
      updated_at: '2026-04-03T09:00:00.000Z',
    } as ChatSession
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { rerender } = render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[duplicateOlder, duplicateNewer]}
        currentSessionId="session-duplicate"
        onSelectSession={vi.fn()}
        pinnedSessionIds={new Set(['session-duplicate'])}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    expect(screen.getAllByText('重复对话（新）')).toHaveLength(1)
    expect(screen.queryByText('重复对话（旧）')).toBeNull()

    rerender(
      <ChatSessionSwitcher
        variant="list"
        sessions={[duplicateOlder, duplicateNewer]}
        currentSessionId="session-duplicate"
        onSelectSession={vi.fn()}
        pinnedSessionIds={new Set()}
        spaceNameById={{ 'space-alpha': 'Alpha Agent' }}
      />,
    )

    expect(screen.getAllByText('重复对话（新）')).toHaveLength(1)
    expect(screen.queryByText('重复对话（旧）')).toBeNull()
    expect(
      consoleErrorSpy.mock.calls.some(call =>
        String(call[0]).includes('Encountered two children with the same key'),
      ),
    ).toBe(false)

    consoleErrorSpy.mockRestore()
  })

  it('sessions 模式不渲染自动化任务执行记录分组', () => {
    const trackerSession = {
      ...baseSession,
      id: 'tracker-hidden',
      title: '[Tracker] 不应出现在主列表',
      tracker_run: { run_id: 'r-hidden' },
    } as ChatSession

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        trackerRunSessions={[trackerSession]}
        trackerRunCount={1}
        listContent="sessions"
      />,
    )

    expect(screen.queryByText('自动化任务执行记录')).toBeNull()
    expect(screen.getByText('测试对话')).toBeTruthy()
  })

  it('trackerRuns 模式只渲染自动化任务执行记录分组', () => {
    const onExpandTrackerRuns = vi.fn()
    const trackerSession = {
      ...baseSession,
      id: 'tracker-bottom',
      title: '[Tracker] 底部执行记录',
      tracker_run: { run_id: 'r-bottom' },
    } as ChatSession

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[]}
        currentSessionId={null}
        onSelectSession={vi.fn()}
        trackerRunSessions={[trackerSession]}
        trackerRunCount={1}
        onExpandTrackerRuns={onExpandTrackerRuns}
        listContent="trackerRuns"
      />,
    )

    expect(screen.getByText('自动化任务执行记录')).toBeTruthy()
    expect(screen.queryByText('新任务')).toBeNull()
    expect(screen.queryByText('暂无对话')).toBeNull()

    fireEvent.click(screen.getByText('自动化任务执行记录').closest('[role="button"]') as HTMLElement)
    expect(onExpandTrackerRuns).toHaveBeenCalledTimes(1)
  })

  // 隐患 5 / 方案 ①（charter v1.8 §6.7 主侧栏分桶）回归 ────────────────
  it('折叠分组「自动化任务执行记录」首次展开触发 onExpandTrackerRuns', () => {
    const onExpandTrackerRuns = vi.fn()
    const trackerSession = {
      ...baseSession,
      id: 'tracker-1',
      title: '[Tracker] 周报整理',
      tracker_run: { run_id: 'r1' },
    } as ChatSession

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        trackerRunSessions={[trackerSession]}
        trackerRunCount={1}
        onExpandTrackerRuns={onExpandTrackerRuns}
      />,
    )

    // 默认折叠状态:trackerRuns 分组 header 应当显示 count badge=1
    const header = screen.getByText('自动化任务执行记录').closest('[role="button"]') as HTMLElement
    expect(header).not.toBeNull()
    expect(header.textContent).toContain('1')

    // 折叠状态下点击 header → 展开 → 触发首次 fetch 回调
    act(() => {
      fireEvent.click(header)
    })
    expect(onExpandTrackerRuns).toHaveBeenCalledTimes(1)

    // 再次点击折叠回去,不应再触发(只在"折叠→展开"边沿触发)
    act(() => {
      fireEvent.click(header)
    })
    expect(onExpandTrackerRuns).toHaveBeenCalledTimes(1)
  })

  it('折叠分组展开时 loading=true 显示 spinner,error 显示 retry', () => {
    const onRetryTrackerRuns = vi.fn()
    // 用一个 tracker session 让分组显示
    const trackerSession = {
      ...baseSession,
      id: 'tracker-2',
      title: '[Tracker] xyz',
      tracker_run: { run_id: 'r2' },
    } as ChatSession

    // 先 loading
    const { rerender } = render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        trackerRunSessions={[trackerSession]}
        trackerRunCount={1}
        trackerRunsLoading={true}
      />,
    )
    // 默认是折叠的(localStorage 没设),先展开
    const header = screen.getByText('自动化任务执行记录').closest('[role="button"]') as HTMLElement
    act(() => {
      fireEvent.click(header)
    })
    expect(screen.getByText('正在加载自动化任务执行记录…')).toBeTruthy()

    // 切到 error 态
    rerender(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        trackerRunSessions={[trackerSession]}
        trackerRunCount={1}
        trackerRunsLoading={false}
        trackerRunsError="network down"
        onRetryTrackerRuns={onRetryTrackerRuns}
      />,
    )
    expect(screen.getByText('加载失败')).toBeTruthy()
    fireEvent.click(screen.getByText('重试'))
    expect(onRetryTrackerRuns).toHaveBeenCalledTimes(1)
  })

  it('右键菜单可以重命名对话', async () => {
    const onRenameSession = vi.fn().mockResolvedValue(undefined)

    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[baseSession]}
        currentSessionId={baseSession.id}
        onSelectSession={vi.fn()}
        onRenameSession={onRenameSession}
      />,
    )

    const row = screen.getByText('测试对话').closest('[role="button"]') as HTMLElement
    fireEvent.contextMenu(row, { clientX: 10, clientY: 10 })
    fireEvent.click(screen.getByText('重命名对话'))

    const input = screen.getByLabelText('对话名称') as HTMLInputElement
    expect(input.value).toBe('测试对话')

    fireEvent.change(input, { target: { value: '新的对话标题' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => {
      expect(onRenameSession).toHaveBeenCalledWith(baseSession.id, '新的对话标题')
    })
  })

  it('按原型把工作空间与 Project 分成两个任务树区段', () => {
    render(
      <ChatSessionSwitcher
        variant="list"
        sessions={[
          { ...baseSession, id: 'workspace-session', title: '工作空间任务', space_id: 'workspace-1' },
          { ...baseSession, id: 'project-session', title: '项目任务', space_id: 'project-1' },
        ] as ChatSession[]}
        currentSessionId="workspace-session"
        onSelectSession={vi.fn()}
        spaceNameById={{
          'workspace-1': '默认工作空间',
          'project-1': '投研 Project',
        }}
        spaceSectionKeyById={{
          'workspace-1': 'workspace',
          'project-1': 'project',
        }}
        spaceSectionOrder={['workspace', 'project']}
        spaceSectionTitleByKey={{
          workspace: '工作空间',
          project: 'Project',
        }}
        showWorkspaceSortControlBySectionKey={{
          workspace: true,
          project: false,
        }}
        createSpaceActionBySectionKey={{
          workspace: <button type="button">新建工作空间</button>,
          project: <button type="button">新建 Project</button>,
        }}
      />,
    )

    expect(screen.getByText('工作空间')).toBeTruthy()
    expect(screen.getByText('Project')).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建工作空间' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '新建 Project' })).toBeTruthy()
    expect(screen.getByText('工作空间任务')).toBeTruthy()
    expect(screen.getByText('项目任务')).toBeTruthy()
    expect(
      screen.getByText('工作空间任务').closest('[role="button"]')?.className,
    ).not.toContain('ml-6')

    const workspaceSectionToggle = screen.getByText('工作空间').closest('button')
    expect(workspaceSectionToggle?.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(workspaceSectionToggle as HTMLButtonElement)
    expect(screen.queryByText('默认工作空间')).toBeNull()
    expect(screen.queryByText('工作空间任务')).toBeNull()

    fireEvent.click(workspaceSectionToggle as HTMLButtonElement)
    const workspaceRow = screen.getByText('默认工作空间').closest('[role="button"]')
    const expandedFolder = workspaceRow?.querySelector('.lucide-folder-open')
    expect(expandedFolder).toBeTruthy()
    expect(expandedFolder?.className).not.toContain('text-accent')
    expect(workspaceRow?.querySelector('.lucide-folder')).toBeNull()
    expect(workspaceRow?.querySelector('.lucide-chevron-right')).toBeNull()
    expect(workspaceRow?.querySelector('.lucide-chevron-down')).toBeNull()
    fireEvent.click(workspaceRow as HTMLElement)
    expect(screen.getByText('默认工作空间')).toBeTruthy()
    expect(screen.queryByText('工作空间任务')).toBeNull()
    expect(workspaceRow?.querySelector('.lucide-folder')).toBeTruthy()
    expect(workspaceRow?.querySelector('.lucide-folder-open')).toBeNull()
  })
})
