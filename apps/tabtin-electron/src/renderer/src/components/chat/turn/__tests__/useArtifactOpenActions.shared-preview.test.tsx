/**
 * ：共享会话本地文件预览 — useArtifactOpenActions 主动作分流。
 *
 * 共享会话有 SharedSessionPreview 时，local_file 走 openSharedLocalFilePreview，
 * 不走遥控端不可用；普通会话（preview 为 null）行为不变。
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const toast = vi.fn()
const openResourceUrlInSpace = vi.fn()
const openLocalArtifactWithSystemApp = vi.fn()
const openLocalHtmlInSpace = vi.fn()
const openProjectTaskDocumentPreview = vi.fn(() => false)
const openSharedLocalFilePreview = vi.fn()
const openSharedResourceTab = vi.fn()

const remoteViewerState = {
  isRemoteViewer: false,
  isResolving: false,
  controlDeviceName: null as string | null,
  controlDeviceId: null as string | null,
  workingDir: null as string | null,
}

const sharedSessionPreviewState = {
  value: null as null | {
    sessionId: string
    organizationId: string | null
    openSharedLocalFilePreview: typeof openSharedLocalFilePreview
  },
}

const spaceState = {
  spaces: [] as Array<{ id: string; organization_id: string }>,
  selectedSpace: null as { id: string; organization_id: string } | null,
}

const imCanvasState = {
  value: null as null | {
    conversationId: string
    scopeKey: string
    executionSpaceId: string
  },
}

const mockVirtualModule = vi.mock as unknown as (
  path: string,
  factory: () => unknown,
  options: { virtual: boolean },
) => void
mockVirtualModule('@tabtin/resource-router', () => ({
  parseResourcePointer: (href: string) => {
    const match = /^tabtin:\/\/resource\/([^/?#]+)\/([^?#]+)(?:\?([^#]*))?/.exec(href)
    const params = new URLSearchParams(match?.[3] ?? '')
    return {
      scheme: 'tabtin',
      type: match ? decodeURIComponent(match[1]!) : 'file',
      id: match ? decodeURIComponent(match[2]!) : href,
      raw: href,
      hint: params.get('hint'),
      meta: Object.fromEntries(params.entries()),
    }
  },
}), { virtual: true })

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: (...args: unknown[]) => toast(...args),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('@/services/openResourceLink', () => ({
  openResourceUrlInSpace: (...args: unknown[]) => openResourceUrlInSpace(...args),
  resolveSpaceIdForResourceLink: () => 'space-1',
  expandCanvasForScope: vi.fn(),
}))

vi.mock('@/services/openSharedResource', () => ({
  openSharedResourceTab: (...args: unknown[]) => openSharedResourceTab(...args),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceState,
  },
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: vi.fn(),
}))

vi.mock('@/services/openProjectTaskDocumentPreview', () => ({
  openProjectTaskDocumentPreview: (...args: unknown[]) =>
    openProjectTaskDocumentPreview(...args),
}))

vi.mock('@/components/chat/preview/useCloudDocumentPreviewStore', () => ({
  useCloudDocumentPreviewStore: {
    getState: () => ({ open: vi.fn() }),
  },
}))

vi.mock('@/components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => ({
      selectedProjectId: null,
      activeTaskSessionId: null,
    }),
  },
}))

vi.mock('@/components/tabchat/ImConversationCanvasContext', () => ({
  useImConversationCanvas: () => imCanvasState.value,
}))

vi.mock('@/services/openLocalHtmlInSpace', () => ({
  openLocalHtmlInSpace: (...args: unknown[]) => openLocalHtmlInSpace(...args),
}))

vi.mock('@/services/openLocalArtifactSystemApp', () => ({
  openLocalArtifactWithSystemApp: (...args: unknown[]) =>
    openLocalArtifactWithSystemApp(...args),
}))

const openArtifactWorkspaceDir = vi.fn()
const revealArtifactInFinder = vi.fn()

vi.mock('@/services/localArtifactActions', () => ({
  openArtifactWorkspaceDir: (...args: unknown[]) => openArtifactWorkspaceDir(...args),
  revealArtifactInFinder: (...args: unknown[]) => revealArtifactInFinder(...args),
}))

vi.mock('@/services/localFileResourceResolver', () => {
  const isLocal = (href: string) =>
    /^tabtin:\/\/resource\/file\//.test(href) && href.includes('hint=tabfiles')
  return {
    isLocalFileArtifactHref: (href: string) => isLocal(href),
    isUnsupportedLocalArtifactHref: () => false,
    isLocalHtmlArtifactHref: () => false,
  }
})

vi.mock('@components/context-space/hooks/useIsRemoteViewer', () => ({
  useIsRemoteViewer: () => remoteViewerState,
}))

vi.mock('@/components/chat/shared-view/preview', () => ({
  useSharedSessionPreview: () => sharedSessionPreviewState.value,
}))

import { useArtifactOpenActions } from '../useArtifactOpenActions'

const LOCAL_FILE_HREF =
  'tabtin://resource/file/artifacts%2Fdemo-table.xlsx?hint=tabfiles&title=demo-table.xlsx'

describe('useArtifactOpenActions — 共享会话本地文件预览', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    remoteViewerState.isRemoteViewer = false
    remoteViewerState.controlDeviceName = null
    sharedSessionPreviewState.value = null
    imCanvasState.value = null
    spaceState.spaces = [
      { id: 'grantee-host-1', organization_id: 'org-1' },
      { id: 'selected-host-2', organization_id: 'org-2' },
    ]
    spaceState.selectedSpace = spaceState.spaces[1]!
    openResourceUrlInSpace.mockResolvedValue({
      outcome: 'in_space_opened',
      carrierAppId: 'tabfiles',
      resolveSource: 'manifest_default',
    })
    openLocalArtifactWithSystemApp.mockResolvedValue({ ok: true, absolutePath: '/abs/x' })
    openProjectTaskDocumentPreview.mockReturnValue(false)
  })

  it('共享会话：local_file 走 openSharedLocalFilePreview，不走遥控端不可用', async () => {
    remoteViewerState.isRemoteViewer = true
    remoteViewerState.controlDeviceName = '主端 Mac'
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: 'org-1',
      openSharedLocalFilePreview,
    }

    const { result } = renderHook(() =>
      useArtifactOpenActions({ href: LOCAL_FILE_HREF, tabScopeKey: 'conversation:shared-1' }),
    )

    expect(result.current.isRemoteLocalFile).toBe(false)
    expect(result.current.isSharedSessionLocalFile).toBe(true)
    expect(result.current.canPrimaryPreview).toBe(true)
    expect(result.current.remoteUnavailableHint).toBeNull()

    let opened = false
    await act(async () => {
      opened = await result.current.openPrimary()
    })

    expect(opened).toBe(true)
    expect(openSharedLocalFilePreview).toHaveBeenCalledWith({
      relativePath: 'artifacts/demo-table.xlsx',
      title: 'demo-table.xlsx',
    })
    expect(toast).not.toHaveBeenCalled()
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
    expect(openLocalArtifactWithSystemApp).not.toHaveBeenCalled()
  })

  it('共享会话：工作区 / 系统应用 / Reveal 均收敛到会话内预览', async () => {
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: 'org-1',
      openSharedLocalFilePreview,
    }

    const { result } = renderHook(() =>
      useArtifactOpenActions({ href: LOCAL_FILE_HREF, tabScopeKey: 'conversation:shared-1' }),
    )

    await act(async () => {
      result.current.openWorkspace()
      await result.current.openWithSystemApp()
      await result.current.revealInFinder()
    })

    expect(openSharedLocalFilePreview).toHaveBeenCalledTimes(3)
    expect(openArtifactWorkspaceDir).not.toHaveBeenCalled()
    expect(openLocalArtifactWithSystemApp).not.toHaveBeenCalled()
    expect(revealArtifactInFinder).not.toHaveBeenCalled()
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('普通会话：SharedSessionPreview 为 null 时，遥控端 local_file 仍走 remote unavailable', async () => {
    remoteViewerState.isRemoteViewer = true
    remoteViewerState.controlDeviceName = '主端 Mac'
    sharedSessionPreviewState.value = null

    const { result } = renderHook(() =>
      useArtifactOpenActions({ href: LOCAL_FILE_HREF, tabScopeKey: 'conversation:session-1' }),
    )

    expect(result.current.isRemoteLocalFile).toBe(true)
    expect(result.current.remoteUnavailableHint).toBeTruthy()

    let opened = true
    await act(async () => {
      opened = await result.current.openPrimary()
    })

    expect(opened).toBe(false)
    expect(openSharedLocalFilePreview).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: '文件在远程设备上',
      description: result.current.remoteUnavailableHint,
    }))
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('共享会话：体积超过物化硬顶时禁用预览且不打开标签', async () => {
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: 'org-1',
      openSharedLocalFilePreview,
    }

    const { result } = renderHook(() =>
      useArtifactOpenActions({
        href: LOCAL_FILE_HREF,
        tabScopeKey: 'conversation:shared-1',
        fileSize: 50 * 1024 * 1024 + 1,
      }),
    )

    expect(result.current.isSharedSessionLocalFile).toBe(true)
    expect(result.current.isSharedPreviewTooLarge).toBe(true)
    expect(result.current.sharedPreviewDisabledHint).toBe('文件过大，无法预览')

    let opened = true
    await act(async () => {
      opened = await result.current.openPrimary()
      result.current.openWorkspace()
      await result.current.openWithSystemApp()
    })

    expect(opened).toBe(false)
    expect(openSharedLocalFilePreview).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('共享会话：体积等于硬顶时仍可预览', async () => {
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: 'org-1',
      openSharedLocalFilePreview,
    }

    const { result } = renderHook(() =>
      useArtifactOpenActions({
        href: LOCAL_FILE_HREF,
        tabScopeKey: 'conversation:shared-1',
        fileSize: 50 * 1024 * 1024,
      }),
    )

    expect(result.current.isSharedPreviewTooLarge).toBe(false)

    let opened = false
    await act(async () => {
      opened = await result.current.openPrimary()
    })

    expect(opened).toBe(true)
    expect(openSharedLocalFilePreview).toHaveBeenCalledTimes(1)
  })

  it('共享会话：云表格预览强制 openSharedResourceTab（ A）', async () => {
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: 'org-1',
      openSharedLocalFilePreview,
    }

    const tableHref =
      'tabtin://resource/table/324dc4f9-f459-4e9c-87dc-d3669fcc6a60?hint=tabdata'

    const { result } = renderHook(() =>
      useArtifactOpenActions({
        href: tableHref,
        tabScopeKey: 'conversation:shared-1',
      }),
    )

    let opened = false
    await act(async () => {
      opened = await result.current.openPrimary()
    })

    expect(opened).toBe(true)
    expect(openSharedResourceTab).toHaveBeenCalledWith({
      hostSpaceId: 'grantee-host-1',
      resourceType: 'table',
      resourceId: '324dc4f9-f459-4e9c-87dc-d3669fcc6a60',
      resourceSpaceId: undefined,
      tabScopeKey: 'conversation:shared-1',
    })
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('共享会话：没有同组织 Workspace 时云产物 fail closed', async () => {
    spaceState.spaces = [{ id: 'selected-host-2', organization_id: 'org-2' }]
    spaceState.selectedSpace = spaceState.spaces[0]!
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: 'org-1',
      openSharedLocalFilePreview,
    }

    const { result } = renderHook(() =>
      useArtifactOpenActions({
        href: 'tabtin://resource/table/table-1?hint=tabdata',
        tabScopeKey: 'conversation:shared-1',
      }),
    )

    let opened = true
    await act(async () => {
      opened = await result.current.openPrimary()
    })

    expect(opened).toBe(false)
    expect(openSharedResourceTab).not.toHaveBeenCalled()
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('共享会话：Organization 尚未加载时云产物 fail closed', async () => {
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: null,
      openSharedLocalFilePreview,
    }

    const { result } = renderHook(() =>
      useArtifactOpenActions({
        href: 'tabtin://resource/table/table-1?hint=tabdata',
        tabScopeKey: 'conversation:shared-1',
      }),
    )

    await act(async () => {
      expect(await result.current.openPrimary()).toBe(false)
    })

    expect(openSharedResourceTab).not.toHaveBeenCalled()
    expect(openResourceUrlInSpace).not.toHaveBeenCalled()
  })

  it('共享会话：忽略其他组织的 IM Canvas Workspace', async () => {
    sharedSessionPreviewState.value = {
      sessionId: 'shared-session-1',
      organizationId: 'org-1',
      openSharedLocalFilePreview,
    }
    imCanvasState.value = {
      conversationId: 'conversation-1',
      scopeKey: 'im:conversation-1',
      executionSpaceId: 'selected-host-2',
    }

    const { result } = renderHook(() =>
      useArtifactOpenActions({
        href: 'tabtin://resource/document/doc-1?hint=tabdoc',
        tabScopeKey: 'conversation:shared-1',
      }),
    )

    await act(async () => {
      expect(await result.current.openPrimary()).toBe(true)
    })

    expect(openSharedResourceTab).toHaveBeenCalledWith({
      hostSpaceId: 'grantee-host-1',
      resourceType: 'doc',
      resourceId: 'doc-1',
      resourceSpaceId: undefined,
      tabScopeKey: 'im:conversation-1',
    })
  })
})
