import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const {
  createDirectInvitation,
  createEmailInvitation,
  createLinkInvitation,
  createPhoneInvitation,
  toast,
} = vi.hoisted(() => ({
  createDirectInvitation: vi.fn(),
  createEmailInvitation: vi.fn(),
  createLinkInvitation: vi.fn(),
  createPhoneInvitation: vi.fn(),
  toast: vi.fn(),
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

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, type = 'button', variant: _variant, size: _size, ...props }: MockButtonProps) => (
    <button type={type} {...props}>{children}</button>
  ),
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => (
    open ? <div role="dialog">{children}</div> : null
  ),
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  toast,
}))

vi.mock('@services/invitationApi', () => ({
  InvitationApiService: {
    createDirectInvitation,
    createEmailInvitation,
    createLinkInvitation,
    createPhoneInvitation,
  },
}))

vi.mock('@/config/api', () => ({
  buildPublicInviteUrl: (token: string) => `https://tabtin.example.com/invite/${token}`,
}))

vi.mock('@tabtin/app-shell', () => ({
  UI_ASSIGNABLE_ROLES: ['editor'],
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('@/lib/billingErrorHandler', () => ({
  isBillingErrorCode: vi.fn(() => false),
  showBillingErrorToast: vi.fn(),
}))

import { InviteDialog } from './InviteDialog'

describe('InviteDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    createDirectInvitation.mockResolvedValue({ token: 'direct-token' })
    createLinkInvitation.mockResolvedValue({ token: 'link-token-1234567890' })
    createPhoneInvitation.mockResolvedValue({ token: 'phone-token' })
  })

  it('隐藏邮件邀请入口，并默认展示手机号邀请', () => {
    render(<InviteDialog organizationId="organization-1" onClose={vi.fn()} />)

    expect(screen.queryByText('invite.emailTab')).toBeNull()
    expect(screen.queryByText('invite.emailLabel')).toBeNull()
    expect(screen.queryByPlaceholderText('invite.emailPlaceholder')).toBeNull()

    expect(screen.getByText('invite.phoneTab')).toBeTruthy()
    expect(screen.getByText('invite.linkTab')).toBeTruthy()
    expect(screen.getByText('invite.userIdTab')).toBeTruthy()
    expect(screen.getByText('invite.phoneLabel')).toBeTruthy()
  })

  it('保留手机号邀请提交路径，且不调用邮件邀请 API', async () => {
    render(<InviteDialog organizationId="organization-1" onClose={vi.fn()} />)

    fireEvent.change(screen.getByPlaceholderText('invite.phonePlaceholder'), {
      target: { value: '+8613800138000' },
    })
    fireEvent.click(screen.getByText('invite.sendInvite'))

    await waitFor(() => {
      expect(createPhoneInvitation).toHaveBeenCalledWith('organization-1', '+8613800138000', 'editor')
    })
    expect(createEmailInvitation).not.toHaveBeenCalled()
  })

  it('保留邀请链接和用户 ID 邀请入口', async () => {
    const onClose = vi.fn()
    render(<InviteDialog organizationId="organization-1" onClose={onClose} />)

    fireEvent.click(screen.getByText('invite.linkTab'))
    fireEvent.click(screen.getByText('invite.generateLink'))
    await waitFor(() => {
      expect(createLinkInvitation).toHaveBeenCalledWith('organization-1', 'editor')
    })
    expect(screen.getByText('https://tabtin.example.com/invite/link-token-1234567890')).toBeTruthy()

    fireEvent.click(screen.getByText('invite.userIdTab'))
    fireEvent.change(screen.getByPlaceholderText('invite.userIdPlaceholder'), {
      target: { value: 'user-123' },
    })
    fireEvent.click(screen.getByText('invite.sendInvite'))
    await waitFor(() => {
      expect(createDirectInvitation).toHaveBeenCalledWith('organization-1', 'user-123', 'editor')
    })
    expect(createEmailInvitation).not.toHaveBeenCalled()
  })
})
