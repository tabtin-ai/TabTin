import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'

import type { PendingProjectInvitation } from '@/types/project'
import { usePendingProjectInvitationStore } from '@stores/usePendingProjectInvitationStore'
import {
  PendingProjectInvitations,
  PROJECT_INVITATION_RECEIVED_EVENT,
} from './PendingProjectInvitations'

const listMyPendingInvitations = vi.fn()

vi.mock('@/services/projectApi', () => ({
  ProjectApiService: {
    listMyPendingInvitations: (...args: unknown[]) => listMyPendingInvitations(...args),
  },
}))

vi.mock('@/services/provisionProjectWorkspace', () => ({
  provisionProjectCompanionWorkspace: vi.fn(),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      loadSpaces: vi.fn(),
    }),
  },
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
  toast: vi.fn(),
}))

describe('PendingProjectInvitations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listMyPendingInvitations.mockResolvedValue([])
    usePendingProjectInvitationStore.setState({ invitations: [], isLoading: false })
  })

  it('挂载时拉取当前组织的待接受邀请', async () => {
    listMyPendingInvitations.mockResolvedValue([
      {
        project_id: 'p-1',
        project_name: '团建',
        organization_id: 'org-1',
        inviter_name: '主人',
        role: 'editor',
      },
      {
        project_id: 'p-other',
        project_name: '别的组织项目',
        organization_id: 'org-2',
        inviter_name: '别人',
        role: 'editor',
      },
    ])

    render(
      <PendingProjectInvitations
        organizationId="org-1"
        organizationName="双人组织"
        onAccepted={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText('团建')).not.toBeNull()
    })
    expect(screen.queryByText('别的组织项目')).toBeNull()
    expect(listMyPendingInvitations).toHaveBeenCalledTimes(1)
  })

  it('组织切换后忽略旧组织的慢请求', async () => {
    let resolveOldRequest: ((value: PendingProjectInvitation[]) => void) | undefined
    const oldRequest = new Promise<PendingProjectInvitation[]>(resolve => {
      resolveOldRequest = resolve
    })
    listMyPendingInvitations
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce([{
        project_id: 'p-new',
        project_name: '新组织项目',
        organization_id: 'org-2',
        inviter_name: '新同事',
        role: 'editor',
      }])
    const { rerender } = render(
      <PendingProjectInvitations organizationId="org-1" organizationName="组织一" onAccepted={vi.fn()} />,
    )

    rerender(
      <PendingProjectInvitations organizationId="org-2" organizationName="组织二" onAccepted={vi.fn()} />,
    )
    await waitFor(() => expect(screen.getByText('新组织项目')).not.toBeNull())

    await act(async () => {
      resolveOldRequest?.([{
        project_id: 'p-old',
        project_name: '旧组织项目',
        organization_id: 'org-1',
        inviter_name: '旧同事',
        role: 'editor',
      }])
    })

    expect(screen.getByText('新组织项目')).not.toBeNull()
    expect(screen.queryByText('旧组织项目')).toBeNull()
  })

  it('#6355: 收到同组织 project-invitation 事件后重拉列表', async () => {
    listMyPendingInvitations
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          project_id: 'p-1',
          project_name: '团建',
          organization_id: 'org-1',
          inviter_name: '主人',
          role: 'editor',
        },
      ])

    render(
      <PendingProjectInvitations
        organizationId="org-1"
        organizationName="双人组织"
        onAccepted={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(listMyPendingInvitations).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByText('团建')).toBeNull()

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
      expect(listMyPendingInvitations).toHaveBeenCalledTimes(2)
      expect(screen.getByText('团建')).not.toBeNull()
    })
  })

  it('#6355: 其它组织的邀请事件不触发重拉', async () => {
    render(
      <PendingProjectInvitations
        organizationId="org-1"
        organizationName="双人组织"
        onAccepted={vi.fn()}
      />,
    )

    await waitFor(() => {
      expect(listMyPendingInvitations).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      window.dispatchEvent(new CustomEvent(PROJECT_INVITATION_RECEIVED_EVENT, {
        detail: {
          projectId: 'p-other',
          organizationId: 'org-2',
          isSync: false,
        },
      }))
    })

    expect(listMyPendingInvitations).toHaveBeenCalledTimes(1)
  })
})
