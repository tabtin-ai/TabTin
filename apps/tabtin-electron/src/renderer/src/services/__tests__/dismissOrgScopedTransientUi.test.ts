import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockSpaceAgentClose,
  mockAgentSettingsClose,
  mockAppCollaborationClose,
  mockSetGlobalSearchOpen,
  mockUiSetState,
  mockCreateSiteClose,
  mockCreateSiteGetState,
  mockResetForOrganization,
  mockClearAllScenes,
  mockCloseAppPage,
  mockResetProjectSelection,
  mockClearOrganizationBuckets,
  mockClearOrganizationCollections,
  mockLoadSpaces,
  mockClearForegroundSessionSelection,
} = vi.hoisted(() => ({
  mockSpaceAgentClose: vi.fn(),
  mockAgentSettingsClose: vi.fn(),
  mockAppCollaborationClose: vi.fn(),
  mockSetGlobalSearchOpen: vi.fn(),
  mockUiSetState: vi.fn(),
  mockCreateSiteClose: vi.fn(),
  mockCreateSiteGetState: vi.fn(() => ({ isOpen: false, close: vi.fn() })),
  mockResetForOrganization: vi.fn(),
  mockClearAllScenes: vi.fn(),
  mockCloseAppPage: vi.fn(),
  mockResetProjectSelection: vi.fn(),
  mockClearOrganizationBuckets: vi.fn(),
  mockClearOrganizationCollections: vi.fn(),
  mockLoadSpaces: vi.fn(),
  mockClearForegroundSessionSelection: vi.fn(),
}))

vi.mock('@stores/useSpaceAgentDialogStore', () => ({
  useSpaceAgentDialogStore: {
    getState: () => ({ close: mockSpaceAgentClose }),
  },
}))

vi.mock('@stores/useAgentSettingsSheetStore', () => ({
  useAgentSettingsSheetStore: {
    getState: () => ({ close: mockAgentSettingsClose }),
  },
}))

vi.mock('@stores/useAppCollaborationStore', () => ({
  useAppCollaborationStore: {
    getState: () => ({ close: mockAppCollaborationClose }),
  },
}))

vi.mock('@stores/useUIStore', () => ({
  useUIStore: Object.assign(
    {
      getState: () => ({ setGlobalSearchOpen: mockSetGlobalSearchOpen }),
    },
    { setState: mockUiSetState },
  ),
}))

vi.mock('@stores/useCreateSiteDialog', () => ({
  useCreateSiteDialog: {
    getState: () => mockCreateSiteGetState(),
  },
}))

vi.mock('@stores/useAgentsWorkbenchStore', () => ({
  useAgentsWorkbenchStore: {
    getState: () => ({ resetForOrganization: mockResetForOrganization }),
  },
}))

vi.mock('@stores/useWorkbenchSceneStore', () => ({
  useWorkbenchSceneStore: {
    getState: () => ({ clearAllScenes: mockClearAllScenes }),
  },
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({ closeAppPage: mockCloseAppPage }),
  },
}))

vi.mock('@components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => ({ resetForOrganizationSwitch: mockResetProjectSelection }),
  },
}))

vi.mock('@stores/useUnifiedResources', () => ({
  useUnifiedResources: {
    getState: () => ({ clearOrganizationBuckets: mockClearOrganizationBuckets }),
  },
}))

vi.mock('@stores/useCollections', () => ({
  useCollections: {
    getState: () => ({ clearOrganization: mockClearOrganizationCollections }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ loadSpaces: mockLoadSpaces }),
  },
}))

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      clearForegroundSessionSelection: mockClearForegroundSessionSelection,
    }),
  },
}))

import {
  ORG_CONTEXT_RESET_EVENT,
  dismissOrgScopedTransientUi,
} from '../dismissOrgScopedTransientUi'

describe('dismissOrgScopedTransientUi', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateSiteGetState.mockReturnValue({ isOpen: false, close: mockCreateSiteClose })
  })

  it('closes store dialogs, clears scenes, and broadcasts reset event', () => {
    const onReset = vi.fn()
    window.addEventListener(ORG_CONTEXT_RESET_EVENT, onReset)

    dismissOrgScopedTransientUi({
      organizationId: 'org-b',
      previousOrganizationId: 'org-a',
    })

    expect(mockSpaceAgentClose).toHaveBeenCalledTimes(1)
    expect(mockAgentSettingsClose).toHaveBeenCalledTimes(1)
    expect(mockAppCollaborationClose).toHaveBeenCalledTimes(1)
    expect(mockSetGlobalSearchOpen).toHaveBeenCalledWith(false)
    expect(mockUiSetState).toHaveBeenCalledWith({ appFocusChatOverlayOpenByScopeKey: {} })
    expect(mockCreateSiteClose).not.toHaveBeenCalled()
    // ：AI 分身列表的组织同步由 SidebarAgentsPanel 单独负责。
    // 全局 teardown 再次重置同一 Store 会作废刚发出的新组织请求，使列表永久 loading。
    expect(mockResetForOrganization).not.toHaveBeenCalled()
    expect(mockClearAllScenes).toHaveBeenCalledTimes(1)
    expect(onReset).toHaveBeenCalledTimes(1)
    expect((onReset.mock.calls[0][0] as CustomEvent).detail).toEqual({
      organizationId: 'org-b',
      previousOrganizationId: 'org-a',
    })

    window.removeEventListener(ORG_CONTEXT_RESET_EVENT, onReset)
  })

  it('cancels open create-site dialog with null', () => {
    mockCreateSiteGetState.mockReturnValue({ isOpen: true, close: mockCreateSiteClose })

    dismissOrgScopedTransientUi({
      organizationId: 'org-b',
      previousOrganizationId: 'org-a',
    })

    expect(mockCreateSiteClose).toHaveBeenCalledWith(null)
  })

  it('#7399 clears app page / project immersion and previous org panel caches', () => {
    dismissOrgScopedTransientUi({
      organizationId: 'org-b',
      previousOrganizationId: 'org-a',
    })

    expect(mockCloseAppPage).toHaveBeenCalledTimes(1)
    expect(mockResetProjectSelection).toHaveBeenCalledTimes(1)
    expect(mockClearOrganizationBuckets).toHaveBeenCalledWith('org-a')
    expect(mockClearOrganizationCollections).toHaveBeenCalledWith('org-a')
    expect(mockLoadSpaces).toHaveBeenCalledWith('org-b')
  })

  it('#7672 clears foreground chat session selection without purging cache buckets', () => {
    dismissOrgScopedTransientUi({
      organizationId: 'org-b',
      previousOrganizationId: 'org-a',
    })

    expect(mockClearForegroundSessionSelection).toHaveBeenCalledTimes(1)
  })

  it('#7399 skips previous-org purge when previousOrganizationId is null', () => {
    dismissOrgScopedTransientUi({
      organizationId: 'org-b',
      previousOrganizationId: null,
    })

    expect(mockClearOrganizationBuckets).not.toHaveBeenCalled()
    expect(mockClearOrganizationCollections).not.toHaveBeenCalled()
    expect(mockLoadSpaces).toHaveBeenCalledWith('org-b')
  })
})
