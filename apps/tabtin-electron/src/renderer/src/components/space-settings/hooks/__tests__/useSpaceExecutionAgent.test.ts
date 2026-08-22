/**
 * useSpaceExecutionAgent —  / ：身份读 selectedAgent
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { Agent, Space } from '@tabtin/app-shell'

const mocks = vi.hoisted(() => ({
  loadAgent: vi.fn(),
  ensureSpaceExecutionAgent: vi.fn(),
  state: {
    spaces: [] as Space[],
    agentCache: {} as Record<string, Agent>,
    selectedAgent: null as Agent | null,
    isLoading: false,
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: typeof mocks.state & {
    loadAgent: typeof mocks.loadAgent
    ensureSpaceExecutionAgent: typeof mocks.ensureSpaceExecutionAgent
  }) => unknown) =>
    selector({
      ...mocks.state,
      loadAgent: mocks.loadAgent,
      ensureSpaceExecutionAgent: mocks.ensureSpaceExecutionAgent,
    }),
}))

const baseSpace: Space = {
  id: 'space-1',
  organization_id: 'wt-1',
  name: 'Demo',
  type: 'workspace',
  execution_agent_id: null,
  agent_id: null,
} as Space

const selectedAgent: Agent = {
  id: 'agent-selected',
  name: '小明',
  custom_rules: '只用中文',
} as Agent

describe('useSpaceExecutionAgent', () => {
  beforeEach(() => {
    mocks.loadAgent.mockReset().mockResolvedValue(selectedAgent)
    mocks.ensureSpaceExecutionAgent.mockReset().mockResolvedValue(null)
    mocks.state.spaces = [baseSpace]
    mocks.state.agentCache = { 'agent-selected': selectedAgent }
    mocks.state.selectedAgent = selectedAgent
    mocks.state.isLoading = false
  })

  it('#6302：读 selectedAgent，不依赖工作空间.agent_id', async () => {
    const { useSpaceExecutionAgent } = await import('../useSpaceExecutionAgent')
    const { result } = renderHook(() => useSpaceExecutionAgent('space-1'))

    expect(result.current.agentId).toBe('agent-selected')
    expect(result.current.agent?.custom_rules).toBe('只用中文')
    expect(mocks.loadAgent).not.toHaveBeenCalled()
  })

  it('#6302：无 selectedAgent 时 agentId 为 null，不回落现场 agent', async () => {
    mocks.state.selectedAgent = null
    mocks.state.agentCache = {}
    const { useSpaceExecutionAgent } = await import('../useSpaceExecutionAgent')
    const { result } = renderHook(() => useSpaceExecutionAgent('space-1'))

    expect(result.current.agentId).toBeNull()
    expect(result.current.agent).toBeNull()
    expect(mocks.loadAgent).not.toHaveBeenCalled()
  })

  it('#6302：ensureAgent 在无身份时不再调用已退役的 ensureSpaceExecutionAgent', async () => {
    mocks.state.selectedAgent = null
    mocks.state.agentCache = {}
    const { useSpaceExecutionAgent } = await import('../useSpaceExecutionAgent')
    const { result } = renderHook(() => useSpaceExecutionAgent('space-1'))

    const ensured = await result.current.ensureAgent()
    expect(mocks.ensureSpaceExecutionAgent).not.toHaveBeenCalled()
    expect(ensured).toBeNull()
  })

  it('selectedAgent 在 cache 外时仍返回 selectedAgent，并可 force load', async () => {
    mocks.state.agentCache = {}
    const { useSpaceExecutionAgent } = await import('../useSpaceExecutionAgent')
    const { result } = renderHook(() => useSpaceExecutionAgent('space-1'))

    expect(result.current.agentId).toBe('agent-selected')
    expect(result.current.agent?.id).toBe('agent-selected')

    const ensured = await result.current.ensureAgent()
    expect(ensured?.id).toBe('agent-selected')
  })
})
