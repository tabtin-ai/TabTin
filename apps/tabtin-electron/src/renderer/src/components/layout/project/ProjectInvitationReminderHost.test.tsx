import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, waitFor } from '@testing-library/react'

import { PROJECT_INVITATION_RECEIVED_EVENT } from './PendingProjectInvitations'
import { ProjectInvitationReminderHost } from './ProjectInvitationReminderHost'

const toast = vi.fn()
const refresh = vi.fn()
const clear = vi.fn()
const openCollaborationFromInvite = vi.fn()

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: (...args: unknown[]) => toast(...args),
  ToastAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@stores/useAuthStore', () => ({
  selectIsAuthenticated: (state: { isAuthenticated: boolean }) => state.isAuthenticated,
  useAuthStore: (selector: (state: { isAuthenticated: boolean; user: { id: string } | null }) => unknown) =>
    selector({ isAuthenticated: true, user: { id: 'user-1' } }),
}))

vi.mock('@stores/usePendingProjectInvitationStore', () => ({
  usePendingProjectInvitationStore: (selector: (state: {
    refresh: () => Promise<unknown[]>
    clear: () => void
  }) => unknown) => selector({ refresh, clear }),
}))

vi.mock('./openCollaborationFromInvite', () => ({
  openCollaborationFromInvite: (...args: unknown[]) => openCollaborationFromInvite(...args),
}))

describe('ProjectInvitationReminderHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    refresh.mockResolvedValue([])
  })

  it('收到非 sync 的 Project 邀请事件时弹 Toast', async () => {
    render(<ProjectInvitationReminderHost />)

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled()
    })

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PROJECT_INVITATION_RECEIVED_EVENT, {
        detail: {
          projectId: 'p-1',
          organizationId: 'org-1',
          isSync: false,
        },
      }))
    })

    await waitFor(() => {
      expect(toast).toHaveBeenCalled()
    })
    expect(toast.mock.calls[0]?.[0]?.title).toBe('收到 Project 邀请')
  })

  it('sync 事件只刷新不弹 Toast', async () => {
    render(<ProjectInvitationReminderHost />)

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PROJECT_INVITATION_RECEIVED_EVENT, {
        detail: { isSync: true },
      }))
    })

    await waitFor(() => {
      expect(refresh).toHaveBeenCalledTimes(2)
    })
    expect(toast).not.toHaveBeenCalled()
  })
})
