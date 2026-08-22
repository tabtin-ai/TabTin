import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentsDetailCanvas } from './AgentsDetailCanvas'

const organizationState = {
  selectedOrganization: { id: 'org-b' },
}

const workbenchState = {
  organizationId: 'org-a' as string | null,
  agents: [{
    id: 'agent-a',
    name: '组织 A 分身',
    is_default: false,
  }],
  loading: false,
  selectedAgentId: 'agent-a' as string | null,
  showDeactivated: false,
  rulesDraftByAgentId: {} as Record<string, string | null>,
  focusMemoryId: null as string | null,
  setRulesDraft: vi.fn(),
  setShowDeactivated: vi.fn(),
  loadAgents: vi.fn(),
  setSelectedAgentId: vi.fn(),
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: typeof organizationState) => unknown) => selector(organizationState),
}))

vi.mock('@stores/useAgentsWorkbenchStore', () => ({
  useAgentsWorkbenchStore: Object.assign(
    (selector: (state: typeof workbenchState) => unknown) => selector(workbenchState),
    { getState: () => workbenchState },
  ),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { updateAgent: () => Promise<boolean>; deleteAgent: () => Promise<boolean> }) => unknown) =>
    selector({
      updateAgent: vi.fn(async () => true),
      deleteAgent: vi.fn(async () => true),
    }),
}))

vi.mock('@components/settings/panels/SkillLibraryPanel', () => ({
  useSkillLibraryContextSpaceId: (organizationId: string | null) => `skills-${organizationId}`,
}))

vi.mock('@components/settings/panels/MyAgentsPanel', () => ({
  DeactivatedAgentsPanel: () => <div data-testid="deactivated-agents" />,
}))

vi.mock('@components/layout/agent-workbench/AgentWorkbenchDetail', () => ({
  AgentWorkbenchDetail: ({ organizationId, agent }: { organizationId: string; agent: { id: string } }) => (
    <div data-testid="agent-workbench-detail" data-organization-id={organizationId} data-agent-id={agent.id} />
  ),
}))

describe('AgentsDetailCanvas', () => {
  beforeEach(() => {
    organizationState.selectedOrganization = { id: 'org-b' }
    Object.assign(workbenchState, {
      organizationId: 'org-a',
      agents: [{
        id: 'agent-a',
        name: '组织 A 分身',
        is_default: false,
      }],
      loading: false,
      selectedAgentId: 'agent-a',
      showDeactivated: false,
    })
    vi.clearAllMocks()
  })

  it('workbench 尚未同步当前组织时不渲染旧分身详情', () => {
    const view = render(<AgentsDetailCanvas />)

    expect(screen.getByTestId('agents-detail-loading')).toBeTruthy()
    expect(screen.queryByTestId('agent-workbench-detail')).toBeNull()

    Object.assign(workbenchState, {
      organizationId: 'org-b',
      agents: [{
        id: 'agent-b',
        name: '组织 B 分身',
        is_default: false,
      }],
      selectedAgentId: 'agent-b',
    })
    view.rerender(<AgentsDetailCanvas />)

    expect(screen.queryByTestId('agents-detail-loading')).toBeNull()
    expect(screen.getByTestId('agent-workbench-detail').getAttribute('data-organization-id')).toBe('org-b')
    expect(screen.getByTestId('agent-workbench-detail').getAttribute('data-agent-id')).toBe('agent-b')
  })
})
