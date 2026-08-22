import React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}))

vi.mock('../SettingsPanelHeader', () => ({
  SettingsPanelHeader: () => null,
}))

vi.mock('../SettingsPanelLayout', () => ({
  SettingsPanelLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('./OrganizationSettingsPanel', () => ({
  OrganizationSettingsPanel: ({ children }: { children: React.ReactNode }) => (
    <>
      {React.Children.map(children, (child) => {
        if (!React.isValidElement(child)) return child
        return React.cloneElement(
          child as React.ReactElement<{
            isOwner?: boolean
            onOpenCashRecharge?: () => void
          }>,
          {
            isOwner: true,
            onOpenCashRecharge: vi.fn(),
          },
        )
      })}
    </>
  ),
}))

vi.mock('./OrganizationMembershipPanel', () => ({
  OrganizationMembershipPanel: ({
    isOwner,
    onOpenCashRecharge,
  }: {
    isOwner?: boolean
    onOpenCashRecharge?: () => void
  }) => (
    isOwner && onOpenCashRecharge
      ? <button type="button">充值</button>
      : null
  ),
}))

import { TeamComposite } from './SettingsGroupComposites'

describe('TeamComposite', () => {
  it('keeps the owner cash recharge action across the lazy boundary', async () => {
    render(
      <TeamComposite
        organization={{
          id: 'org-1',
          name: '测试组织',
          owner_id: 'owner-1',
          type: 'team',
        }}
        canManageOrganization
      />,
    )

    expect(await screen.findByRole('button', { name: '充值' })).not.toBeNull()
  })
})
