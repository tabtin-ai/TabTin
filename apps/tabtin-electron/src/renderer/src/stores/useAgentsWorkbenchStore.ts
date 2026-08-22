/** @store-category prefs */

import { create } from 'zustand'
import { createLogger } from '@/utils/logger'
import {
  getCachedOrganizationAgents,
  listOrganizationAgents,
  type OrganizationAgentSummary,
} from '@/services/organizationAgentsApi'
import { useAgentMemoryFocusStore } from '@/services/agentMemoryNavigation'

const log = createLogger('AgentsWorkbench')

interface AgentsWorkbenchState {
  organizationId: string | null
  agents: OrganizationAgentSummary[]
  loadedOrganizationId: string | null
  loading: boolean
  loadError: boolean
  selectedAgentId: string | null
  showDeactivated: boolean
  newAgentOpen: boolean
  rulesDraftByAgentId: Record<string, string | null>
  focusMemoryId: string | null
  setOrganizationId: (organizationId: string | null) => void
  setSelectedAgentId: (agentId: string | null) => void
  /** 开号成功：乐观入列表并选中，避免 loadAgents 完成前被回落到默认分身 */
  selectCreatedAgent: (agent: OrganizationAgentSummary) => void
  setShowDeactivated: (show: boolean) => void
  setNewAgentOpen: (open: boolean) => void
  setRulesDraft: (agentId: string, draft: string | null) => void
  setFocusMemoryId: (memoryId: string | null) => void
  loadAgents: () => Promise<void>
  applyMemoryFocus: () => void
  resetForOrganization: (organizationId: string | null) => void
}

let loadRequestId = 0
let optimisticCreatedAgentId: string | null = null

export const useAgentsWorkbenchStore = create<AgentsWorkbenchState>((set, get) => ({
  organizationId: null,
  agents: [],
  loadedOrganizationId: null,
  loading: false,
  loadError: false,
  selectedAgentId: null,
  showDeactivated: false,
  newAgentOpen: false,
  rulesDraftByAgentId: {},
  focusMemoryId: null,

  setOrganizationId: (organizationId) => {
    const prev = get().organizationId
    if (prev === organizationId) return
    get().resetForOrganization(organizationId)
  },

  setSelectedAgentId: (agentId) => {
    set({ selectedAgentId: agentId, showDeactivated: false, focusMemoryId: null })
  },

  selectCreatedAgent: (agent) => {
    optimisticCreatedAgentId = agent.id
    set(state => {
      const exists = state.agents.some(item => item.id === agent.id)
      return {
        selectedAgentId: agent.id,
        showDeactivated: false,
        focusMemoryId: null,
        agents: exists
          ? state.agents.map(item => (item.id === agent.id ? { ...item, ...agent } : item))
          : [...state.agents, agent],
      }
    })
  },

  setShowDeactivated: (show) => set({ showDeactivated: show }),

  setNewAgentOpen: (open) => set({ newAgentOpen: open }),

  setRulesDraft: (agentId, draft) => {
    set(state => ({
      rulesDraftByAgentId: { ...state.rulesDraftByAgentId, [agentId]: draft },
    }))
  },

  setFocusMemoryId: (memoryId) => set({ focusMemoryId: memoryId }),

  resetForOrganization: (organizationId) => {
    loadRequestId += 1
    optimisticCreatedAgentId = null
    set({
      organizationId,
      agents: [],
      loadedOrganizationId: null,
      loading: Boolean(organizationId),
      loadError: false,
      selectedAgentId: null,
      showDeactivated: false,
      newAgentOpen: false,
      rulesDraftByAgentId: {},
      focusMemoryId: null,
    })
  },

  applyMemoryFocus: () => {
    const focus = useAgentMemoryFocusStore.getState()
    if (focus.nonce === 0) return
    const { agents } = get()
    if (focus.agentId) {
      if (!agents.some(agent => agent.id === focus.agentId)) return
      set({
        selectedAgentId: focus.agentId,
        focusMemoryId: focus.memoryId,
        showDeactivated: false,
      })
    } else {
      set({ focusMemoryId: null })
    }
    useAgentMemoryFocusStore.getState().clear()
  },

  loadAgents: async () => {
    const organizationId = get().organizationId
    const requestId = ++loadRequestId
    if (!organizationId) {
      set({
        agents: [],
        loadedOrganizationId: null,
        selectedAgentId: null,
        loading: false,
        loadError: false,
      })
      return
    }

    const switchingOrganization = get().loadedOrganizationId !== organizationId
    const staleAgents = switchingOrganization
      ? getCachedOrganizationAgents(organizationId)
      : null

    set({ loadError: false })
    if (switchingOrganization) {
      if (staleAgents) {
        set({
          agents: staleAgents,
          loadedOrganizationId: organizationId,
          selectedAgentId: (prev => (
            prev && staleAgents.some(agent => agent.id === prev)
              ? prev
              : (staleAgents[0]?.id ?? null)
          ))(get().selectedAgentId),
          loading: false,
        })
      } else {
        set({
          agents: [],
          loadedOrganizationId: null,
          selectedAgentId: null,
          loading: true,
        })
      }
    } else {
      set({ loading: true })
    }

    try {
      const nextAgents = await listOrganizationAgents(organizationId)
      if (requestId !== loadRequestId) return
      set(state => {
        // 开号后可能先乐观选中，再关窗触发刷新；若列表瞬时未含新 id，保留乐观项，避免回落到默认分身。
        let agents = nextAgents
        const selectedId = state.selectedAgentId
        if (
          selectedId
          && selectedId === optimisticCreatedAgentId
          && !nextAgents.some(agent => agent.id === selectedId)
        ) {
          const optimistic = state.agents.find(agent => agent.id === selectedId)
          if (optimistic) {
            agents = [...nextAgents, optimistic]
          }
        }
        if (optimisticCreatedAgentId && nextAgents.some(agent => agent.id === optimisticCreatedAgentId)) {
          optimisticCreatedAgentId = null
        }
        return {
          agents,
          loadedOrganizationId: organizationId,
          loading: false,
          selectedAgentId: selectedId && agents.some(agent => agent.id === selectedId)
            ? selectedId
            : (agents[0]?.id ?? null),
        }
      })
      get().applyMemoryFocus()
    } catch (error) {
      if (requestId !== loadRequestId) return
      log.warn('AI分身列表加载失败', { organizationId }, error)
      if (!staleAgents) {
        set({ loadError: true, loading: false })
      } else {
        set({ loading: false })
      }
    }
  },
}))
