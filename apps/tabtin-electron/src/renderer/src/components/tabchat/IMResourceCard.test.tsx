import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockCloseSettings,
  mockSetCurrentTab,
  mockEnsureSpaceSelectedWithFeedback,
  mockOpenSharedResourceTab,
  mockOpenTableTab,
  mockOpenResourceTab,
  spaceState,
} = vi.hoisted(() => ({
  mockCloseSettings: vi.fn(),
  mockSetCurrentTab: vi.fn(),
  mockEnsureSpaceSelectedWithFeedback: vi.fn().mockResolvedValue(true),
  mockOpenSharedResourceTab: vi.fn(),
  mockOpenTableTab: vi.fn(),
  mockOpenResourceTab: vi.fn(),
  spaceState: {
    spaces: [{ id: 'host-space-1', organization_id: 'organization-1' }],
    selectedSpace: { id: 'host-space-1', organization_id: 'organization-1' },
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({ setCurrentTab: mockSetCurrentTab }),
  },
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: 'user-1' } }),
  },
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({ closeSettings: mockCloseSettings }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceState,
  },
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openTableTab: mockOpenTableTab,
      openResourceTab: mockOpenResourceTab,
    }),
  },
}))

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: mockEnsureSpaceSelectedWithFeedback,
}))

vi.mock('@/services/openSharedResource', () => ({
  openSharedResourceTab: mockOpenSharedResourceTab,
}))

vi.mock('@/components/context-space/restore/openResourceMembershipGuard', () => ({
  openResourceTabGuarded: mockOpenResourceTab,
  openTableTabGuarded: mockOpenTableTab,
}))

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: vi.fn(),
}))

vi.mock('@components/layout/workspaceContextState', () => ({
  buildDesktopScopeKey: () => 'desktop:user-1',
}))

// openSubagentTab 会拉入较重的 store / table-ui 传递依赖（ViewFilterRulesEditor 需
// resolveChoiceTagColors），本测试的 @tabtin/smartsheet-ui mock 精简，直接 mock 掉这个
// 纯函数模块以保持隔离。resolveForegroundTabScopeKey 在同 Space 分支才会被调用，
// 这里按 identity 返回 spaceId（等价于旧行为）。
vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (spaceId: string) => spaceId,
}))

vi.mock('@/lib/useResourceCardPreview', () => ({
  useResourceCardPreviewContext: (
    _resourceId: string,
    _spaceId: string | undefined,
    description?: string,
    previewTable?: { columns: Array<{ key: string; label: string }>; rows: Array<Record<string, string>> },
  ) => ({
    previewText: description,
    metadata: null,
    previewTable,
    liveTitle: undefined,
    availability: 'available',
    currentUserRole: 'editor',
  }),
}))

describe('IMResourceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnsureSpaceSelectedWithFeedback.mockResolvedValue(true)
    spaceState.spaces = [{ id: 'host-space-1', organization_id: 'organization-1' }]
    spaceState.selectedSpace = { id: 'host-space-1', organization_id: 'organization-1' }
  })

  it('opens shared resource tab when resource space is not directly visible', async () => {
    const { IMResourceCard } = await import('./IMResourceCard')

    render(
      <IMResourceCard
        resourceType="document"
        resourceId="doc-1"
        name="Shared Doc"
        spaceId="owner-private-space"
        organizationId="organization-1"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /Shared Doc/ }))

    await waitFor(() => {
      expect(mockOpenSharedResourceTab).toHaveBeenCalledWith({
        hostSpaceId: 'host-space-1',
        resourceType: 'doc',
        resourceId: 'doc-1',
        resourceSpaceId: 'owner-private-space',
        organizationId: 'organization-1',
        title: 'Shared Doc',
      })
    })
    expect(mockCloseSettings).toHaveBeenCalled()
    expect(mockSetCurrentTab).toHaveBeenCalledWith('agent')
    expect(mockEnsureSpaceSelectedWithFeedback).toHaveBeenCalledWith(
      'host-space-1',
      expect.objectContaining({ organizationId: 'organization-1' }),
    )
    expect(mockOpenResourceTab).not.toHaveBeenCalled()
    expect(mockOpenTableTab).not.toHaveBeenCalled()
  })

  it('renders document-like content preview with feishu-style footer', async () => {
    const { IMResourceCard } = await import('./IMResourceCard')

    render(
      <IMResourceCard
        resourceType="document"
        resourceId="doc-1"
        name="Space 定位与 Agent 工作关系对齐稿"
        spaceId="host-space-1"
        organizationId="organization-1"
        description={'关系总览\nTabTin 的 Space 与 Agent 在同一 Organization 下协作。'}
      />,
    )

    expect(screen.getByText('Space 定位与 Agent 工作关系对齐稿')).toBeTruthy()
    expect(screen.getByText('关系总览')).toBeTruthy()
    expect(screen.getByText('TabTin 的 Space 与 Agent 在同一 Organization 下协作。')).toBeTruthy()
    expect(screen.getByText('云文档')).toBeTruthy()
    expect(screen.getByText('你可编辑')).toBeTruthy()
  })

  it('renders table headers and sample rows from preview snapshot', async () => {
    const { IMResourceCard } = await import('./IMResourceCard')

    render(
      <IMResourceCard
        resourceType="table"
        resourceId="table-1"
        name="销售线索"
        spaceId="host-space-1"
        organizationId="organization-1"
        previewTable={{
          columns: [
            { key: 'f1', label: '客户' },
            { key: 'f2', label: '阶段' },
          ],
          rows: [{ f1: 'Acme', f2: '跟进中' }],
          total_rows: 12,
        }}
      />,
    )

    expect(screen.getByText('销售线索')).toBeTruthy()
    expect(screen.getByText('客户')).toBeTruthy()
    expect(screen.getByText('阶段')).toBeTruthy()
    expect(screen.getByText('Acme')).toBeTruthy()
    expect(screen.getByText('跟进中')).toBeTruthy()
    expect(screen.getByText('多维表格')).toBeTruthy()
  })
})
