/**
 * Space 状态管理 — 从 Electron 抽离
 *
 *  Space 终态退役：本 store 的 `spaces` 数组实际承载
 *   - 个人域：Workspace（`workspace_record: true`），由 `WorkspaceApiService` 供给；
 *   - 团队域：Project（`type: 'team_space'` 字面量兼容），由 `ProjectApiService` 供给。
 *
 * 命名保留 `useSpaceStore` / `selectedSpace` 是为了让上千个 Electron 消费点不必
 * 一次性改名；下一阶段将把 store 拆成 `useWorkspaceStore` + `useProjectStore`
 * 并同步下线本别名。
 *
 * 平台差异通过 runtime bridge 注入：
 * - window.tabtin.space.setActive → bridge.setActiveSpace()
 * - useCrawlTabStore → bridge.resolveCrawlspaceId()
 * - useSpaceContextTabsStore / clearAllSplitsForSpace → bridge.onSpaceDeleted()
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { withPersistSafety } from '@tabtin/shared'
import {
  type Space,
  type CreateSpaceRequest,
  type UpdateSpaceRequest,
  type UpdateAgentRequest,
  type SpaceStats,
  type Agent,
  type WorkspaceSummary,
  compareSpacesByStableOrder,
} from '../types/space.js'
import type { WorkingDirType } from '../types/space-types.js'
import type { LoadingState } from '../types/common.js'
import {
  WorkspaceApiService,
  ProjectApiService,
  AgentApiService,
  ApprovalMemoApiService,
} from '../services/space-api.js'
import { getRuntime } from '../runtime.js'
import { emitNavigate } from './view-navigation.js'
import {
  isCurrentPreferredModelEpoch,
  isPersistablePreferredModelId,
  nextPreferredModelEpoch,
} from './preferred-model-write.js'
import { registerResetAction } from './session-reset-registry.js'
import { useOrganizationStore } from './use-organization-store.js'
import {
  buildHostWorkspaceTurnPush,
  pushHostAgentTurnState,
} from './host-turn-push.js'
import {
  shouldClearSelectedAgentForOrganization,
  useAgentStore,
} from './use-agent-store.js'
import {
  markAgentConfigKnown,
  notifyWorkspaceContextChanged,
} from './frontend-context-ready.js'
import { createLogger } from '../utils/logger.js'

const log = createLogger('Space')

/**
 * Workspace 契约行 → Space 形状（原 `workspace-adapter.workspaceToSpaceLike`
 * 于  终态退役内联进 store）。
 *
 * Workspace 契约行没有壳字段（type/status/icon/avatar/table_count 等）；
 * 本函数把它垫成消费方已知的 Space 形状，让下游零改动。等 backend Workspace
 * 契约扩展为一等资源后本函数可删。
 */
function workspaceToSpaceLike(
  workspace: WorkspaceSummary,
  organizationId = workspace.organization_id,
): Space {
  const trailingSlashOrBackslash = /[\\/]+$/
  const anySlashOrBackslash = /[\\/]/
  const nameFromDir = (workspace.working_dir ?? '')
    .replace(trailingSlashOrBackslash, '')
    .split(anySlashOrBackslash)
    .filter(Boolean)
    .pop() ?? ''
  const workingDirType = (workspace.working_dir_type ?? '') as WorkingDirType | ''
  return {
    id: workspace.id,
    name: workspace.name || nameFromDir || 'Workspace',
    description: workspace.description ?? '',
    organization_id: organizationId,
    //  / ：保留 project_id（执行关联）与供给来源（导航隐藏）
    project_id: workspace.project_id ?? null,
    provisioning_source: workspace.provisioning_source ?? 'user',
    is_companion: workspace.is_companion === true,
    type: 'workspace',
    status: 'active',
    working_dir: workspace.working_dir,
    working_dir_type: workingDirType,
    icon: '',
    owner_execution_device_id: workspace.device_id ?? null,
    owner_execution_device_status: workspace.device_online ? 'online' : 'offline',
    control_device_id: workspace.device_id ?? null,
    bound_device_id: workspace.device_id ?? null,
    approval_grant: workspace.approval_grant,
    approval_memo_generation: workspace.approval_memo_generation,
    //  / ：现场规则与执行限额在 Workspace 上，读入本地 Space 壳必须带上
    custom_rules: workspace.custom_rules ?? '',
    execution_limits: workspace.execution_limits ?? {},
    workspace_record: true,
    is_default: workspace.is_home === true,
    // ：现场不再投影默认 Agent
    agent_id: null,
    execution_agent_id: null,
    table_count: 0,
    order: 0,
    is_archived: false,
    created_at: '',
    updated_at: '',
  }
}

