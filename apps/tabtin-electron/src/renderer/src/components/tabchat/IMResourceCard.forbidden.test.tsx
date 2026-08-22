import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockCreateResourceAccessRequest, mockToast } = vi.hoisted(() => ({
  mockCreateResourceAccessRequest: vi.fn(),
  mockToast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: mockToast,
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: { getState: () => ({ setCurrentTab: vi.fn() }) },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: { id: 'user-1' } }) },
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: { getState: () => ({ closeSettings: vi.fn() }) },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: { getState: () => ({ spaces: [], selectedSpace: null }) },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openTableTab: vi.fn(), openResourceTab: vi.fn() }),
  },
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: vi.fn(),
}))

vi.mock('@/services/openSharedResource', () => ({
  openSharedResourceTab: vi.fn(),
}))

vi.mock('@/components/context-space/restore/openResourceMembershipGuard', () => ({
  openResourceTabGuarded: vi.fn(),
  openTableTabGuarded: vi.fn(),
}))

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: vi.fn(),
}))

vi.mock('@components/layout/workspaceContextState', () => ({
  buildDesktopScopeKey: () => 'desktop:user-1',
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => spaceId,
}))

vi.mock('@/lib/useResourceCardPreview', () => ({
  useResourceCardPreviewContext: () => ({
    previewText: undefined,
    metadata: null,
    previewTable: undefined,
    liveTitle: undefined,
    availability: 'forbidden',
    currentUserRole: undefined,
  }),
}))

vi.mock('@/services/tabchatApi', () => ({
  createResourceAccessRequest: mockCreateResourceAccessRequest,
}))

vi.mock('./ImConversationCanvasContext', () => ({
  useImConversationCanvas: () => null,
}))

describe('IMResourceCard forbidden ', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCreateResourceAccessRequest.mockResolvedValue({
      id: 'req-1',
      status: 'pending',
    })
  })

  it('does not show readable permission label and offers request access', async () => {
    const { IMResourceCard } = await import('./IMResourceCard')

    render(
      <IMResourceCard
        resourceType="document"
        resourceId="doc-1"
        name="Private Doc"
        spaceId="space-1"
        organizationId="org-1"
        sourceConversationId="conv-1"
        sourceMessageId={42}
      />,
    )

    expect(screen.queryByText('你可阅读')).toBeNull()
    expect(screen.queryByText('你可编辑')).toBeNull()
    expect(screen.getByText('暂无访问权限')).toBeTruthy()
    expect(screen.getByRole('button', { name: '申请访问' })).toBeTruthy()
  })

  it('submits access request once and switches to requested state', async () => {
    const { IMResourceCard } = await import('./IMResourceCard')

    render(
      <IMResourceCard
        resourceType="table"
        resourceId="table-1"
        name="Private Table"
        spaceId="space-1"
        organizationId="org-1"
        sourceConversationId="conv-9"
        sourceMessageId={7}
        sourceMessageRef="018f4b30-a7ad-7b32-b946-827ea2a26983"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '申请访问' }))

    await waitFor(() => {
      expect(mockCreateResourceAccessRequest).toHaveBeenCalledTimes(1)
    })
    expect(mockCreateResourceAccessRequest).toHaveBeenCalledWith({
      sourceConversationId: 'conv-9',
      sourceMessageId: 7,
      sourceMessageRef: '018f4b30-a7ad-7b32-b946-827ea2a26983',
      resourceType: 'table',
      resourceId: 'table-1',
    })

    await waitFor(() => {
      expect(screen.getByText('已申请访问')).toBeTruthy()
    })
    expect(screen.queryByRole('button', { name: '申请访问' })).toBeNull()
    expect(screen.getByText('等待确认')).toBeTruthy()

    // 已申请态不可再点
    expect(mockCreateResourceAccessRequest).toHaveBeenCalledTimes(1)
  })

  it('keeps request button disabled without source message anchors', async () => {
    const { IMResourceCard } = await import('./IMResourceCard')

    render(
      <IMResourceCard
        resourceType="document"
        resourceId="doc-1"
        name="Private Doc"
        spaceId="space-1"
      />,
    )

    const button = screen.getByRole('button', { name: '申请访问' })
    expect(button).toHaveProperty('disabled', true)
    fireEvent.click(button)
    expect(mockCreateResourceAccessRequest).not.toHaveBeenCalled()
  })
})
