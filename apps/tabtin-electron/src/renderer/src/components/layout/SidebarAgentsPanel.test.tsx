import { render, waitFor } from '@testing-library/react'
import type { ButtonHTMLAttributes } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarAgentsPanel } from './SidebarAgentsPanel'

const setOrganizationId = vi.fn()
const loadAgents = vi.fn()

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string } }) => unknown) =>
    selector({ selectedOrganization: { id: 'org-b' } }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: null }) => unknown) => selector({ user: null }),
}))

vi.mock('@stores/useAgentsWorkbenchStore', () => ({
  useAgentsWorkbenchStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    agents: [],
    loading: true,
    loadError: false,
    selectedAgentId: null,
    showDeactivated: false,
    newAgentOpen: false,
    rulesDraftByAgentId: {},
    setOrganizationId,
    setSelectedAgentId: vi.fn(),
    selectCreatedAgent: vi.fn(),
    setShowDeactivated: vi.fn(),
    setNewAgentOpen: vi.fn(),
    loadAgents,
    applyMemoryFocus: vi.fn(),
  }),
}))

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>{children}</button>
  ),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  NavigationListSkeleton: () => <div data-testid="agents-loading" />,
}))

vi.mock('@components/sidebar/NewAgentButton', () => ({
  NewAgentDialog: () => null,
}))

vi.mock('@/services/agentTemplatesApi', () => ({
  listAgentTemplates: vi.fn(async () => []),
}))

vi.mock('@/services/organizationAgentsApi', () => ({
  organizationAgentSummaryFromAgent: (agent: unknown) => agent,
}))

vi.mock('@/utils/agentNameInterpolation', () => ({
  expandAgentName: (name: string) => name,
}))

vi.mock('@/utils/agentSourceBadge', () => ({
  resolveAgentSourceBadge: () => null,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}))

vi.mock('@components/settings/panels/MyAgentsPanel', () => ({
  formatAgentRelativeTime: () => '',
}))

vi.mock('./AgentSidebarListItem', () => ({
  AgentSidebarListItem: () => null,
}))

vi.mock('./SidebarAgentsPrimaryNav', () => ({
  SidebarAgentsPrimaryNav: () => null,
}))

describe('SidebarAgentsPanel', () => {
  beforeEach(() => {
    setOrganizationId.mockReset()
    loadAgents.mockReset()
  })

  it('挂载后立即将工作台组织同步为全局当前组织', async () => {
    render(<SidebarAgentsPanel />)

    await waitFor(() => {
      expect(setOrganizationId).toHaveBeenCalledWith('org-b')
      expect(loadAgents).toHaveBeenCalledTimes(1)
    })
  })
})
