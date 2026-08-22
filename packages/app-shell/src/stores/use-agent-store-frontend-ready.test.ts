import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tabtin/shared', () => ({
  withPersistSafety: (options: unknown) => options,
}))

vi.mock('./session-reset-registry.js', () => ({
  registerResetAction: vi.fn(),
}))

vi.mock('./host-turn-push.js', () => ({
  pushHostAgentTurnState: vi.fn(),
}))

vi.mock('../services/space-api.js', () => ({
  AgentApiService: {},
}))

const { resetFrontendContextReady, getFrontendContextReady } = await import(
  './frontend-context-ready.js'
)
const { useAgentStore } = await import('./use-agent-store.js')

describe('useAgentStore frontend context ready 接线', () => {
  beforeEach(() => {
    resetFrontendContextReady()
    useAgentStore.getState().clearAgents()
  })

  it('选择带权威配置的 Agent 后登记其配置已知', () => {
    useAgentStore.getState().selectAgent({
      id: 'agent-1',
      agent_config: { security: {} },
    } as never)

    expect(getFrontendContextReady()).toMatchObject({
      agentId: 'agent-1',
      agentConfigKnown: true,
    })
  })

  it('移除当前 Agent 后清空其上下文就绪状态', () => {
    useAgentStore.getState().selectAgent({
      id: 'agent-1',
      agent_config: { security: {} },
    } as never)

    useAgentStore.getState().dropAgent('agent-1')

    expect(getFrontendContextReady()).toMatchObject({
      agentId: null,
      agentConfigKnown: false,
    })
  })
})
