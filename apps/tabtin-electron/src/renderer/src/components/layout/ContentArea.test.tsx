import React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

const organizationState = {
  selectedOrganization: { id: 'org-1' } as { id: string } | null,
}

const wsConnectionState = {
  organizationAccessRecoveryInFlight: false,
  organizationAccessBlocked: false,
  organizationAccessBlockedId: null as string | null,
  organizationAccessBlockedName: null as string | null,
}

const { mockSpaceState } = vi.hoisted(() => ({
  mockSpaceState: {
    selectedSpace: null,
    isLoading: false,
  },
}))

afterEach(() => {
  organizationState.selectedOrganization = { id: 'org-1' }
  Object.assign(wsConnectionState, {
    organizationAccessRecoveryInFlight: false,
    organizationAccessBlocked: false,
    organizationAccessBlockedId: null,
    organizationAccessBlockedName: null,
  })
  mockSpaceState.isLoading = false
})

vi.mock('@/crawlspace/registry', () => ({
  useCrawlspaceRegistry: () => ({ configsById: {} }),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: (selector: (state: { activeKeyBySpace: Record<string, string | null> }) => unknown) =>
    selector({ activeKeyBySpace: {} }),
}))

vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = Object.assign(
    (selector: (s: typeof organizationState) => unknown) => selector(organizationState),
    {
      getState: () => organizationState,
      subscribe: vi.fn(() => () => {}),
      setState: vi.fn(),
    },
  )
  return { useOrganizationStore }
})

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: typeof mockSpaceState) => unknown) => selector(mockSpaceState),
    {
      getState: () => mockSpaceState,
      subscribe: vi.fn(() => () => {}),
    },
  ),
}))

vi.mock('@stores/useWsConnectionStore', () => ({
  useWsConnectionStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector(wsConnectionState),
  isOrganizationAccessBlockedFor: (
    blocked: boolean,
    blockedId: string | null,
    organizationId: string | null,
  ) => blocked && blockedId === organizationId,
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: Object.assign(
    () => ({ closeSettings: vi.fn() }),
    {
      getState: () => ({ closeSettings: vi.fn() }),
      subscribe: vi.fn(() => () => {}),
    },
  ),
}))

vi.mock('./IMWelcomePanel', () => ({
  IMWelcomePanel: () => <div data-testid="im-welcome-panel" />,
}))

vi.mock('./WelcomePage', () => ({
  WelcomePage: () => <div data-testid="welcome-page" />,
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: Object.assign(
    () => ({ setCurrentTab: vi.fn() }),
    {
      getState: () => ({ setCurrentTab: vi.fn() }),
      subscribe: vi.fn(),
    },
  ),
}))

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: {
    parseTabKey: () => null,
  },
}))

vi.mock('@components/context-space/registry/index', () => ({
  contextRegistry: {
    parseTabKey: () => null,
  },
}))

vi.mock('@/components/context-space/registry', () => ({
  contextRegistry: {
    parseTabKey: () => null,
  },
}))

vi.mock('@tabtin/resource-router', () => ({
  parseResourcePointer: vi.fn(),
}))

vi.mock('./contentAreaState', () => ({
  resolveContentAreaUiState: () => ({
    portalEnabled: false,
    workspaceLayerVisible: true,
  }),
  resolveEffectivePortalTableIds: () => [],
}))

vi.mock('./useSpaceWorkbenchPortalIds', () => ({
  useSpaceWorkbenchPortalIds: () => ({
    portalTableIds: [],
    terminalSessionIds: [],
  }),
}))

vi.mock('./SpaceWorkbenchHost', () => ({
  SpaceWorkbenchHost: () => <div data-testid="space-workbench-host" />,
}))

vi.mock('@components/context-space/WorkspaceRootBanner', () => ({
  WorkspaceRootBanner: () => <div data-testid="workspace-root-banner" />,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      fallback?: string | { defaultValue?: string },
    ) =>
      typeof fallback === 'string'
        ? fallback
        : fallback?.defaultValue ?? _key,
  }),
}))

