import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { Organization } from '@tabtin/app-shell'

const invitation = {
  id: 'invite-1',
  organization_id: 'organization-1',
  invited_by: 'user-1',
  invite_type: 'link' as const,
  role: 'editor' as const,
  token: 'token-1234567890',
  status: 'pending',
  expires_at: '2026-06-18T00:00:00Z',
  max_uses: -1,
  use_count: 0,
  created_at: '2026-06-17T00:00:00Z',
}

const emailInvitation = {
  ...invitation,
  id: 'invite-email',
  invite_type: 'email' as const,
  email: 'person@example.com',
  token: 'email-token',
}

const directInvitation = {
  ...invitation,
  id: 'invite-direct',
  invite_type: 'direct' as const,
  invited_user_id: 'user-2',
  invited_user_nickname: '小明',
  invited_user_phone: '+8613800000002',
  token: 'direct-token',
}

const phoneInvitation = {
  ...invitation,
  id: 'invite-phone',
  invite_type: 'phone' as const,
  invited_user_id: 'user-3',
  invite_phone: '18800009999',
  token: 'phone-token',
}

const phoneInvitationWithNickname = {
  ...phoneInvitation,
  id: 'invite-phone-nick',
  invited_user_nickname: '小明',
  token: 'phone-nick-token',
}

const directInvitationWithNickname = {
  ...directInvitation,
  id: 'invite-direct-nick',
  invited_user_nickname: '进宝·Echo Bot',
  token: 'direct-nick-token',
}

const { cancelInvitation, listInvitations, invalidateQueries, memberRows, removeMember, toast } = vi.hoisted(() => ({
  cancelInvitation: vi.fn(),
  listInvitations: vi.fn(),
  invalidateQueries: vi.fn(),
  memberRows: [] as Array<Record<string, unknown>>,
  removeMember: vi.fn(),
  toast: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'members.pendingInvitations') return `Pending invitations (${options?.count})`
      if (key === 'members.linkInvitations') return `Invite links (${options?.count})`
      if (key === 'members.linkInvitationActive') return 'Active'
      if (key === 'members.linkInvitationUsed') return `${options?.count} joined`
      if (key === 'members.expiresAt') return `Expires ${options?.date}`
      if (key === 'members.directInvitationUnavailable') return 'Member information unavailable'
      if (key === 'members.directInvitation') return `User ID ${options?.userId}`
      if (key === 'members.phoneInvitation') return `Phone ${options?.phone}`
      if (key === 'members.roles.editor' || key === 'members.roleDescriptions.editor') return 'Editor'
      return key
    },
  }),
}))

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'owner-1' } }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: () => ({
    updateMemberRole: vi.fn(),
    removeMember,
  }),
}))

vi.mock('@stores/useNewUserOrganizationOnboardingStore', () => ({
  useNewUserOrganizationOnboardingStore: {
    getState: () => ({ step: 'agent_chat', goToStep: vi.fn() }),
  },
}))

vi.mock('@/hooks/useCanManageOrganization', () => ({
  canManageOrganization: () => true,
}))

vi.mock('@/hooks/queries/members', () => ({
  useMembersQuery: () => ({ data: { members: memberRows, total: memberRows.length }, isLoading: false }),
  memberKeys: {
    lists: (organizationId: string) => ['members', organizationId],
  },
}))

