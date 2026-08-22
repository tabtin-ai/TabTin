import { beforeEach, describe, expect, it, vi } from 'vitest'

const listOrganizationAgents = vi.fn()
const getCachedOrganizationAgents = vi.fn(() => null)

vi.mock('@/services/organizationAgentsApi', () => ({
  listOrganizationAgents: (...args: unknown[]) => listOrganizationAgents(...args),
  getCachedOrganizationAgents: (...args: unknown[]) => getCachedOrganizationAgents(...args),
}))

vi.mock('@/services/agentMemoryNavigation', () => ({
  useAgentMemoryFocusStore: {
    getState: () => ({
      nonce: 0,
      agentId: null,
      memoryId: null,
      clear: vi.fn(),
    }),
  },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { useAgentsWorkbenchStore } from '../useAgentsWorkbenchStore'

const defaultAgent = {
  id: 'agent-default',
  name: '小Tin',
  is_default: true,
  is_active: true,
}

const createdAgent = {
  id: 'agent-t09',
  name: '用户访谈分析员 T09',
  is_default: false,
  is_active: true,
  template_id: '',
}

describe('useAgentsWorkbenchStore selectCreatedAgent', () => {
  beforeEach(() => {
    listOrganizationAgents.mockReset()
    getCachedOrganizationAgents.mockReset()
    getCachedOrganizationAgents.mockReturnValue(null)
    useAgentsWorkbenchStore.setState({
      organizationId: 'org-1',
      agents: [defaultAgent],
      loadedOrganizationId: 'org-1',
      loading: false,
      loadError: false,
      selectedAgentId: defaultAgent.id,
      showDeactivated: false,
      newAgentOpen: false,
      rulesDraftByAgentId: {},
      focusMemoryId: null,
    })
  })

  it('开号成功后乐观入列表并选中新建分身，而不是保留默认分身', () => {
    useAgentsWorkbenchStore.getState().selectCreatedAgent(createdAgent)

    const state = useAgentsWorkbenchStore.getState()
    expect(state.selectedAgentId).toBe(createdAgent.id)
    expect(state.agents.map(agent => agent.id)).toEqual([
      defaultAgent.id,
      createdAgent.id,
    ])
  })

  it('关窗刷新若瞬时缺少新分身，仍保留乐观选中与列表项', async () => {
    useAgentsWorkbenchStore.getState().selectCreatedAgent(createdAgent)
    listOrganizationAgents.mockResolvedValue([defaultAgent])

    await useAgentsWorkbenchStore.getState().loadAgents()

    const state = useAgentsWorkbenchStore.getState()
    expect(state.selectedAgentId).toBe(createdAgent.id)
    expect(state.agents.map(agent => agent.id)).toEqual([
      defaultAgent.id,
      createdAgent.id,
    ])
  })

  it('刷新列表已含新分身时保持选中新建项', async () => {
    useAgentsWorkbenchStore.getState().selectCreatedAgent(createdAgent)
    listOrganizationAgents.mockResolvedValue([defaultAgent, createdAgent])

    await useAgentsWorkbenchStore.getState().loadAgents()

    const state = useAgentsWorkbenchStore.getState()
    expect(state.selectedAgentId).toBe(createdAgent.id)
    expect(state.agents.map(agent => agent.id)).toEqual([
      defaultAgent.id,
      createdAgent.id,
    ])
  })

  it('非新建的当前分身从服务端列表消失时，按原有刷新流程移除并切换选中项', async () => {
    useAgentsWorkbenchStore.setState({
      agents: [defaultAgent, createdAgent],
      selectedAgentId: createdAgent.id,
      rulesDraftByAgentId: { [createdAgent.id]: '未保存人设' },
    })
    listOrganizationAgents.mockResolvedValue([defaultAgent])

    await useAgentsWorkbenchStore.getState().loadAgents()

    const state = useAgentsWorkbenchStore.getState()
    expect(state.selectedAgentId).toBe(defaultAgent.id)
    expect(state.agents.map(agent => agent.id)).toEqual([defaultAgent.id])
    expect(state.rulesDraftByAgentId).toHaveProperty(createdAgent.id, '未保存人设')
  })
})
