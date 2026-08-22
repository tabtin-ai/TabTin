import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { Organization } from '@tabtin/app-shell'
import { AppMarketplacePanel } from './AppMarketplacePanel'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'appMarket.title': '应用市场',
      'appMarket.subtitle': '浏览并安装团队可用的协作应用与本机应用。',
      'appMarket.collaborativeSection': '组织共享',
      'appMarket.collaborativeSectionDesc': '团队可用的协作应用。',
      'appMarket.localSection': '本机应用',
      'appMarket.localSectionDesc': '个人安装到本机，装好后到工作空间设置里启用。',
      'appMarket.surface.collaborative': '协作',
      'appMarket.surface.local': '本机',
    }[key] ?? key),
  }),
}))

vi.mock('./OrganizationAppCatalogPanel', () => ({
  OrganizationAppCatalogPanel: ({
    organization,
    canManageOrganization,
    showHeader,
    embedded,
    wideGrid,
  }: {
    organization: Organization
    canManageOrganization?: boolean
    showHeader?: boolean
    embedded?: boolean
    wideGrid?: boolean
  }) => (
    <div
      data-testid="collaborative-panel"
      data-organization-id={organization.id}
      data-can-manage={String(canManageOrganization)}
      data-show-header={String(showHeader)}
      data-embedded={String(embedded)}
      data-wide-grid={String(wideGrid)}
    >
      collaborative panel
    </div>
  ),
}))

vi.mock('./LocalPluginMarketplacePanel', () => ({
  LocalPluginMarketplacePanel: ({
    organization,
    canManageOrganization,
    view,
    showHeader,
    embedded,
    wideGrid,
  }: {
    organization: Organization
    canManageOrganization?: boolean
    view?: string
    showHeader?: boolean
    embedded?: boolean
    wideGrid?: boolean
  }) => (
    <div
      data-testid="local-panel"
      data-organization-id={organization.id}
      data-can-manage={String(canManageOrganization)}
      data-view={view}
      data-show-header={String(showHeader)}
      data-embedded={String(embedded)}
      data-wide-grid={String(wideGrid)}
    >
      local panel
    </div>
  ),
}))

const organization = {
  id: 'team-1',
  name: 'Team One',
} as Organization

describe('AppMarketplacePanel', () => {
  it('switches between collaborative and local app sections with nested tabs', () => {
    const { rerender } = render(<AppMarketplacePanel organization={organization} canManageOrganization />)

    const collaborativeTab = screen.getByRole('tab', { name: '组织共享' })
    const localTab = screen.getByRole('tab', { name: '本机应用' })
    const tabPanel = screen.getByRole('tabpanel')
    expect(collaborativeTab.getAttribute('aria-selected')).toBe('true')
    expect(localTab.getAttribute('aria-selected')).toBe('false')
    expect(screen.getAllByText('组织共享')).toHaveLength(1)
    expect(screen.getAllByText('本机应用')).toHaveLength(1)
    expect(screen.queryByText('团队可用的协作应用。')).toBeNull()
    expect(screen.queryByText('个人安装到本机，装好后到工作空间设置里启用。')).toBeNull()
    expect(collaborativeTab.getAttribute('aria-controls')).toBe(tabPanel.id)
    expect(localTab.getAttribute('aria-controls')).toBe(tabPanel.id)
    expect(tabPanel.getAttribute('aria-labelledby')).toBe(collaborativeTab.id)

    const collaborative = screen.getByTestId('collaborative-panel')
    expect(collaborative.dataset.organizationId).toBe('team-1')
    expect(collaborative.dataset.canManage).toBe('true')
    expect(collaborative.dataset.showHeader).toBe('false')
    expect(collaborative.dataset.embedded).toBe('true')
    expect(collaborative.dataset.wideGrid).toBe('false')
    expect(screen.queryByTestId('local-panel')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: '本机应用' }))

    expect(screen.getByRole('tab', { name: '组织共享' }).getAttribute('aria-selected')).toBe('false')
    const selectedLocalTab = screen.getByRole('tab', { name: '本机应用' })
    expect(selectedLocalTab.getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByText('团队可用的协作应用。')).toBeNull()
    expect(screen.queryByText('个人安装到本机，装好后到工作空间设置里启用。')).toBeNull()
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(selectedLocalTab.id)
    expect(screen.queryByTestId('collaborative-panel')).toBeNull()

    const local = screen.getByTestId('local-panel')
    expect(local.dataset.organizationId).toBe('team-1')
    expect(local.dataset.canManage).toBe('true')
    expect(local.dataset.view).toBe('marketplace')
    expect(local.dataset.showHeader).toBe('false')
    expect(local.dataset.embedded).toBe('true')

    rerender(<AppMarketplacePanel organization={organization} initialTab="local" />)
    rerender(<AppMarketplacePanel organization={organization} initialTab="collaborative" />)

    expect(screen.getByRole('tab', { name: '组织共享' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('local-panel')).toBeNull()
    expect(screen.getByTestId('collaborative-panel')).not.toBeNull()
  })

  it('can open directly on the local apps tab for legacy plugin links', () => {
    render(<AppMarketplacePanel organization={organization} initialTab="local" />)

    expect(screen.getByRole('tab', { name: '组织共享' }).getAttribute('aria-selected')).toBe('false')
    expect(screen.getByRole('tab', { name: '本机应用' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.queryByTestId('collaborative-panel')).toBeNull()
    expect(screen.getByTestId('local-panel')).not.toBeNull()
  })

  it('can fill the outer container when embedded in the Marketplace app', () => {
    const { container, rerender } = render(<AppMarketplacePanel organization={organization} />)

    expect(container.firstElementChild?.className).toContain('max-w-3xl')

    rerender(<AppMarketplacePanel organization={organization} fillContainer className="w-full" />)

    expect(container.firstElementChild?.className).toContain('max-w-none')
    expect(container.firstElementChild?.className).toContain('w-full')
    expect(container.firstElementChild?.className).not.toContain('max-w-3xl')
    expect(screen.getByTestId('collaborative-panel').dataset.wideGrid).toBe('true')
  })
})
