import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const canManageSpaceLifecycleMock = vi.hoisted(() => vi.fn(() => true))
const useSpaceDeleteGuardMock = vi.hoisted(() =>
  vi.fn(() => ({
    canDelete: true,
    isResolving: false,
    isRemoteViewer: false,
    blockReason: null,
    controlDeviceName: null,
  })),
)

vi.mock('@/hooks/useCanManageSpaceLifecycle', () => ({
  canManageSpaceLifecycle: canManageSpaceLifecycleMock,
}))

vi.mock('../hooks/useSpaceDeleteGuard', () => ({
  useSpaceDeleteGuard: useSpaceDeleteGuardMock,
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedAgent: null,
        deleteSpace: vi.fn(),
        archiveSpace: vi.fn(),
        loadSpaces: vi.fn(),
        isLoading: false,
        error: null,
      }),
    {
      getState: () => ({ error: null }),
    },
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentUserRole: 'editor',
      selectedOrganization: { id: 'org-1', owner_id: 'user-1' },
    }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@components/settings/SettingsNameConfirmDialog', () => ({
  SettingsNameConfirmDialog: () => null,
}))

vi.mock('@components/context-space/dirtyExitConfirm/spaceDeleteGuard', () => ({
  confirmDirtyBeforeSpaceDelete: vi.fn(async () => true),
}))

vi.mock('@/utils/featureFlags', () => ({
  SPACE_TRASH_UI_ENABLED: false,
  SPACE_ARCHIVE_UI_ENABLED: false,
}))

import { WorkspaceLifecycleMenu } from '../WorkspaceLifecycleMenu'
import type { Space } from '@tabtin/app-shell'

const space = {
  id: 'ws-1',
  name: 'workspace-abc123',
  organization_id: 'org-1',
  type: 'workspace',
  workspace_record: true,
  status: 'active',
  table_count: 0,
  order: 0,
  is_archived: false,
  is_default: false,
  created_at: '',
  updated_at: '',
} as Space

describe('WorkspaceLifecycleMenu', () => {
  beforeEach(() => {
    canManageSpaceLifecycleMock.mockReturnValue(true)
    useSpaceDeleteGuardMock.mockReturnValue({
      canDelete: true,
      isResolving: false,
      isRemoteViewer: false,
      blockReason: null,
      controlDeviceName: null,
    })
  })

  it('有权限时渲染页底危险操作区与删除按钮', () => {
    render(<WorkspaceLifecycleMenu space={space} />)
    expect(screen.getByTestId('workspace-lifecycle-danger')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'actions.delete' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'actions.workspaceMenuLabel' })).toBeNull()
  })

  it('无权限时不渲染菜单', () => {
    canManageSpaceLifecycleMock.mockReturnValue(false)
    const { container } = render(<WorkspaceLifecycleMenu space={space} />)
    expect(container.childElementCount).toBe(0)
  })
})