vi.mock('@/hooks/queries/memberBudget', () => ({
  useMemberBudgetPolicies: () => ({ data: undefined, isLoading: false }),
  useMemberUsageSummary: () => ({ data: undefined, isLoading: false }),
  useMutateMemberBudgetPolicy: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteMemberBudgetPolicy: () => ({ mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('@/services/memberBudgetApi', () => ({
  MemberBudgetApiService: {
    updateExemptRoles: vi.fn(),
    downloadExport: vi.fn(),
  },
}))

vi.mock('@/services/invitationApi', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/invitationApi')>()
  return {
    ...actual,
    InvitationApiService: {
      listInvitations,
      cancelInvitation,
    },
  }
})

vi.mock('@/config/api', () => ({
  buildPublicInviteUrl: (token: string) => `https://tabtin.example.com/invite/${token}`,
}))

vi.mock('@/utils/i18n/format', () => ({
  formatDate: (date: string) => date,
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('./InviteDialog', () => ({
  InviteDialog: () => <div>InviteDialog</div>,
}))

vi.mock('../SettingsInfoTooltip', () => ({
  SettingsInfoTooltip: () => null,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} {...props}>{children}</button>
  ),
  ConfirmDialog: () => null,
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div role="dialog">{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, ...props }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect} {...props}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  StatusNotice: ({ description }: { description: string }) => <div>{description}</div>,
  toast,
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, type = 'button', ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} {...props}>{children}</button>
  ),
  ConfirmDialog: ({ children, description, onConfirm, onOpenChange, open }: {
    children?: React.ReactNode
    description?: string
    onConfirm: () => void | Promise<void>
    onOpenChange: (open: boolean) => void
    open: boolean
  }) => open ? (
    <div role="dialog">
      <p>{description}</p>
      {children}
      <button
        type="button"
        onClick={() => {
          void Promise.resolve(onConfirm()).then(() => onOpenChange(false)).catch(() => undefined)
        }}
      >confirm removal</button>
    </div>
  ) : null,
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div role="dialog">{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect, ...props }: { children: React.ReactNode; onSelect?: () => void }) => (
    <button type="button" onClick={onSelect} {...props}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Progress: (props: React.HTMLAttributes<HTMLDivElement>) => <div role="progressbar" {...props} />,
  ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Select: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectValue: () => null,
  StatusNotice: ({ description }: { description: string }) => <div>{description}</div>,
  Switch: () => null,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  toast,
}))

import { OrganizationMembersPanel } from './OrganizationMembersPanel'

describe('OrganizationMembersPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    memberRows.splice(0)
    listInvitations.mockResolvedValue([invitation])
    cancelInvitation.mockResolvedValue(undefined)
    removeMember.mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    })
  })

  it('keeps the removal dialog open and shows the backend error in place', async () => {
    memberRows.push({
      user_id: 'member-1',
      role: 'editor',
      joined_at: '2026-08-06T00:00:00Z',
      user: { nickname: 'xxxx', phone: '15557201976' },
    })
    removeMember.mockRejectedValueOnce(new Error('消息权限撤销失败，成员尚未移除，请重试'))

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    fireEvent.click(screen.getByText('members.actions.remove'))
    fireEvent.click(screen.getByText('confirm removal'))

    await waitFor(() => {
      expect(removeMember).toHaveBeenCalledWith('organization-1', 'member-1')
      expect(screen.getByRole('dialog').textContent).toContain('消息权限撤销失败，成员尚未移除，请重试')
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('members.removeProgress.failed')).toBeTruthy()
  })

  it('opens a generated link invitation record and copies the invite link', async () => {
    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    const linkInvitation = await screen.findByText('members.linkInvitation')
    expect(screen.getByText('Invite links (1)')).toBeTruthy()
    expect(screen.getByText('Active')).toBeTruthy()
    expect(screen.queryByText('Pending invitations (1)')).toBeNull()

    fireEvent.click(linkInvitation)

    expect(screen.getByRole('dialog').textContent).toContain('https://tabtin.example.com/invite/token-1234567890')

    fireEvent.click(screen.getByLabelText('members.copyLinkInvitation'))

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('https://tabtin.example.com/invite/token-1234567890')
    })
    expect(toast).toHaveBeenCalledWith({ title: 'members.linkInvitationCopied' })
  })

  it('does not open email or direct invitations as link records', async () => {
    listInvitations.mockResolvedValue([emailInvitation, directInvitation])

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    fireEvent.click(await screen.findByText('person@example.com'))
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(await screen.findByText('User ID user-2'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('shows phone invitations by phone number and id invitations by user id', async () => {
    listInvitations.mockResolvedValue([phoneInvitation, directInvitation])

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    expect(await screen.findByText('Phone 18800009999')).toBeTruthy()
    expect(screen.getByText('User ID user-2')).toBeTruthy()
    expect(screen.queryByText('User ID user-3')).toBeNull()
  })

  it('旧服务端未提供身份资料时不展示直接邀请用户 UUID', async () => {
    listInvitations.mockResolvedValue([
      {
        ...directInvitation,
        invited_user_id: undefined,
        invited_user_nickname: undefined,
        invited_user_phone: undefined,
      },
    ])

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    expect(await screen.findByText('Member information unavailable')).toBeTruthy()
    expect(screen.queryByText('user-2')).toBeNull()
  })

  it('#8704: shows invitee nickname with phone/user-id channel labels', async () => {
    listInvitations.mockResolvedValue([phoneInvitationWithNickname, directInvitationWithNickname])

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    expect(await screen.findByText('小明')).toBeTruthy()
    expect(screen.getByText('进宝·Echo Bot')).toBeTruthy()
    expect(screen.getByText('Phone 18800009999')).toBeTruthy()
    expect(screen.getByText('User ID user-2')).toBeTruthy()
  })

  it('shows used invite links separately from pending targeted invitations', async () => {
    listInvitations.mockResolvedValue([
      { ...invitation, use_count: 1 },
      emailInvitation,
    ])

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    expect(await screen.findByText('Invite links (1)')).toBeTruthy()
    expect(screen.getByText('1 joined')).toBeTruthy()
    expect(screen.getByText('Pending invitations (1)')).toBeTruthy()
    expect(screen.getByText('person@example.com')).toBeTruthy()
  })

  it('cancels a link invitation without opening the link dialog', async () => {
    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    await screen.findByText('members.linkInvitation')
    fireEvent.click(screen.getByLabelText('members.actions.cancelInvitation'))

    await waitFor(() => {
      expect(cancelInvitation).toHaveBeenCalledWith('organization-1', 'invite-1')
    })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('#6261: organization-invitations-changed 通知到达后重拉待处理邀请', async () => {
    listInvitations
      .mockResolvedValueOnce([directInvitation])
      .mockResolvedValueOnce([])

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    expect(await screen.findByText('Pending invitations (1)')).toBeTruthy()
    expect(screen.getByText('小明')).toBeTruthy()
    expect(screen.getByText('User ID user-2')).toBeTruthy()
    expect(screen.queryByText('user-2')).toBeNull()
    expect(listInvitations).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
        detail: { organizationId: 'organization-1', invitationId: 'invite-direct' },
      }))
    })

    await waitFor(() => {
      expect(listInvitations).toHaveBeenCalledTimes(2)
    })
    await waitFor(() => {
      expect(screen.queryByText('Pending invitations (1)')).toBeNull()
      expect(screen.queryByText('小明')).toBeNull()
      expect(screen.queryByText('User ID user-2')).toBeNull()
    })
  })

  it('#6261: 其它组织的 invitations-changed 不触发当前面板重拉', async () => {
    listInvitations.mockResolvedValue([directInvitation])

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    expect(await screen.findByText('Pending invitations (1)')).toBeTruthy()
    expect(listInvitations).toHaveBeenCalledTimes(1)

    await act(async () => {
      window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
        detail: { organizationId: 'organization-other', invitationId: 'invite-x' },
      }))
      await Promise.resolve()
    })

    expect(listInvitations).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Pending invitations (1)')).toBeTruthy()
  })

  it('#6261: listInvitations 乱序返回时不写回陈旧 pending', async () => {
    let resolveMount!: (value: typeof directInvitation[]) => void
    let resolveRefresh!: (value: typeof directInvitation[]) => void
    listInvitations
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveMount = resolve
        }),
      )
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          resolveRefresh = resolve
        }),
      )

    render(
      <OrganizationMembersPanel
        organization={{
          id: 'organization-1',
          name: 'Team',
          owner_id: 'owner-1',
          type: 'team',
        } as Organization}
        currentUserRole="owner"
      />,
    )

    await waitFor(() => {
      expect(listInvitations).toHaveBeenCalledTimes(1)
    })

    await act(async () => {
      window.dispatchEvent(new CustomEvent('tabtin:organization-invitations-changed', {
        detail: { organizationId: 'organization-1', invitationId: 'invite-direct' },
      }))
    })

    await waitFor(() => {
      expect(listInvitations).toHaveBeenCalledTimes(2)
    })

    // 后发起的刷新先返回空列表（已接受）；挂载请求晚到仍带 pending
    await act(async () => {
      resolveRefresh([])
    })
    await act(async () => {
      resolveMount([directInvitation])
    })

    await waitFor(() => {
      expect(screen.queryByText('Pending invitations (1)')).toBeNull()
      expect(screen.queryByText('小明')).toBeNull()
      expect(screen.queryByText('User ID user-2')).toBeNull()
    })
  })
})
