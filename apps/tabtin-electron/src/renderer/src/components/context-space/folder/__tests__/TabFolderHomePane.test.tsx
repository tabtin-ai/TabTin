import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const openResourceTab = vi.hoisted(() => vi.fn())
const appendSessionAllowedPathMock = vi.hoisted(() => vi.fn().mockResolvedValue({ ok: true }))
const pathExistsMock = vi.hoisted(() => vi.fn().mockResolvedValue({ success: true, exists: true, isDirectory: true }))
const selectSpaceBySpaceId = vi.hoisted(() => vi.fn(() => true))
const onOpenAppHome = vi.hoisted(() => vi.fn())
const toastMock = vi.hoisted(() => vi.fn())
const closeTabMock = vi.hoisted(() => vi.fn())
const closePaneMock = vi.hoisted(() => vi.fn())
const findGroupByTabKeyMock = vi.hoisted(() => vi.fn())

const folderState = vi.hoisted(() => ({
  folders: {},
  userFolders: {
    'user::scope::ref': {
      rootPath: '/Users/me/reference',
      kind: 'user',
      title: 'reference',
      updatedAt: 1,
      refreshToken: 1,
      sourceKind: 'userFolder',
      scopeKey: 'tabfolder:organization:wt-1:user:user-1',
    },
  },
  getUserFolderIds: vi.fn(() => ['user::scope::ref']),
  addUserFolder: vi.fn(() => ({ folderId: 'user::scope::new', isNew: true })),
  findUserFolderByPath: vi.fn(() => null),
  removeUserFolder: vi.fn(),
  reconcileBoundDirs: vi.fn(),
}))

type Selector<State, Result> = (state: State) => Result

const spacesFixture = [
  { id: 'space-a', name: 'Agent A', type: 'workspace', organization_id: 'wt-1', agent_id: 'agent-a', control_device_id: 'device-local', working_dir: '/Users/me/a' },
  { id: 'space-b', name: 'Agent B', type: 'workspace', organization_id: 'wt-1', agent_id: 'agent-b', control_device_id: 'device-local', working_dir: '/Users/me/b' },
  { id: 'space-remote', name: 'Remote Space', type: 'workspace', organization_id: 'wt-1', agent_id: 'agent-remote', control_device_id: 'device-remote', working_dir: '/Users/me/remote' },
  { id: 'space-other', name: 'Other Team', type: 'workspace', organization_id: 'wt-2', agent_id: 'agent-other', control_device_id: 'device-local', working_dir: '/Users/me/other' },
]

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: <Result,>(selector: Selector<{ selectedOrganization: { id: string } }, Result>) =>
    selector({ selectedOrganization: { id: 'wt-1' } }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: <Result,>(selector: Selector<{ user: { id: string } }, Result>) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: <Result,>(selector: Selector<{
    spaces: typeof spacesFixture
    agentCache: Record<string, { working_dir: string }>
    selectedSpace: { id: string } | null
  }, Result>) => selector({
    spaces: spacesFixture,
    agentCache: {},
    selectedSpace: { id: 'space-a' },
  }),
}))

const deviceState = vi.hoisted(() => ({ currentDeviceId: 'device-local' as string | null }))

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: <Result,>(selector: Selector<{ currentDevice: { id: string } | null }, Result>) =>
    selector({ currentDevice: deviceState.currentDeviceId ? { id: deviceState.currentDeviceId } : null }),
}))

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({ selectSpaceBySpaceId }),
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab, closeTab: closeTabMock }),
  },
}))

vi.mock('@stores/useCanvasLayoutStore', () => ({
  useCanvasLayoutStore: {
    getState: () => ({
      findGroupByTabKey: findGroupByTabKeyMock,
      closePane: closePaneMock,
    }),
  },
}))

vi.mock('@components/context-space/SpaceContextAreaContext', () => ({
  useSpaceContextState: () => ({ tabScopeKey: 'desktop:wt-1:user-1' }),
  useSpaceContextActions: () => ({ onOpenAppHome }),
}))

vi.mock('../useFolderStore', () => ({
  useFolderContextStore: <Result,>(selector: Selector<typeof folderState, Result>) => selector(folderState),
}))

// 归一化 / canonical 用简化实现，避免测试依赖 window.tabtin.realpath
vi.mock('@utils/canonicalPath', () => {
  const normalize = (p?: string | null) =>
    (p ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return {
    normalizeComparableKey: normalize,
    canonicalizePath: async (p?: string | null) => normalize(p),
    resolveRealPath: async (p?: string | null) => p ?? '',
  }
})

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  toast: toastMock,
}))

import { TabFolderHomePane } from '../TabFolderHomePane'