import { ContentArea } from './ContentArea'

function renderInitialAgentLoading() {
  return render(
    <ContentArea
      workbenchMode="welcome"
      activeSpaceContext={null}
      placeholderKind={null}
      isInitialAgentViewLoading
    />,
  )
}

describe('ContentArea workspace root banner layout', () => {
  it('renders the workspace root banner before a flexing content slot', async () => {
    render(
      <ContentArea
        workbenchMode="space"
        activeSpaceContext={{ id: 'space-1', type: 'workspace' } as never}
        placeholderKind={null}
      />,
    )

    const banner = screen.getByTestId('workspace-root-banner')
    const contentSlot = banner.nextElementSibling as HTMLElement | null

    expect(contentSlot).toBeTruthy()
    expect(contentSlot?.className).toContain('flex')
    expect(contentSlot?.className).toContain('flex-col')
    expect(contentSlot?.className).toContain('flex-1')
    expect(contentSlot?.className).toContain('min-h-0')
    expect(contentSlot?.className).toContain('overflow-hidden')
    expect(await screen.findByTestId('space-workbench-host')).toBeTruthy()
    expect(contentSlot?.contains(screen.getByTestId('space-workbench-host'))).toBe(true)
  })
})

describe('ContentArea IM primary view', () => {
  it('主画布只放欢迎页，消息列表与聊天留给 shell IM rail', async () => {
    render(
      <ContentArea
        workbenchMode="im"
        activeSpaceContext={null}
        placeholderKind={null}
      />,
    )

    expect(await screen.findByTestId('im-welcome-panel')).toBeTruthy()
    expect(screen.queryByTestId('tab-chat-panel')).toBeNull()
  })

  it('im-chat 无工作空间时也不再挂第二套 TabChatPanel', async () => {
    render(
      <ContentArea
        workbenchMode="im-chat"
        activeSpaceContext={null}
        placeholderKind={null}
      />,
    )

    expect(await screen.findByTestId('im-welcome-panel')).toBeTruthy()
    expect(screen.queryByTestId('space-workbench-host')).toBeNull()
  })
})

describe('ContentArea organization access blocker', () => {
  it('不以组织 A 的阻断态覆盖已切换到组织 B 的加载页', () => {
    organizationState.selectedOrganization = { id: 'org-b' }
    Object.assign(wsConnectionState, {
      organizationAccessBlocked: true,
      organizationAccessBlockedId: 'org-a',
      organizationAccessBlockedName: '组织 A',
    })

    const view = renderInitialAgentLoading()

    expect(screen.queryByText('无法访问当前组织')).toBeNull()
    expect(screen.getByText('正在加载 Space...')).toBeTruthy()

    organizationState.selectedOrganization = { id: 'org-a' }
    view.rerender(
      <ContentArea
        workbenchMode="welcome"
        activeSpaceContext={null}
        placeholderKind={null}
        isInitialAgentViewLoading
      />,
    )

    expect(screen.getByText('无法访问当前组织')).toBeTruthy()
  })
})

describe('ContentArea welcome loading state', () => {
  it('shows loading instead of the empty welcome CTA while initial Agent data is loading', () => {
    render(
      <ContentArea
        workbenchMode="welcome"
        activeSpaceContext={null}
        placeholderKind={null}
        isInitialAgentViewLoading
      />,
    )

    expect(screen.getByText('正在加载 Space...')).toBeTruthy()
    expect(screen.getByText('正在同步你的组织和 Space 列表')).toBeTruthy()
    expect(screen.queryByText('创建第一个 Agent')).toBeNull()
  })

  it('keeps the loading state while the target organization spaces are loading', () => {
    mockSpaceState.isLoading = true

    try {
      render(
        <ContentArea
          workbenchMode="welcome"
          activeSpaceContext={null}
          placeholderKind={null}
        />,
      )

      expect(screen.getByText('正在加载 Space...')).toBeTruthy()
      expect(screen.queryByTestId('welcome-create-first-workspace')).toBeNull()
    } finally {
      mockSpaceState.isLoading = false
    }
  })
})
