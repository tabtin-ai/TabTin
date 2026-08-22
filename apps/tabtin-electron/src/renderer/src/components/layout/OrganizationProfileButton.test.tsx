import React from 'react'
import { fireEvent, render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}))

const openSettings = vi.fn()

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({
    user: { id: 'user-1', nickname: 'Alice', username: 'alice', avatar: '' },
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: unknown) => unknown) => selector({
    organizations: [],
    selectedOrganization: {
      id: 'org-1',
      name: '募范科技',
      type: 'team',
      settings: { logo_url: '' },
    },
    selectOrganization: vi.fn(),
  }),
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: {
    getState: () => ({
      openSettings,
    }),
  },
}))

vi.mock('@components/organization/CreateOrganizationDialog', () => ({
  CreateOrganizationDialog: () => null,
}))

import {
  OrganizationAvatarRailButton,
  OrganizationProfileButton,
  TopBarOrganizationSwitcher,
  UserAvatarRailButton,
} from './OrganizationProfileButton'

describe('OrganizationProfileButton avatar', () => {
  it('uses the canonical initial avatar when the user has no image', () => {
    const { container } = render(<OrganizationProfileButton />)
    const avatar = container.querySelector('[title="Alice"]')

    expect(avatar).not.toBeNull()
    // identityAvatarInitial 统一为单字符首字母（identity: unify fallback avatars）
    expect(avatar?.textContent).toBe('A')
    expect(avatar?.className).toContain('rounded-full')
  })
})

describe('TopBarOrganizationSwitcher', () => {
  it('renders current organization label with team onboarding target', () => {
    const { getByTestId } = render(<TopBarOrganizationSwitcher />)
    const button = getByTestId('shell-top-bar-organization-switcher')

    expect(button.textContent).toContain('募范科技')
    expect(button.querySelector('svg')).not.toBeNull()
    expect(button.getAttribute('data-onboarding-target')).toBe('new-user-organization-team-switcher')
  })
})

describe('OrganizationAvatarRailButton', () => {
  it('reuses UserAvatar algorithm and opens organization settings anchor', () => {
    openSettings.mockClear()
    const { getByTestId, container } = render(<OrganizationAvatarRailButton />)
    const button = getByTestId('activity-rail-organization-avatar')
    const avatar = container.querySelector('[title="募范科技"]')

    expect(button.getAttribute('data-onboarding-target')).toBe('new-user-organization-team-entry')
    expect(button.getAttribute('aria-label')).toContain('组织资料')
    expect(avatar).not.toBeNull()
    expect(avatar?.textContent).toBe('募')
    expect(avatar?.className).toContain('rounded-[8px]')

    fireEvent.click(button)
    expect(openSettings).toHaveBeenCalledWith({ category: 'organization', section: 'team' })
  })
})

describe('UserAvatarRailButton', () => {
  it('renders rail avatar with me onboarding target and opens 个人资料 anchor', () => {
    openSettings.mockClear()
    const { getByTestId } = render(<UserAvatarRailButton />)
    const button = getByTestId('activity-rail-user-avatar')

    expect(button.getAttribute('data-onboarding-target')).toBe('new-user-organization-me-entry')
    expect(button.getAttribute('aria-label')).toBe('个人资料')

    fireEvent.click(button)
    expect(openSettings).toHaveBeenCalledWith({ category: 'profile', section: 'account' })
  })
})
