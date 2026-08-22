import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'skills.marketplace.title': '技能和连接器',
      'skills.marketplace.description': '发现、管理技能和连接器，扩展 Agent 的能力。',
      'skills.marketplace.tabsLabel': '能力类型',
      'skills.marketplace.tabs.skills': '技能',
      'skills.marketplace.tabs.connectors': '连接器',
    })[key] ?? key,
  }),
}))

vi.mock('../skills/SkillPanel', () => ({
  SkillPanel: ({
    spaceId,
    marketplaceMode,
    catalogActive,
  }: {
    spaceId?: string | null
    marketplaceMode?: boolean
    catalogActive?: boolean
  }) => (
    <div data-testid="skill-market-content">
      {spaceId}:{marketplaceMode ? 'marketplace' : 'library'}
      :catalogActive={String(catalogActive !== false)}
    </div>
  ),
}))

vi.mock('@components/space-settings/McpPanel', () => ({
  McpPanel: ({
    embedded,
    canManage,
    organizationId,
    liveCatalog,
    catalogActive,
  }: {
    embedded?: boolean
    canManage?: boolean
    organizationId?: string | null
    liveCatalog?: boolean
    catalogActive?: boolean
  }) => (
    <div data-testid="connector-market-content">
      {embedded ? 'embedded' : 'standalone'}
      :org={organizationId ?? 'none'}
      :canManage={String(canManage)}
      :liveCatalog={String(!!liveCatalog)}
      :catalogActive={String(catalogActive !== false)}
    </div>
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { currentUserRole: string | null }) => unknown) =>
    selector({ currentUserRole: 'viewer' }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: {
    spaces: Array<{ id: string; organization_id: string }>
  }) => unknown) =>
    selector({
      spaces: [{ id: 'workspace-1', organization_id: 'org-1' }],
    }),
}))

import { CapabilityMarketplacePage } from './CapabilityMarketplacePage'

describe('CapabilityMarketplacePage', () => {
  it('以技能和连接器为统一入口，并在两个对象页签间切换', () => {
    render(<CapabilityMarketplacePage spaceId="workspace-1" />)

    expect(screen.getByRole('heading', { name: '技能和连接器' })).toBeTruthy()
    expect(screen.getByRole('tab', { name: '技能' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('skill-market-content').textContent).toBe(
      'workspace-1:marketplace:catalogActive=true',
    )

    fireEvent.click(screen.getByRole('tab', { name: '连接器' }))

    expect(screen.getByRole('tab', { name: '连接器' }).getAttribute('aria-selected')).toBe('true')
    expect(screen.getByTestId('connector-market-content').textContent).toBe(
      'embedded:org=org-1:canManage=false:liveCatalog=true:catalogActive=true',
    )
  })

  it('技能与连接器页签互斥传 catalogActive，连接器用 Space organizationId', () => {
    render(<CapabilityMarketplacePage spaceId="workspace-1" />)

    expect(screen.getByTestId('skill-market-content').textContent).toContain('catalogActive=true')
    expect(screen.getByTestId('connector-market-content').textContent).toContain(
      'catalogActive=false',
    )
    expect(screen.getByTestId('connector-market-content').textContent).toContain('org=org-1')

    fireEvent.click(screen.getByRole('tab', { name: '连接器' }))
    expect(screen.getByTestId('skill-market-content').textContent).toContain('catalogActive=false')
    expect(screen.getByTestId('connector-market-content').textContent).toContain(
      'catalogActive=true',
    )
  })
})