const spaceLoadPromises = new Map<string, Promise<void>>()
const latestSpaceLoadRequestIdByOrganization = new Map<string, number>()
let _batchLoadCounter = 0
let _spaceRetryTimer: ReturnType<typeof setTimeout> | null = null
let _spaceRefreshDebounceTimer: ReturnType<typeof setTimeout> | null = null
let _spaceWsInitialized = false

function resolveCrawlspaceId(spaceId: string): string | null {
  const bridge = getRuntime().bridge
  return bridge.resolveCrawlspaceId?.(spaceId) ?? null
}

function mergeAgentPreservingLocalPersonalRules(incoming: Agent, previous?: Agent | null): Agent {
  if (Object.prototype.hasOwnProperty.call(incoming, 'personal_rules')) return incoming
  if (previous?.personal_rules === undefined) return incoming
  return { ...incoming, personal_rules: previous.personal_rules }
}

function nextSpaceLoadRequestId(cacheKey: string): number {
  const nextRequestId = (latestSpaceLoadRequestIdByOrganization.get(cacheKey) ?? 0) + 1
  latestSpaceLoadRequestIdByOrganization.set(cacheKey, nextRequestId)
  return nextRequestId
}

function isLatestSpaceLoad(cacheKey: string, requestId: number, _organizationId?: string): boolean {
  return latestSpaceLoadRequestIdByOrganization.get(cacheKey) === requestId
}

interface SpaceStoreState extends LoadingState {
  spaces: Space[]
  selectedSpace: Space | null
  isCreating: boolean
  loadRetryCount: number
  lastLoadError: string | null
  /** 按 organization 记录最近 loadSpaces 失败；避免其它组织失败污染当前组织空态判断。 */
  loadErrorByOrganizationId: Record<string, string>
  /** 最近一次成功完成 loadSpaces 的 organization；用于区分“确认空”与“尚未加载”。 */
  lastLoadedOrganizationId: string | null
  /** 已成功完成 loadSpaces 的 organization 集合；避免批量加载时 lastLoaded 被其它组织覆盖。 */
  loadedOrganizationIds: string[]

  agentCache: Record<string, Agent>
  selectedAgent: Agent | null

  createSpace: (data: CreateSpaceRequest) => Promise<Space | null>
  updateSpace: (id: string, updates: UpdateSpaceRequest) => Promise<boolean>
  deleteSpace: (id: string) => Promise<boolean>
  selectSpace: (space: Space | null) => void
  selectAgent: (agent: Agent | null) => void
  /** ：跨 organization 时清空 selectedAgent（双写）；同组织不改写。 */
  clearSelectedAgentOutsideOrganization: (
    organizationId: string | null | undefined,
  ) => void
  archiveSpace: (id: string) => Promise<boolean>
  restoreSpace: (id: string) => Promise<boolean>

  updateAgent: (agentId: string, updates: UpdateAgentRequest) => Promise<boolean>
  setPreferredModel: (agentId: string, modelId: string) => void
  deleteAgent: (agentId: string) => Promise<boolean>
  reactivateAgent: (agentId: string) => Promise<boolean>
  loadAgent: (agentId: string, options?: { force?: boolean }) => Promise<Agent | null>
  ensureSpaceExecutionAgent: (spaceId: string) => Promise<Agent | null>
  updateWorkspaceApprovalGrant: (
    workspaceId: string,
    approvalGrant: WorkspaceSummary['approval_grant'],
  ) => Promise<boolean>
  // Workspace.approval_memo CRUD（renderer 显式撤销路径）。
  revokeApprovalMemoEntry: (workspaceId: string, entryKey: string) => Promise<boolean>
  revokeAllApprovalMemos: (workspaceId: string) => Promise<boolean>
  loadSpaces: (organizationId?: string) => Promise<void>
  loadAllOrganizationSpaces: (organizationIds: string[]) => Promise<void>
  refreshSpace: (id: string) => Promise<void>
  getSpaceStats: (id: string) => Promise<SpaceStats | null>

