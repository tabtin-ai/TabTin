import { beforeEach, describe, expect, it, vi } from 'vitest'

const { controller, organizationState, spaceState } = vi.hoisted(() => ({
  controller: {
    resolveSendRoute: vi.fn(() => 'runtime' as const),
  },
  organizationState: {
    selectedOrganization: { id: 'organization-1', name: 'Organization One' },
  },
  spaceState: {
    selectedSpace: {
      id: 'workspace-1',
      name: 'Workspace One',
      organization_id: 'organization-1',
      type: 'workspace',
    },
    spaces: [] as Array<Record<string, unknown>>,
    selectedAgent: null as Record<string, unknown> | null,
    agentCache: {} as Record<string, Record<string, unknown>>,
    loadAgent: vi.fn(),
  },
}))

vi.mock('@/services/agentService', () => ({
  getSessionController: () => controller,
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => organizationState,
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => spaceState,
  },
}))

import { resolveSendExecutionContext } from '../resolveSendExecutionContext'

describe('resolveSendExecutionContext', () => {
  beforeEach(() => {
    controller.resolveSendRoute.mockClear()
    spaceState.spaces = [spaceState.selectedSpace]
    spaceState.agentCache = {}
    spaceState.loadAgent.mockReset()
  })

  it('发送前为缺少 agent_config 的列表摘要补拉 Agent 详情', async () => {
    spaceState.selectedAgent = {
      id: 'agent-1',
      name: '小Tin',
      custom_rules: '直接推进任务。',
    }
    const detailedAgent = {
      ...spaceState.selectedAgent,
      agent_config: { use_local_runtime: true },
    }
    spaceState.loadAgent.mockResolvedValue(detailedAgent)

    const result = await resolveSendExecutionContext({
      sessionId: 'session-1',
      store: {
        sessions: [{
          id: 'session-1',
          agent_id: 'agent-1',
          workspace_id: 'workspace-1',
          organization_id: 'organization-1',
        }],
      } as never,
      log: { error: vi.fn() },
    })

    expect(spaceState.loadAgent).toHaveBeenCalledWith('agent-1', { force: true })
    expect(result).toMatchObject({
      ok: true,
      context: { currentAgent: detailedAgent },
    })
    expect(controller.resolveSendRoute).toHaveBeenCalledWith({
      spaceId: 'workspace-1',
      agentConfig: detailedAgent.agent_config,
    })
  })
})
