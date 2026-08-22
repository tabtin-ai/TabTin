import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const setRoute = vi.fn()
const prefetchSettingsPanel = vi.fn()

vi.mock('@components/settings/settingsPanelPrefetch', () => ({
  prefetchSettingsPanel: (...args: unknown[]) => prefetchSettingsPanel(...args),
}))

vi.mock('zustand/react/shallow', () => ({ useShallow: (fn: unknown) => fn }))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@components/settings/settingsNavigation', () => {
  const Icon = () => <svg aria-hidden="true" />
  return {
    SETTINGS_SIDEBAR_GROUPS: [
      {
        category: 'profile',
        subgroups: [
          {
            labelKey: null,
            items: [
              { category: 'profile', section: 'account', icon: Icon, labelKey: 'sections.accountGroup' },
            ],
          },
        ],
      },
      {
        category: 'organization',
        subgroups: [
          {
            labelKey: null,
            items: [
              { category: 'organization', section: 'team', icon: Icon, labelKey: 'sections.teamGroup' },
              { category: 'organization', section: 'services', icon: Icon, labelKey: 'sections.organizationServices' },
            ],
          },
        ],
      },
      {
        category: 'device',
        subgroups: [
          {
            labelKey: null,
            items: [
              { category: 'device', section: 'deviceGroup', icon: Icon, labelKey: 'sections.deviceGroup' },
            ],
          },
        ],
      },
    ],
  }
})

vi.mock('@components/settings/settingsGroupConfig', () => ({
  SECTION_PARENT_MAP: {},
  PROFILE_SECTION_PARENT_MAP: {},
  DEVICE_SECTION_PARENT_MAP: {},
}))

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (s: unknown) => unknown) =>
    selector({
      activeRoute: { category: 'profile', section: 'account' },
      setRoute,
    }),
}))

const organizationStoreState = {
  selectedOrganization: { id: 'wt-1', name: 'Team', type: 'team', owner_id: 'user-owner' } as Record<string, unknown>,
  currentUserRole: 'owner' as string | null,
}

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: unknown) => unknown) => selector(organizationStoreState),
}))

const authStoreState = {
  user: { id: 'user-owner', username: 'user_4659', nickname: 'user_4659' } as Record<string, unknown>,
}

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: unknown) => unknown) => selector(authStoreState),
}))

vi.mock('@stores/useNewUserOrganizationOnboardingStore', () => ({
  useNewUserOrganizationOnboardingStore: () => 'idle',
}))

vi.mock('@components/organization/CreateOrganizationDialog', () => ({
  CreateOrganizationDialog: () => null,
}))

vi.mock('@components/settings/SettingsTeamSwitcher', () => ({
  SettingsTeamSwitcher: () => <div data-testid="settings-team-switcher" />,
}))

function resetStores() {
  organizationStoreState.selectedOrganization = { id: 'wt-1', name: 'Team', type: 'team', owner_id: 'user-owner' }
  organizationStoreState.currentUserRole = 'owner'
  authStoreState.user = { id: 'user-owner', username: 'user_4659', nickname: 'user_4659' }
}

describe('SidebarMePanel ', () => {
  beforeEach(() => {
    setRoute.mockClear()
    prefetchSettingsPanel.mockClear()
    resetStores()
  })

  it('设置页菜单项占满所在行的可用宽度', async () => {
    const { SidebarMePanel } = await import('./SidebarMePanel')

    render(<SidebarMePanel />)

    for (const label of ['sections.accountGroup', 'sections.teamGroup', 'sections.deviceGroup']) {
      expect(screen.getByRole('button', { name: label }).className)
        .toContain('w-[calc(100%-0.75rem)]')
    }
  })

  it('hover 或 focus 时预加载对应设置 panel chunk', async () => {
    const { SidebarMePanel } = await import('./SidebarMePanel')

    render(<SidebarMePanel />)

    const accountButton = screen.getByRole('button', { name: 'sections.accountGroup' })
    fireEvent.mouseEnter(accountButton)
    expect(prefetchSettingsPanel).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'profile', section: 'account' }),
    )

    prefetchSettingsPanel.mockClear()
    fireEvent.focus(accountButton)
    expect(prefetchSettingsPanel).toHaveBeenCalledWith(
      expect.objectContaining({ category: 'profile', section: 'account' }),
    )
  })

  it('设置侧栏不再展示顶部返回按钮', async () => {
    const { SidebarMePanel } = await import('./SidebarMePanel')

    render(<SidebarMePanel />)

    expect(screen.queryByRole('button', { name: '返回' })).toBeNull()
  })
})

describe('SidebarMePanel AI 服务开关入口', () => {
  beforeEach(() => {
    resetStores()
  })

  it('owner 能看到「AI 成本」菜单', async () => {
    const { SidebarMePanel } = await import('./SidebarMePanel')

    render(<SidebarMePanel />)

    expect(screen.getByRole('button', { name: 'sections.organizationServices' })).toBeTruthy()
  })

  it('editor 可以进入「AI 服务开关」查看团队自动记忆设置', async () => {
    organizationStoreState.currentUserRole = 'editor'
    authStoreState.user = { id: 'user-editor', username: 'user_editor', nickname: 'user_editor' }
    const { SidebarMePanel } = await import('./SidebarMePanel')

    render(<SidebarMePanel />)

    expect(screen.getByRole('button', { name: 'sections.organizationServices' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'sections.teamGroup' })).toBeTruthy()
  })

  it('切组织瞬间 role 未拉到时，owner 按 owner_id 回退判定，菜单不闪烁', async () => {
    organizationStoreState.currentUserRole = null
    const { SidebarMePanel } = await import('./SidebarMePanel')

    render(<SidebarMePanel />)

    expect(screen.getByRole('button', { name: 'sections.organizationServices' })).toBeTruthy()
  })

  it('role 未拉到且不是 owner_id 本人时仍显示可读入口', async () => {
    organizationStoreState.currentUserRole = null
    authStoreState.user = { id: 'user-editor', username: 'user_editor', nickname: 'user_editor' }
    const { SidebarMePanel } = await import('./SidebarMePanel')

    render(<SidebarMePanel />)

    expect(screen.getByRole('button', { name: 'sections.organizationServices' })).toBeTruthy()
  })
})
