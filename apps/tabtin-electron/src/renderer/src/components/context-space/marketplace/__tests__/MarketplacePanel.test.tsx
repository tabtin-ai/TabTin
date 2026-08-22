import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const mockOpenAppHome = vi.fn()
const mockSkillMarketplace = vi.fn((props: {
  canInstall?: boolean
  installDisabledReason?: string
  onManageInstalled?: (skill: { skill_key: string }) => void
}) => (
  <div
    data-testid="skill-marketplace"
    data-can-install={String(props.canInstall)}
    data-disabled-reason={props.installDisabledReason ?? ''}
  >
    <button
      type="button"
      onClick={() => props.onManageInstalled?.({ skill_key: 'app:office-pack/customer-followup-brief' })}
    >
      manage-installed
    </button>
  </div>
))
const mockAppMarketplacePanel = vi.fn((props: {
  organization: { id: string; name: string }
  canManageOrganization?: boolean
  showHeader?: boolean
  fillContainer?: boolean
  className?: string
}) => (
  <div
    data-testid="app-marketplace-panel"
    data-organization-id={props.organization.id}
    data-can-manage={String(props.canManageOrganization)}
    data-show-header={String(props.showHeader)}
    data-fill-container={String(props.fillContainer)}
    data-class-name={props.className ?? ''}
  >
    app-marketplace
  </div>
))

let mockSpaces = [
  { id: 'space-1', name: '默认 Space', organization_id: 'wt-1' },
]
let mockOrganizations = [
  { id: 'wt-1', name: '团队一', owner_id: 'user-owner', type: 'team' },
]
let mockSelectedOrganization: { id: string; name: string; owner_id: string; type: string } | null = mockOrganizations[0]!
let mockCurrentUserRole: string | null = 'owner'
let mockUser = { id: 'user-owner' }

vi.mock('@tabtin/smartsheet-ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (
      params?.name ? `${key}:${params.name}` : key
    ),
  }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { spaces: typeof mockSpaces }) => unknown) =>
    selector({ spaces: mockSpaces }),
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: {
    organizations: typeof mockOrganizations
    selectedOrganization: typeof mockSelectedOrganization
    currentUserRole: typeof mockCurrentUserRole
  }) => unknown) => selector({
    organizations: mockOrganizations,
    selectedOrganization: mockSelectedOrganization,
    currentUserRole: mockCurrentUserRole,
  }),
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: typeof mockUser }) => unknown) =>
    selector({ user: mockUser }),
}))

vi.mock('@components/context-space/SpaceContextAreaContext', () => ({
  useSpaceContextActions: () => ({ onOpenAppHome: mockOpenAppHome }),
}))

vi.mock('../../skills/SkillMarketplace', () => ({
  SkillMarketplace: (props: Parameters<typeof mockSkillMarketplace>[0]) => mockSkillMarketplace(props),
}))

vi.mock('@components/settings/panels/AppMarketplacePanel', () => ({
  AppMarketplacePanel: (props: Parameters<typeof mockAppMarketplacePanel>[0]) =>
    mockAppMarketplacePanel(props),
}))

vi.mock('@utils/cn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

beforeEach(() => {
  vi.clearAllMocks()
  mockSpaces = [{ id: 'space-1', name: '默认 Space', organization_id: 'wt-1' }]
  mockOrganizations = [{ id: 'wt-1', name: '团队一', owner_id: 'user-owner', type: 'team' }]
  mockSelectedOrganization = mockOrganizations[0]!
  mockCurrentUserRole = 'owner'
  mockUser = { id: 'user-owner' }
})

afterEach(() => {
  cleanup()
})

describe('MarketplacePanel', () => {
  it('passes install permission to SkillMarketplace for the current Space organization', async () => {
    const { MarketplacePanel } = await import('../MarketplacePanel')
    render(<MarketplacePanel spaceId="space-1" />)

    expect(screen.getByTestId('skill-marketplace').dataset.canInstall).toBe('true')

    fireEvent.click(screen.getByText('manage-installed'))
    expect(mockOpenAppHome).toHaveBeenCalledWith(
      'skill',
      expect.objectContaining({
        skillKey: 'app:office-pack/customer-followup-brief',
        focusAt: expect.any(Number),
      }),
    )
  })

  it('does not reuse selected organization role when the target Space belongs to another organization', async () => {
    mockSpaces = [{ id: 'space-1', name: '默认 Space', organization_id: 'wt-2' }]
    mockOrganizations = [
      { id: 'wt-1', name: '团队一', owner_id: 'user-owner', type: 'team' },
      { id: 'wt-2', name: '团队二', owner_id: 'other-owner', type: 'team' },
    ]
    mockSelectedOrganization = mockOrganizations[0]!
    mockCurrentUserRole = 'owner'
    mockUser = { id: 'user-owner' }

    const { MarketplacePanel } = await import('../MarketplacePanel')
    render(<MarketplacePanel spaceId="space-1" />)

    expect(screen.getByTestId('skill-marketplace').dataset.canInstall).toBe('false')
  })

  it('exposes the unified App Marketplace tab and drops the old Plugin Marketplace tab', async () => {
    const { MarketplacePanel } = await import('../MarketplacePanel')
    render(<MarketplacePanel spaceId="space-1" />)

    expect(screen.getByText('marketplace.tabs.apps')).toBeTruthy()
    expect(screen.queryByText('marketplace.tabs.plugins')).toBeNull()
  })

  it('renders the unified App Marketplace inline for the current Space organization', async () => {
    const { MarketplacePanel } = await import('../MarketplacePanel')
    render(<MarketplacePanel spaceId="space-1" />)

    fireEvent.click(screen.getByText('marketplace.tabs.apps'))

    const market = screen.getByTestId('app-marketplace-panel')
    expect(market.dataset.organizationId).toBe('wt-1')
    expect(market.dataset.canManage).toBe('true')
    expect(market.dataset.showHeader).toBe('false')
    expect(market.dataset.fillContainer).toBe('true')
    expect(market.dataset.className).toBe('h-full w-full')
  })

  it('does not fall back to selected organization when the Space organization is missing', async () => {
    mockSpaces = [{ id: 'space-1', name: '默认 Space', organization_id: 'wt-missing' }]
    mockOrganizations = [{ id: 'wt-1', name: '团队一', owner_id: 'user-owner', type: 'team' }]
    mockSelectedOrganization = mockOrganizations[0]!

    const { MarketplacePanel } = await import('../MarketplacePanel')
    render(<MarketplacePanel spaceId="space-1" />)

    fireEvent.click(screen.getByText('marketplace.tabs.apps'))

    expect(screen.queryByTestId('app-marketplace-panel')).toBeNull()
    expect(screen.getByText('marketplace.apps.noOrganization')).toBeTruthy()
  })
})
