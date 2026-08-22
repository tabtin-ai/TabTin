import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authState: {} as Record<string, unknown>,
  organizationState: {} as Record<string, unknown>,
  updateProfile: vi.fn(),
  loadOrganizations: vi.fn(),
  selectOrganization: vi.fn(),
  respondToInvitation: vi.fn(),
  getInvitationInfo: vi.fn(),
  acceptInvitation: vi.fn(),
  callOrder: [] as string[],
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

type MockButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: string
  size?: string
}

vi.mock('@components/ui', () => ({
  Button: ({ children, type = 'button', variant: _variant, size: _size, ...props }: MockButtonProps) => (
    <button type={type} {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div role="dialog">{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}))

vi.mock('@stores/useAuthStore', () => ({
  selectIsAuthenticated: (state: Record<string, unknown>) => state.authPhase === 'authenticated',
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.authState),
}))

vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector(mocks.organizationState),
    {
      getState: () => mocks.organizationState,
      subscribe: vi.fn(() => vi.fn()),
    },
  )
  return { useOrganizationStore }
})

vi.mock('@/services/invitationApi', () => ({
  InvitationApiService: {
    respondToInvitation: mocks.respondToInvitation,
    getInvitationInfo: mocks.getInvitationInfo,
    acceptInvitation: mocks.acceptInvitation,
  },
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

import { InvitationAcceptDialog } from './InvitationAcceptDialog'
import { InvitationResponseDialog } from './InvitationResponseDialog'
import { validateInvitationNickname } from './InvitationNicknameField'

const pendingInvitation = {
  id: 'invitation-1',
  organization_id: 'organization-1',
  organization_name: '测试组织',
  organization_icon: '',
  invited_by: 'user-owner',
  invited_by_name: '组织 Owner',
  role: 'editor' as const,
  status: 'pending',
  expires_at: '2026-07-20T00:00:00Z',
  created_at: '2026-07-15T00:00:00Z',
}

describe('organization invitation nickname flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.callOrder.length = 0
    mocks.authState = {
      authPhase: 'authenticated',
      user: { id: 'user-1', username: 'alice', nickname: 'Alice' },
      updateProfile: mocks.updateProfile,
    }
    mocks.organizationState = {
      organizations: [],
      loadOrganizations: mocks.loadOrganizations,
      selectOrganization: mocks.selectOrganization,
    }
    mocks.updateProfile.mockImplementation(async () => {
      mocks.callOrder.push('profile')
    })
    mocks.respondToInvitation.mockImplementation(async () => {
      mocks.callOrder.push('respond')
    })
    mocks.getInvitationInfo.mockResolvedValue({
      valid: true,
      status: 'pending',
      organization_id: 'organization-1',
      organization_name: '测试组织',
      role: 'editor',
    })
    mocks.acceptInvitation.mockImplementation(async () => {
      mocks.callOrder.push('accept')
      return {
        organization_id: 'organization-1',
        organization_name: '测试组织',
        role: 'editor',
      }
    })
    mocks.loadOrganizations.mockResolvedValue(undefined)
    mocks.selectOrganization.mockResolvedValue(undefined)
  })

  it('uses the nickname length contract from profile updates', () => {
    expect(validateInvitationNickname('')).toBe('required')
    expect(validateInvitationNickname('a')).toBeNull()
    expect(validateInvitationNickname('中文昵称')).toBeNull()
    expect(validateInvitationNickname(` ${'a'.repeat(50)} `)).toBeNull()
    expect(validateInvitationNickname('a'.repeat(51))).toBe('length')
  })

  it('saves a changed nickname before accepting a pending invitation', async () => {
    render(
      <InvitationResponseDialog
        invitation={pendingInvitation}
        onClose={vi.fn()}
        onResponded={vi.fn()}
      />,
    )

    expect(screen.getByLabelText('invitation.nickname.label')).toHaveProperty('value', 'Alice')
    expect(screen.getByText('invitation.nickname.visibilityHint')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('invitation.nickname.label'), {
      target: { value: '  Alice Team  ' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'invitationResponse.accept' }))

    await waitFor(() => {
      expect(mocks.updateProfile).toHaveBeenCalledWith({ nickname: 'Alice Team' })
      expect(mocks.respondToInvitation).toHaveBeenCalledWith('invitation-1', true)
    })
    expect(mocks.callOrder).toEqual(['profile', 'respond'])
  })

  it('does not accept the invitation when nickname validation or saving fails', async () => {
    const { rerender } = render(
      <InvitationResponseDialog
        invitation={pendingInvitation}
        onClose={vi.fn()}
        onResponded={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('invitation.nickname.label'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'invitationResponse.accept' }))
    expect(screen.getByText('organization:invitation.nickname.errors.required')).toBeTruthy()
    expect(mocks.respondToInvitation).not.toHaveBeenCalled()

    mocks.updateProfile.mockRejectedValueOnce({ response: { data: { message: '昵称保存失败' } } })
    rerender(
      <InvitationResponseDialog
        invitation={pendingInvitation}
        onClose={vi.fn()}
        onResponded={vi.fn()}
      />,
    )
    fireEvent.change(screen.getByLabelText('invitation.nickname.label'), {
      target: { value: '新的昵称' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'invitationResponse.accept' }))

    await waitFor(() => {
      expect(screen.getByText('昵称保存失败')).toBeTruthy()
    })
    expect(mocks.respondToInvitation).not.toHaveBeenCalled()
  })

  it('also saves the nickname before accepting an invitation link', async () => {
    render(<InvitationAcceptDialog token="secret-invitation-token" onClose={vi.fn()} />)

    const nicknameInput = await screen.findByLabelText('invitation.nickname.label')
    fireEvent.change(nicknameInput, { target: { value: 'Alice Link' } })
    fireEvent.click(screen.getByRole('button', { name: 'invitation.accept.confirm' }))

    await waitFor(() => {
      expect(mocks.updateProfile).toHaveBeenCalledWith({ nickname: 'Alice Link' })
      expect(mocks.acceptInvitation).toHaveBeenCalledWith('secret-invitation-token')
    })
    expect(mocks.callOrder).toEqual(['profile', 'accept'])
  })

  it('shows already joined state as soon as an invitation link opens for an existing member', async () => {
    mocks.loadOrganizations.mockImplementation(async () => {
      mocks.organizationState = {
        ...mocks.organizationState,
        organizations: [
          {
            id: 'organization-1',
            name: '测试组织',
            type: 'team',
            owner_id: 'owner-1',
            is_default: false,
            created_at: '2026-07-01T00:00:00Z',
            updated_at: '2026-07-01T00:00:00Z',
          },
        ],
      }
    })

    render(<InvitationAcceptDialog token="secret-invitation-token" onClose={vi.fn()} />)

    expect(await screen.findByText('invitation.accept.alreadyMember')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'invitation.accept.confirm' })).toBeNull()
    expect(mocks.acceptInvitation).not.toHaveBeenCalled()
  })

  it('falls back to already joined state when accept returns already owner', async () => {
    mocks.acceptInvitation.mockRejectedValueOnce({
      response: {
        status: 400,
        data: {
          error_code: 'ALREADY_OWNER',
          message: '你已是组织所有者',
        },
      },
    })

    render(<InvitationAcceptDialog token="secret-invitation-token" onClose={vi.fn()} />)

    fireEvent.click(await screen.findByRole('button', { name: 'invitation.accept.confirm' }))

    expect(await screen.findByText('invitation.accept.alreadyMember')).toBeTruthy()
  })

  it('skips the profile request when the nickname is unchanged', async () => {
    render(
      <InvitationResponseDialog
        invitation={pendingInvitation}
        onClose={vi.fn()}
        onResponded={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'invitationResponse.accept' }))

    await waitFor(() => {
      expect(mocks.respondToInvitation).toHaveBeenCalledWith('invitation-1', true)
    })
    expect(mocks.updateProfile).not.toHaveBeenCalled()
    expect(mocks.callOrder).toEqual(['respond'])
  })
})
