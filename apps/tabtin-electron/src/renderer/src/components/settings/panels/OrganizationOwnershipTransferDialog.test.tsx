import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OrganizationMember } from '@tabtin/app-shell'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; name?: string }) =>
      options?.defaultValue?.replace('{{name}}', options.name ?? '') ?? key,
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
  DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  StatusNotice: ({ description }: { description: string }) => <div role="alert">{description}</div>,
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

import { OrganizationOwnershipTransferDialog } from './OrganizationOwnershipTransferDialog'

const members = [
  {
    id: 'membership-owner',
    organization_id: 'organization-1',
    user_id: 'user-owner',
    role: 'owner',
    joined_at: '2026-07-13T00:00:00Z',
    user: { nickname: '原所有者' },
  },
  {
    id: 'membership-editor',
    organization_id: 'organization-1',
    user_id: 'user-editor',
    role: 'editor',
    joined_at: '2026-07-13T00:00:00Z',
    user: { nickname: '候选成员', email: 'candidate@example.com' },
  },
] satisfies OrganizationMember[]

describe('OrganizationOwnershipTransferDialog', () => {
  it('只允许从现有非 Owner 成员中选择，并提交成员 user_id', () => {
    const onConfirm = vi.fn()

    render(
      <OrganizationOwnershipTransferDialog
        open
        organizationName="测试组织"
        currentOwnerId="user-owner"
        members={members}
        isLoading={false}
        error=""
        onOpenChange={vi.fn()}
        onConfirm={onConfirm}
      />,
    )

    expect(screen.queryByText('原所有者')).toBeNull()
    expect(screen.getByText('候选成员')).toBeTruthy()

    const confirmButton = screen.getByRole('button', { name: '确认转让' })
    expect(confirmButton).toHaveProperty('disabled', true)

    fireEvent.click(screen.getByRole('radio', { name: /候选成员/ }))
    expect(confirmButton).toHaveProperty('disabled', false)

    fireEvent.click(confirmButton)
    expect(onConfirm).toHaveBeenCalledWith('user-editor')
  })

  it('没有其他现有成员时禁止转让并给出引导', () => {
    render(
      <OrganizationOwnershipTransferDialog
        open
        organizationName="测试组织"
        currentOwnerId="user-owner"
        members={[members[0]]}
        isLoading={false}
        error=""
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    expect(screen.getByText('暂无可转让成员，请先邀请成员加入组织。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '确认转让' })).toHaveProperty('disabled', true)
  })

  it('组织数量达到上限时指出当前选中的成员，不暴露技术错误码', () => {
    render(
      <OrganizationOwnershipTransferDialog
        open
        organizationName="测试组织"
        currentOwnerId="user-owner"
        members={members}
        isLoading={false}
        error="ORGANIZATION_LIMIT_EXCEEDED: 每个用户最多可创建 3 个组织，当前已达到上限"
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: /候选成员/ }))

    expect(screen.getByRole('alert').textContent).toBe('候选成员 的组织数量已达上限')
    expect(screen.queryByText(/ORGANIZATION_LIMIT_EXCEEDED/)).toBeNull()
  })
})
