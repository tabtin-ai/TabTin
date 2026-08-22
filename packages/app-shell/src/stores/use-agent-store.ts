/**
 * Agent 状态管理 — 从 use-space-store 抽离
 *
 * Agent 身份与 Space 执行现场彻底解耦：
 * - selectedAgent 只反映用户当前选择的 AI 身份，不再由 Space 推导；
 * - agentCache 提供全局按 id 查缓存，避免每处都重新拉取；
 * - updateAgent / deleteAgent / reactivateAgent 是 Agent 生命周期动作，
 *   与 Space CRUD 完全独立；「删除 Space」不再顺带删 Agent。
 *
 * 现场与身份分离：Workspace 只承载 device/working_dir；session.agent_id 各自承载：
 * - Workspace 决定 device / working_dir；
 * - session.agent_id 决定「这条会话跟哪个 Agent 说话」；
 * - Space 只承载空间元信息，不再解析出 Agent。
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'
import type { Agent, UpdateAgentRequest } from '../types/space.js'
import type { LoadingState } from '../types/common.js'
import { AgentApiService } from '../services/space-api.js'
import { registerResetAction } from './session-reset-registry.js'
import { createLogger } from '../utils/logger.js'
import {
  isCurrentPreferredModelEpoch,
  isPersistablePreferredModelId,
  nextPreferredModelEpoch,
} from './preferred-model-write.js'
import {
  markAgentConfigKnown,
  notifyAgentContextChanged,
} from './frontend-context-ready.js'
import { pushHostAgentTurnState } from './host-turn-push.js'

const log = createLogger('Agent')

function mergeAgentPreservingLocalPersonalRules(
  incoming: Agent,
  previous?: Agent | null,
): Agent {
  if (Object.prototype.hasOwnProperty.call(incoming, 'personal_rules')) return incoming
  if (previous?.personal_rules === undefined) return incoming
  return { ...incoming, personal_rules: previous.personal_rules }
}

/** ：跨 organization 时需清 selectedAgent；同组织保留。 */
export function shouldClearSelectedAgentForOrganization(
  agent: Pick<Agent, 'organization_id'> | null | undefined,
  organizationId: string | null | undefined,
): boolean {
  if (!agent) return false
  if (!organizationId) return true
  return agent.organization_id !== organizationId
}

interface AgentStoreState extends LoadingState {
  /** 全局当前选择的 Agent 身份，与 Space 现场解耦。 */
  selectedAgent: Agent | null
  /** 按 id 缓存最近读到的 Agent，供 UI / 各处 selector 查表。 */
  agentCache: Record<string, Agent>

  selectAgent: (agent: Agent | null) => void
  loadAgent: (agentId: string, options?: { force?: boolean }) => Promise<Agent | null>
  updateAgent: (agentId: string, updates: UpdateAgentRequest) => Promise<boolean>
  deleteAgent: (agentId: string) => Promise<boolean>
  reactivateAgent: (agentId: string) => Promise<boolean>
  setPreferredModel: (agentId: string, modelId: string) => void

  /** 从缓存与 selectedAgent 中移除指定 id（membership 收回 / Agent 停用 WS 推送用）。 */
  dropAgent: (agentId: string) => void

  clearAgents: () => void
}

type AgentStorePersistState = Record<string, never>