describe('TabFolderHomePane', () => {
  beforeEach(() => {
    folderState.getUserFolderIds.mockReset()
    folderState.getUserFolderIds.mockImplementation(() => ['user::scope::ref'])
    folderState.addUserFolder.mockReset()
    folderState.addUserFolder.mockImplementation(() => ({ folderId: 'user::scope::new', isNew: true }))
    folderState.findUserFolderByPath.mockReset()
    folderState.findUserFolderByPath.mockImplementation(() => null)
    folderState.removeUserFolder.mockClear()
    folderState.reconcileBoundDirs.mockClear()
    deviceState.currentDeviceId = 'device-local'
    openResourceTab.mockClear()
    closeTabMock.mockClear()
    closePaneMock.mockClear()
    findGroupByTabKeyMock.mockReset()
    findGroupByTabKeyMock.mockReturnValue(null)
    selectSpaceBySpaceId.mockClear()
    onOpenAppHome.mockClear()
    toastMock.mockClear()
    appendSessionAllowedPathMock.mockReset()
    appendSessionAllowedPathMock.mockResolvedValue({ ok: true })
    pathExistsMock.mockReset()
    pathExistsMock.mockResolvedValue({ success: true, exists: true, isDirectory: true })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        getPlatform: () => 'darwin',
        workspace: {
          appendSessionAllowedPath: appendSessionAllowedPathMock,
        },
        fileSystem: {
          pathExists: pathExistsMock,
        },
      },
    })
  })

  it('shows the empty state when there are no bound or user directories', () => {
    // 设备未识别 → 无绑定目录；用户目录也为空 → 空态
    deviceState.currentDeviceId = null
    folderState.getUserFolderIds.mockImplementation(() => [])

    render(<TabFolderHomePane spaceId="space-a" />)

    expect(screen.getByText('folder.desktop.title')).toBeTruthy()
    expect(screen.getByText('folder.desktop.subtitle')).toBeTruthy()
    expect(screen.getByText('folder.desktop.emptyTitle')).toBeTruthy()
    expect(screen.queryAllByTestId('bound-dir-row')).toHaveLength(0)
    expect(screen.getAllByText('folder.desktop.addDirectory')).toHaveLength(1)
  })

  it('lists local Space-bound directories with tags and excludes remote / other-team dirs', () => {
    render(<TabFolderHomePane spaceId="space-a" />)

    // 本机绑定目录（含路径 + Space tag）
    expect(screen.getByText('/Users/me/a')).toBeTruthy()
    expect(screen.getByText('/Users/me/b')).toBeTruthy()
    expect(screen.getByText('Agent A')).toBeTruthy()
    expect(screen.getByText('Agent B')).toBeTruthy()
    // 跨设备 / 跨团队目录不展示
    expect(screen.queryByText('/Users/me/remote')).toBeNull()
    expect(screen.queryByText('Remote Space')).toBeNull()
    expect(screen.queryByText('/Users/me/other')).toBeNull()
    // 用户添加目录
    expect(screen.getByText('reference')).toBeTruthy()
  })

  it('renders bound dirs without a remove button (only user dirs are deletable)', () => {
    render(<TabFolderHomePane spaceId="space-a" />)
    // 两个绑定目录不可删；仅一个用户目录可删 → 仅 1 个移除按钮
    expect(screen.getAllByLabelText('folder.desktop.removeDirectory')).toHaveLength(1)
    // 绑定行存在
    expect(screen.getAllByTestId('bound-dir-row')).toHaveLength(2)
  })

  it('switches Space and opens the target directory start page (with targetSpaceId) on cross-Space bound click', async () => {
    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('/Users/me/b'))

    // 跨 Space：先切 Space（会话跟随），再在共享 desktop scope 打开带 targetSpaceId 的目录起始页。
    await waitFor(() => {
      expect(selectSpaceBySpaceId).toHaveBeenCalledWith('space-b')
    })
    expect(openResourceTab).toHaveBeenCalledWith('desktop:wt-1:user-1', {
      type: 'apphome',
      id: 'orchestration-space-b',
      title: 'b',
      meta: { appId: 'orchestration', targetSpaceId: 'space-b', spaceId: 'space-b' },
    })
    // 不再打开无 targetSpaceId 的默认 orchestration（会被旧标签清理 effect 打回第一个页签）。
    expect(onOpenAppHome).not.toHaveBeenCalled()
  })

  it('opens the target directory start page without switching when the bound dir is the active Space', async () => {
    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('/Users/me/a'))

    expect(selectSpaceBySpaceId).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(openResourceTab).toHaveBeenCalledWith('desktop:wt-1:user-1', {
        type: 'apphome',
        id: 'orchestration-space-a',
        title: 'a',
        meta: { appId: 'orchestration', targetSpaceId: 'space-a', spaceId: 'space-a' },
      })
    })
  })

  it('opens a user folder synchronously and leaves authorization to the pane gate', () => {
    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('reference'))

    expect(openResourceTab).toHaveBeenCalledWith('desktop:wt-1:user-1', {
      type: 'tabfolder',
      id: 'user::scope::ref',
      title: 'reference',
      meta: { path: '/Users/me/reference', kind: 'user' },
    })
    expect(appendSessionAllowedPathMock).not.toHaveBeenCalled()
  })

  it('closes the opened tabfolder tab when removing a user directory', () => {
    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByLabelText('folder.desktop.removeDirectory'))

    expect(folderState.removeUserFolder).toHaveBeenCalledWith('user::scope::ref')
    expect(findGroupByTabKeyMock).toHaveBeenCalledWith('desktop:wt-1:user-1', 'tabfolder:user::scope::ref')
    expect(closePaneMock).not.toHaveBeenCalled()
    expect(closeTabMock).toHaveBeenCalledWith('desktop:wt-1:user-1', 'tabfolder:user::scope::ref')
  })

  it('closes the canvas pane when the removed user directory is in a group', () => {
    findGroupByTabKeyMock.mockReturnValue({
      id: 'group-1',
      panes: [
        { id: 'pane-1', content: { tabKey: 'tabfolder:user::scope::ref' } },
        { id: 'pane-2', content: { tabKey: 'tabdoc:doc-1' } },
      ],
    })

    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByLabelText('folder.desktop.removeDirectory'))

    expect(closePaneMock).toHaveBeenCalledWith('desktop:wt-1:user-1', 'group-1', 'pane-1')
    expect(closeTabMock).toHaveBeenCalledWith('desktop:wt-1:user-1', 'tabfolder:user::scope::ref')
  })

  it('does not delay user-folder activation for a path probe', () => {
    pathExistsMock.mockResolvedValueOnce({
      success: true,
      exists: false,
      isDirectory: false,
    })

    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('reference'))

    expect(pathExistsMock).not.toHaveBeenCalled()
    expect(openResourceTab).toHaveBeenCalledWith('desktop:wt-1:user-1', {
      type: 'tabfolder',
      id: 'user::scope::ref',
      title: 'reference',
      meta: { path: '/Users/me/reference', kind: 'user' },
    })
    expect(appendSessionAllowedPathMock).not.toHaveBeenCalled()
  })

  it('shows an unavailable prompt and does not switch Space for a deleted bound directory', async () => {
    pathExistsMock.mockResolvedValueOnce({
      success: true,
      exists: false,
      isDirectory: false,
    })

    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('/Users/me/b'))

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'folder.errors.directoryUnavailableTitle',
        description: 'folder.errors.directoryUnavailableDescription',
        preferNative: true,
      }))
    })
    expect(selectSpaceBySpaceId).not.toHaveBeenCalled()
    expect(openResourceTab).not.toHaveBeenCalled()
  })

  it('adds a new directory and opens it as a tabfolder tab', async () => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        getPlatform: () => 'darwin',
        showOpenDialog: vi.fn().mockResolvedValue(['/Users/me/new-folder']),
        workspace: { appendSessionAllowedPath: appendSessionAllowedPathMock },
        fileSystem: { pathExists: pathExistsMock },
      },
    })

    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('folder.desktop.addDirectory'))

    await waitFor(() => {
      expect(folderState.addUserFolder).toHaveBeenCalledWith('tabfolder:organization:wt-1:user:user-1', {
        rootPath: '/Users/me/new-folder',
        kind: 'user',
        title: 'new-folder',
      })
    })
  })

  it('shows a native error toast when the directory picker fails', async () => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        getPlatform: () => 'darwin',
        showOpenDialog: vi.fn().mockRejectedValue(new Error('picker failed')),
        workspace: { appendSessionAllowedPath: appendSessionAllowedPathMock },
        fileSystem: { pathExists: pathExistsMock },
      },
    })

    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('folder.desktop.addDirectory'))

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: 'folder.errors.openFolderTitle',
        description: 'picker failed',
        variant: 'destructive',
        preferNative: true,
      }))
    })
    expect(folderState.addUserFolder).not.toHaveBeenCalled()
  })

  it('blocks adding a directory that duplicates a user folder', async () => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        getPlatform: () => 'darwin',
        showOpenDialog: vi.fn().mockResolvedValue(['/Users/me/reference']),
        workspace: { appendSessionAllowedPath: appendSessionAllowedPathMock },
        fileSystem: { pathExists: pathExistsMock },
      },
    })

    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('folder.desktop.addDirectory'))

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'folder.desktop.duplicateUserTitle', preferNative: true }),
      )
    })
    expect(folderState.addUserFolder).not.toHaveBeenCalled()
  })

  it('blocks adding a directory that is already bound to a Space', async () => {
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        getPlatform: () => 'darwin',
        showOpenDialog: vi.fn().mockResolvedValue(['/Users/me/a']),
        workspace: { appendSessionAllowedPath: appendSessionAllowedPathMock },
        fileSystem: { pathExists: pathExistsMock },
      },
    })

    render(<TabFolderHomePane spaceId="space-a" />)

    fireEvent.click(screen.getByText('folder.desktop.addDirectory'))

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'folder.desktop.duplicateBoundTitle', preferNative: true }),
      )
    })
    expect(folderState.addUserFolder).not.toHaveBeenCalled()
  })

  it('reconciles bound directories to support downgrade takeover', () => {
    render(<TabFolderHomePane spaceId="space-a" />)

    expect(folderState.reconcileBoundDirs).toHaveBeenCalledWith(
      'tabfolder:organization:wt-1:user:user-1',
      expect.arrayContaining(['/Users/me/a', '/Users/me/b']),
    )
  })
})