  clearSpaces: () => void
  initSpaceWsListener: (gateway: any) => void
}

type SpaceStorePersistState = Record<string, never>

export const useSpaceStore = create<SpaceStoreState>()(
  persist<SpaceStoreState, [], [], SpaceStorePersistState>(
    (set, get) => ({
      spaces: [],
      selectedSpace: null,
      agentCache: {},
      selectedAgent: null,
      isLoading: false,
      isCreating: false,
      error: null,
      loadRetryCount: 0,
      lastLoadError: null,
      loadErrorByOrganizationId: {},
      lastLoadedOrganizationId: null,
      loadedOrganizationIds: [],

      createSpace: async (data) => {
        set({ isLoading: true, error: null })
        try {
          // ：个人现场只走 Workspace API；team_space 创建已退役（走 Project）。
          if (data.type === 'team_space') {
            throw new Error('Team Space 已退役，请使用 Project 创建入口')
          }
          if ((!data.device_id && !data.device_installation_id) || !data.working_dir) {
            throw new Error('创建 Workspace 需要执行设备与 working_dir')
          }
          const newSpace = workspaceToSpaceLike(
            await WorkspaceApiService.create({
              organization_id: data.organization_id,
              device_id: data.device_id,
              device_installation_id: data.device_installation_id,
              working_dir: data.working_dir,
              working_dir_type: data.working_dir_type,
              name: data.name,
            }),
            data.organization_id,
          )
          set((state) => ({
            spaces: [...state.spaces, newSpace],
            isLoading: false,
          }))
          log.info('Workspace created:', { id: newSpace.id, name: newSpace.name })
          return newSpace
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to create space'
          log.error('Failed to create Workspace:', error)
          set({ error: errorMessage, isLoading: false })
          return null
        }
      },

      updateSpace: async (id, updates) => {
        set({ isLoading: true, error: null })
        try {
          const current = get().spaces.find(space => space.id === id)
          // ：写路径一律 Workspace（个人）或拒绝团队壳 CRUD。
          if (current?.type === 'team_space') {
            throw new Error('Project 请使用 Project API 更新，不再走 Space CRUD')
          }
          const workspaceView = workspaceToSpaceLike(
            await WorkspaceApiService.update(id, {
              name: updates.name,
              description: updates.description,
              working_dir: updates.working_dir,
              working_dir_type: updates.working_dir_type,
              device_fingerprint: updates.device_fingerprint,
              //  / ：写入 Workspace.custom_rules / execution_limits
              custom_rules: updates.custom_rules,
              execution_limits: updates.execution_limits,
            }),
          )
          const updatedSpace: Space = {
            ...(current ?? workspaceView),
            ...workspaceView,
            icon: current?.icon ?? '',
            table_count: current?.table_count ?? 0,
            order: current?.order ?? 0,
            created_at: current?.created_at ?? '',
            updated_at: current?.updated_at ?? '',
            // ：勿用 ?? 回填旧 agent_id——null 是正解
            agent_id: null,
            execution_agent_id: null,
          }
          set((state) => ({
            spaces: state.spaces.map((s) =>
              s.id === id ? updatedSpace : s
            ),
            selectedSpace: state.selectedSpace?.id === id ? updatedSpace : state.selectedSpace,
            isLoading: false,
          }))
          getRuntime().bridge.pushHostTurnState?.({
            workspace: buildHostWorkspaceTurnPush(updatedSpace),
          })
          log.info('Space updated:', { id: updatedSpace.id, name: updatedSpace.name })
          return true
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to update space'
          log.error('Failed to update Space:', error)
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      updateWorkspaceApprovalGrant: async (workspaceId, approvalGrant) => {
        set({ isLoading: true, error: null })
        try {
          const updated = await WorkspaceApiService.updateApprovalGrant(
            workspaceId,
            approvalGrant,
          )
          set((state) => ({
            spaces: state.spaces.map((space) => (
              space.id === workspaceId
                ? {
                    ...space,
                    approval_grant: updated.approval_grant,
                    approval_memo_generation: updated.approval_memo_generation,
                  }
                : space
            )),
            selectedSpace: state.selectedSpace?.id === workspaceId
              ? {
                  ...state.selectedSpace,
                  approval_grant: updated.approval_grant,
                  approval_memo_generation: updated.approval_memo_generation,
                }
              : state.selectedSpace,
            isLoading: false,
          }))
          if (get().selectedSpace?.id === workspaceId) {
            notifyWorkspaceContextChanged({
              id: workspaceId,
              approval_grant: updated.approval_grant,
            })
          }
          getRuntime().bridge.pushHostTurnState?.({
            workspace: {
              id: workspaceId,
              approval_grant: updated.approval_grant,
            },
          })
          return true
        } catch (error) {
          const errorMessage = error instanceof Error
            ? error.message
            : 'Failed to update workspace approval grant'
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      deleteSpace: async (id) => {
        set({ isLoading: true, error: null })
        // 删除是高危不可逆操作：起止都记，便于事后从诊断包还原「谁在何时删了哪个 Space」
        log.info('Deleting space:', { id })
        try {
          // 删除只允许在执行设备本机发起，带上当前设备声明供后端校验
          const currentDeviceId = getRuntime().bridge.getCurrentDeviceId?.() ?? null
          const current = get().spaces.find(space => space.id === id)
          if (current?.type === 'team_space') {
            throw new Error('Project 请使用 Project API 删除，不再走 Space CRUD')
          }
          const wasSelected = get().selectedSpace?.id === id
          await WorkspaceApiService.delete(id, currentDeviceId)
          set((state) => ({
            spaces: state.spaces.filter((s) => s.id !== id),
            selectedSpace: state.selectedSpace?.id === id ? null : state.selectedSpace,
            isLoading: false,
          }))
          if (wasSelected) {
            notifyWorkspaceContextChanged(null)
          }

          getRuntime().bridge.onSpaceDeleted?.(id)

          // 顺带清本机外部导入档案：失败不阻断删除主路径。
          const organizationId = current?.organization_id
          if (organizationId) {
            void Promise.resolve(
              getRuntime().bridge.clearExternalArchivesForWorkspace?.({
                organizationId,
                workspaceId: id,
                workingDir: current.working_dir ?? null,
              }),
            ).catch((err) => {
              log.warn('clearExternalArchivesForWorkspace failed (ignored)', {
                id,
                error: err instanceof Error ? err.message : String(err),
              })
            })
          }

          log.info('Space deleted:', { id })
          return true
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to delete space'
          log.error('Failed to delete Space:', error)
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      archiveSpace: async (id) => {
        set({ isLoading: true, error: null })
        try {
          const current = get().spaces.find(space => space.id === id)
          if (current?.workspace_record || current?.type === 'workspace') {
            throw new Error('Workspace 不支持归档')
          }
          await ProjectApiService.archive(id)
          await get().refreshSpace(id)
          log.info('Space archived')
          return true
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to archive space'
          log.error('Failed to archive Space:', error)
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      restoreSpace: async (id) => {
        set({ isLoading: true, error: null })
        try {
          const current = get().spaces.find(space => space.id === id)
          if (current?.workspace_record || current?.type === 'workspace') {
            throw new Error('Workspace 不支持归档恢复')
          }
          await ProjectApiService.restore(id)
          await get().refreshSpace(id)
          log.info('Space restored')
          return true
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to restore space'
          log.error('Failed to restore Space:', error)
          set({ error: errorMessage, isLoading: false })
          return false
        }
      },

      selectSpace: (space) => {
        //  同组织只切现场；#8617 跨 org 清残留 selectedAgent。
        const bridge = getRuntime().bridge
        if (space) {
          get().clearSelectedAgentOutsideOrganization(space.organization_id)
          set({ selectedSpace: space })
          notifyWorkspaceContextChanged(space)
          emitNavigate('space')
          log.info('Space selected:', { id: space.id, type: space.type, organizationId: space.organization_id })
          const crawlspaceId = resolveCrawlspaceId(space.id)
          const workspaceRoot = space.working_dir ?? null
          bridge.setActiveSpace(space.id, crawlspaceId, space.organization_id, workspaceRoot)
          // 切现场时预热 Host turn workspace 状态，避免已 hydrate 的 Agent 再因缺 workspace 打 DETAIL。
          bridge.pushHostTurnState?.({
            workspace: buildHostWorkspaceTurnPush(space),
          })
        } else {
          const preservedOrganizationId = get().selectedSpace?.organization_id
            ?? useOrganizationStore.getState().selectedOrganization?.id
            ?? null
          set({ selectedSpace: null })
          notifyWorkspaceContextChanged(null)
          bridge.setActiveSpace(null, null, preservedOrganizationId)
          log.info('Space deselected', { preservedOrganizationId })
        }
      },

      selectAgent: (agent) => {
        // ：双写过渡——旧消费方仍读本 store；新路径读 useAgentStore
        set({ selectedAgent: agent })
        useAgentStore.getState().selectAgent(agent)
      },

      clearSelectedAgentOutsideOrganization: (organizationId) => {
        const agent = get().selectedAgent ?? useAgentStore.getState().selectedAgent
        if (!shouldClearSelectedAgentForOrganization(agent, organizationId)) {
          return
        }
        log.info('Cleared cross-org selectedAgent', {
          previousAgentId: agent?.id,
          previousOrganizationId: agent?.organization_id,
          targetOrganizationId: organizationId ?? null,
        })
        get().selectAgent(null)
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

      setPreferredModel: (agentId, modelId) => {
        // ：本机 Codex id 等非平台 UUID 不得写入 Agent 首选（Django 也不认）。
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
            // 陈旧 PATCH 已可能落库：走完整 setPreferredModel 纠偏（自带新 epoch），
            // 避免无 epoch 的裸 repair 在三次连切时盖掉更新选择。
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

      deleteAgent: async (agentId) => {
        set({ isLoading: true, error: null })
        try {
          await AgentApiService.deleteAgent(agentId)
          set((state) => {
            const newCache = { ...state.agentCache }
            delete newCache[agentId]
            return {
              agentCache: newCache,
              selectedAgent: state.selectedAgent?.id === agentId ? null : state.selectedAgent,
              isLoading: false,
            }
          })
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

      loadAgent: async (agentId, { force = false } = {}) => {
        try {
          if (!force) {
            const cached = get().agentCache[agentId]
            if (cached) {
              markAgentConfigKnown(cached)
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
          pushHostAgentTurnState(agent)
          log.info('Agent loaded:', agent.name)
          return agent
        } catch (error) {
          const errorMessage =
            error instanceof Error && error.message
              ? error.message
              : 'Failed to load execution agent'
          log.error('Failed to load Agent:', { agentId, error })
          //  / ：错误归属当前选中身份，不再从现场投影 agent_id
          if (get().selectedAgent?.id === agentId) {
            set({ error: errorMessage })
          }
          return null
        }
      },

      ensureSpaceExecutionAgent: async (_spaceId) => {
        // ：现场不再绑定 / 补建执行 Agent；请走 useAgentStore.selectAgent
        const msg = 'ensureSpaceExecutionAgent 已退役：请先选择 Agent'
        log.warn(msg)
        set({ isLoading: false, error: msg })
        return null
      },

      revokeApprovalMemoEntry: async (workspaceId, entryKey) => {
        try {
          const memo = await ApprovalMemoApiService.get(workspaceId)
          await ApprovalMemoApiService.deleteEntry(workspaceId, entryKey, memo.generation)
          log.info('Approval memo entry revoked:', entryKey)
          return true
        } catch (error) {
          log.error('Failed to revoke approval memo entry:', error)
          return false
        }
      },

      revokeAllApprovalMemos: async (workspaceId) => {
        try {
          await ApprovalMemoApiService.revokeAll(workspaceId)
          log.info('All approval memos revoked for workspace:', workspaceId)
          return true
        } catch (error) {
          log.error('Failed to revoke all approval memos:', error)
          return false
        }
      },

      loadSpaces: async (organizationId) => {
        const cacheKey = `${organizationId ?? '__all__'}::__all_accessible_spaces__`
        const existingPromise = spaceLoadPromises.get(cacheKey)
        if (existingPromise) {
          await existingPromise
          return
        }

        const requestId = nextSpaceLoadRequestId(cacheKey)
        const isBatchLoad = _batchLoadCounter > 0
        if (!isBatchLoad) {
          set({ isLoading: true, error: null })
        }

        const loader = (async () => {
          try {
            //  终态：个人 → WorkspaceApi；团队 → ProjectApi（不再 listSpaces team_space）。
            const [workspaces, projectResponse] = await Promise.all([
              WorkspaceApiService.list(organizationId),
              ProjectApiService.list(organizationId),
            ])
            const personalSpaces = workspaces.map((workspace) =>
              workspaceToSpaceLike(workspace, workspace.organization_id || organizationId || ''),
            )
            const response = {
              spaces: [...personalSpaces, ...projectResponse.spaces],
              total: personalSpaces.length + projectResponse.total,
            }

            if (!isLatestSpaceLoad(cacheKey, requestId, organizationId)) return

            if (_spaceRetryTimer) {
              clearTimeout(_spaceRetryTimer)
              _spaceRetryTimer = null
            }

            // Wave 3.2 复核加固：silent removal 同形漏洞修复。
            // 弱网/重连期间另一端删除/归档 Space → 重连后 loadSpaces 拿到不含该
            // Space 的 response → 直接 setState 拼接会"静默剔除"该 spaceId，
            // 不走 onSpaceDeleted → SpaceWorkbenchHost.spaces.find 找不到 → 子树
            // unmount → useRunManager cleanup → 守卫看到 hot 仍含 sceneId（从未
            // 剔除）+ crawlspaceConfig 仍在（从未 purge）→ 双条件 true → 错误保活
            // → 永久 Run 泄漏。
            //
            // 修法跟 onSpaceDeleted/membership 同形：先逐个调 bridge.onSpaceDeleted
            // （同步 removeFromHot + 触发 dirty 兜底 + tab clean + crawlspace purge），
            // 再 setState。第一次 loadSpaces 时 prev.spaces 在该 organizationId 范围内
            // 为空 → removedSpaceIds 为空 → 不会误判（首次加载不触发任何 hook）。
            //
            // 注意 archived Space：listSpaces 用 `is_archived: false` 过滤，archived
            // 后 reconnect loadSpaces 会触发 onSpaceDeleted——这是**正确行为**，
            // archived Space 应该走完整退出链路（hot 剔 + cs 关 + tab clean）。
            // 跟 WS push 'archived' 路径已经触发的 onSpaceDeleted 是同款幂等。
            const responseSpaceIdSet = new Set(response.spaces.map((s) => s.id))
            const removedSpaceIds = get()
              .spaces.filter((s) => {
                if (organizationId && s.organization_id !== organizationId) return false
                return !responseSpaceIdSet.has(s.id)
              })
              .map((s) => s.id)

            const bridge = getRuntime().bridge
            for (const spaceId of removedSpaceIds) {
              try {
                bridge.onSpaceDeleted?.(spaceId)
              } catch (err) {
                log.warn('loadSpaces silent removal: onSpaceDeleted hook failed (continue setState)', {
                  organizationId, spaceId, err,
                })
              }
            }

            set((state) => {
              const otherSpaces = organizationId
                ? state.spaces.filter(s => s.organization_id !== organizationId)
                : []
              const sortedIncoming = [...response.spaces].sort(compareSpacesByStableOrder)
              return {
                spaces: [...otherSpaces, ...sortedIncoming],
                ...(!isBatchLoad ? { isLoading: false } : {}),
                error: null,
                loadRetryCount: 0,
                lastLoadError: null,
                loadErrorByOrganizationId: organizationId
                  ? Object.fromEntries(
                      Object.entries(state.loadErrorByOrganizationId).filter(([id]) => id !== organizationId),
                    )
                  : {},
                lastLoadedOrganizationId: organizationId ?? null,
                loadedOrganizationIds: organizationId
                  ? Array.from(new Set([...state.loadedOrganizationIds, organizationId]))
                  : state.loadedOrganizationIds,
              }
            })
            if (removedSpaceIds.length > 0) {
              log.info('Space list loaded (merge):', response.spaces.length, 'for organization:', organizationId ?? 'all', 'removed:', removedSpaceIds.length)
            } else {
              log.info('Space list loaded (merge):', response.spaces.length, 'for organization:', organizationId ?? 'all')
            }

            // ：不再按 Space/Workspace.agent_id 预取 Agent
          } catch (error) {
            if (!isLatestSpaceLoad(cacheKey, requestId, organizationId)) return
            log.error('Failed to load Space list:', error)
            const errorMessage = error instanceof Error ? error.message : 'Failed to load spaces'

            if (_spaceRetryTimer) {
              clearTimeout(_spaceRetryTimer)
              _spaceRetryTimer = null
            }
            const retryCount = get().loadRetryCount + 1
            set({
              error: errorMessage,
              ...(!isBatchLoad ? { isLoading: false } : {}),
              loadRetryCount: retryCount,
              lastLoadError: errorMessage,
              loadErrorByOrganizationId: organizationId
                ? { ...get().loadErrorByOrganizationId, [organizationId]: errorMessage }
                : get().loadErrorByOrganizationId,
              lastLoadedOrganizationId: null,
              loadedOrganizationIds: organizationId
                ? get().loadedOrganizationIds.filter((id) => id !== organizationId)
                : [],
            })
            if (retryCount <= 3) {
              const delay = Math.min(2000 * Math.pow(2, retryCount - 1), 8000)
              log.info('Will retry loadSpaces in %dms (attempt %d/3)', delay, retryCount)
              _spaceRetryTimer = setTimeout(() => {
                _spaceRetryTimer = null
                get().loadSpaces(organizationId)
              }, delay)
            }
          }
        })()

        spaceLoadPromises.set(cacheKey, loader)
        try {
          await loader
        } finally {
          if (spaceLoadPromises.get(cacheKey) === loader) {
            spaceLoadPromises.delete(cacheKey)
          }
        }
      },

      loadAllOrganizationSpaces: async (organizationIds) => {
        if (organizationIds.length === 0) return
        _batchLoadCounter++
        set({ isLoading: true, error: null })
        try {
          await Promise.all(organizationIds.map(id => get().loadSpaces(id)))
        } finally {
          _batchLoadCounter--
          if (_batchLoadCounter === 0) {
            set({ isLoading: false })
          }
        }
      },

      refreshSpace: async (id) => {
        try {
          // ：/spaces/{id} 已 410；用组织内 Workspace+Project 列表重载单条。
          const current = get().spaces.find((space) => space.id === id)
          const organizationId = current?.organization_id
          if (organizationId) {
            await get().loadSpaces(organizationId)
          } else {
            const workspaces = await WorkspaceApiService.list()
            const match = workspaces.find((workspace) => workspace.id === id)
            if (!match) {
              throw new Error('Workspace not found')
            }
            const freshSpace = workspaceToSpaceLike(match)
            set((state) => ({
              spaces: state.spaces.map((space) => (space.id === id ? freshSpace : space)),
              selectedSpace: state.selectedSpace?.id === id ? freshSpace : state.selectedSpace,
            }))
          }
          const fresh = get().spaces.find((space) => space.id === id)
          log.info('Space refreshed:', fresh?.name ?? id)
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Failed to refresh space'
          log.error('Failed to refresh Space:', error)
          set({ error: errorMessage })
        }
      },

      getSpaceStats: async (id) => {
        // ：/spaces/{id}/stats 已 410；统计能力随 Space 壳退役，返回空壳避免调用方崩。
        const current = get().spaces.find((space) => space.id === id)
        log.info('Space stats retired ; returning empty stats', { id })
        return {
          space_id: id,
          space_name: current?.name ?? '',
          status: current?.status ?? 'active',
          is_archived: current?.is_archived ?? false,
          table_count: current?.table_count ?? 0,
          active_table_count: 0,
          total_records: 0,
          created_at: current?.created_at ?? '',
          updated_at: current?.updated_at ?? '',
        }
      },

      clearSpaces: () => {
        if (_spaceRetryTimer) {
          clearTimeout(_spaceRetryTimer)
          _spaceRetryTimer = null
        }
        if (_spaceRefreshDebounceTimer) {
          clearTimeout(_spaceRefreshDebounceTimer)
          _spaceRefreshDebounceTimer = null
        }
        spaceLoadPromises.clear()
        latestSpaceLoadRequestIdByOrganization.clear()
        _spaceWsInitialized = false
        set({
          spaces: [],
          selectedSpace: null,
          agentCache: {},
          selectedAgent: null,
          isLoading: false,
          isCreating: false,
          error: null,
          loadRetryCount: 0,
          lastLoadError: null,
          loadErrorByOrganizationId: {},
          lastLoadedOrganizationId: null,
          loadedOrganizationIds: [],
        })
        notifyWorkspaceContextChanged(null)
        log.info('Space data cleared')
      },

      initSpaceWsListener: (gateway) => {
        if (_spaceWsInitialized) return

        gateway.addListener((envelope: any) => {
          if (envelope?.type !== 'space_list_changed') return
          const { action, space_id, organization_id } = envelope

          switch (action) {
            case 'created':
            case 'restored': {
              if (organization_id) {
                if (_spaceRefreshDebounceTimer) clearTimeout(_spaceRefreshDebounceTimer)
                _spaceRefreshDebounceTimer = setTimeout(() => {
                  _spaceRefreshDebounceTimer = null
                  get().loadSpaces(organization_id)
                }, 500)
              }
              break
            }
            case 'updated':
              if (space_id) get().refreshSpace(space_id)
              break
            case 'archived':
            case 'trashed':
            case 'deleted':
            case 'permanently_deleted': {
              // 状态迁移：其他端/管理员删除或归档，本端被动同步——记下来便于对齐时间线
              log.info('Space removed via WS push:', { spaceId: space_id, action })
              const wasSelected = get().selectedSpace?.id === space_id
              const preservedOrganizationId = wasSelected
                ? (get().selectedSpace?.organization_id ?? useOrganizationStore.getState().selectedOrganization?.id ?? null)
                : null
              set((state) => {
                const isSelected = state.selectedSpace?.id === space_id
                return {
                  spaces: state.spaces.filter(s => s.id !== space_id),
                  ...(isSelected ? { selectedSpace: null, selectedAgent: null } : {}),
                }
              })
              if (wasSelected) {
                notifyWorkspaceContextChanged(null)
                getRuntime().bridge.setActiveSpace(null, null, preservedOrganizationId)
              }
              if (space_id) {
                getRuntime().bridge.onSpaceDeleted?.(space_id)
              }
              break
            }
          }
        })

        gateway.onReconnectedEvent(() => {
          const organizationId = useOrganizationStore.getState().selectedOrganization?.id
          if (organizationId) get().loadSpaces(organizationId)
        })

        _spaceWsInitialized = true
        log.info('Space WS listener initialized')
      },
    }),
    withPersistSafety({
      name: 'tabtin-agent-space-store',
      partialize: (): SpaceStorePersistState => ({}),
      version: 4,
      migrate: (_persistedState: any, version: number) => {
        if (version < 4) return {}
        return {}
      },
    })
  )
)

registerResetAction('agent-space', 'reset', () => useSpaceStore.getState().clearSpaces())