export const useAgentStore = create<AgentStoreState>()(
  persist<AgentStoreState, [], [], AgentStorePersistState>(
    (set, get) => ({
      selectedAgent: null,
      agentCache: {},
      isLoading: false,
      error: null,

      selectAgent: (agent) => {
        set({ selectedAgent: agent })
        notifyAgentContextChanged(agent)
        // 以前端为准：选中即推 Host，发送路径优先 compose、不打 DETAIL。
        pushHostAgentTurnState(agent)
      },

      loadAgent: async (agentId, { force = false } = {}) => {
        try {
          if (!force) {
            const cached = get().agentCache[agentId]
            if (cached) {
              markAgentConfigKnown(cached)
              if (get().selectedAgent?.id === agentId) {
                notifyAgentContextChanged(cached)
              }
              pushHostAgentTurnState(cached)
              return cached
            }
          }
          const previous = get().agentCache[agentId] ?? get().selectedAgent
          const agent = mergeAgentPreservingLocalPersonalRules(
            await AgentApiService.getAgent(agentId),
            previous?.id === agentId ? previous : null,
          )
          set((state) => ({
            agentCache: { ...state.agentCache, [agentId]: agent },
            selectedAgent: state.selectedAgent?.id === agentId ? agent : state.selectedAgent,
            error: null,
          }))
          markAgentConfigKnown(agent)
          if (get().selectedAgent?.id === agentId) {
            notifyAgentContextChanged(agent)
          }
          pushHostAgentTurnState(agent)
          log.info('Agent loaded:', agent.name)
          return agent
        } catch (error) {
          const errorMessage =
            error instanceof Error && error.message
              ? error.message
              : 'Failed to load agent'
          log.error('Failed to load Agent:', { agentId, error })
          set({ error: errorMessage })
          return null
        }
      },

      updateAgent: async (agentId, updates) => {
        set({ isLoading: true, error: null })
        try {
          const previous = get().agentCache[agentId] ?? get().selectedAgent
          const updatedAgent = mergeAgentPreservingLocalPersonalRules(
            await AgentApiService.updateAgent(agentId, updates),
            previous?.id === agentId ? previous : null,
          )
          set((state) => ({
            agentCache: { ...state.agentCache, [agentId]: updatedAgent },
            selectedAgent: state.selectedAgent?.id === agentId ? updatedAgent : state.selectedAgent,
            isLoading: false,
          }))
          markAgentConfigKnown(updatedAgent)
          if (get().selectedAgent?.id === agentId) {
            notifyAgentContextChanged(updatedAgent)
          }
          pushHostAgentTurnState(updatedAgent)
          log.info('Agent updated:', updatedAgent.name)
          return true
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to update agent'
          log.error('Failed to update Agent:', error)
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      deleteAgent: async (agentId) => {
        set({ isLoading: true, error: null })
        try {
          await AgentApiService.deleteAgent(agentId)
          const wasSelected = get().selectedAgent?.id === agentId
          set((state) => {
            const newCache = { ...state.agentCache }
            delete newCache[agentId]
            return {
              agentCache: newCache,
              selectedAgent: state.selectedAgent?.id === agentId ? null : state.selectedAgent,
              isLoading: false,
            }
          })
          if (wasSelected) {
            notifyAgentContextChanged(null)
          }
          log.info('Agent deleted:', agentId)
          return true
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to delete agent'
          log.error('Failed to delete Agent:', error)
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      reactivateAgent: async (agentId) => {
        set({ isLoading: true, error: null })
        try {
          const previous = get().agentCache[agentId] ?? get().selectedAgent
          const agent = mergeAgentPreservingLocalPersonalRules(
            await AgentApiService.reactivateAgent(agentId),
            previous?.id === agentId ? previous : null,
          )
          set((state) => ({
            agentCache: { ...state.agentCache, [agentId]: agent },
            selectedAgent: state.selectedAgent?.id === agentId ? agent : state.selectedAgent,
            isLoading: false,
          }))
          pushHostAgentTurnState(agent)
          log.info('Agent reactivated:', agent.name)
          return true
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to reactivate agent'
          log.error('Failed to reactivate Agent:', error)
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      setPreferredModel: (agentId, modelId) => {
        // ：本机 Codex id 等非平台 UUID 不得写入 Agent 首选。
        if (!isPersistablePreferredModelId(modelId)) {
          log.warn('Skip non-persistable preferred model id:', { agentId, modelId })
          return
        }
        const epoch = nextPreferredModelEpoch(agentId)
        const cached = get().agentCache[agentId]
        if (cached) {
          const updated = { ...cached, preferred_model_id: modelId }
          set((state) => ({
            agentCache: { ...state.agentCache, [agentId]: updated },
            selectedAgent: state.selectedAgent?.id === agentId ? updated : state.selectedAgent,
          }))
        }
        void AgentApiService.updatePreferredModel(agentId, modelId)
          .then(() => {
            // ：纠偏必须再走 setPreferredModel（新 epoch），禁止裸 repair PATCH。
            if (isCurrentPreferredModelEpoch(agentId, epoch)) return
            const latest =
              get().agentCache[agentId]?.preferred_model_id
              ?? (get().selectedAgent?.id === agentId
                ? get().selectedAgent?.preferred_model_id
                : undefined)
            if (!latest || latest === modelId || !isPersistablePreferredModelId(latest)) return
            get().setPreferredModel(agentId, latest)
          })
          .catch((err) => {
            log.warn('Failed to persist preferred model:', err)
          })
      },

      dropAgent: (agentId) => {
        const wasSelected = get().selectedAgent?.id === agentId
        set((state) => {
          if (!state.agentCache[agentId] && state.selectedAgent?.id !== agentId) return state
          const nextCache = { ...state.agentCache }
          delete nextCache[agentId]
          return {
            agentCache: nextCache,
            selectedAgent: state.selectedAgent?.id === agentId ? null : state.selectedAgent,
          }
        })
        if (wasSelected) {
          notifyAgentContextChanged(null)
        }
      },

      clearAgents: () => {
        set({
          selectedAgent: null,
          agentCache: {},
          isLoading: false,
          error: null,
        })
        notifyAgentContextChanged(null)
        log.info('Agent cache cleared')
      },
    }),
    withPersistSafety({
      name: 'tabtin-agent-store',
      partialize: (): AgentStorePersistState => ({}),
      version: 1,
      migrate: (_persistedState: unknown, _version: number) => ({}),
    }),
  ),
)

registerResetAction('agent-store', 'reset', () => useAgentStore.getState().clearAgents())
