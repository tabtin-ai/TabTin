import type { Agent, Space } from '@tabtin/app-shell'
import { useSpaceStore } from '@stores/useSpaceStore'

/**
 * 解析当前生效的 Agent 身份，供行为设置面板读写。
 *
 *  / ：现场（Workspace）不再投影身份；身份读 `selectedAgent`。
 * `spaceId` 仍用于取现场元数据（working_dir / control_device 等）。
 */
export function useSpaceExecutionAgent(spaceId: string): {
  space: Space | null
  agent: Agent | null
  agentId: string | null
  ensureAgent: () => Promise<Agent | null>
  isLoading: boolean
} {
  const space = useSpaceStore(
    (state) => state.spaces.find((item) => item.id === spaceId) ?? null,
  )
  const agent = useSpaceStore((state) => state.selectedAgent)
  const agentId = agent?.id ?? null
  const loadAgent = useSpaceStore((state) => state.loadAgent)
  const isLoading = useSpaceStore((state) => state.isLoading)

  const ensureAgent = async () => {
    if (agentId && agent) return agent
    if (agentId) {
      const loaded = await loadAgent(agentId, { force: true })
      if (loaded) return loaded
    }
    // ：ensureSpaceExecutionAgent 已退役，不再从现场补建身份
    return null
  }

  return {
    space,
    agent,
    agentId,
    ensureAgent,
    isLoading,
  }
}
