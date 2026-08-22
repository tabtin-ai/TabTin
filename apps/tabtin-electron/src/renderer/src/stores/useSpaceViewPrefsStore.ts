/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { useSpaceStore } from './useSpaceStore'
import { buildOrganizationUserPrefsKey } from '@components/layout/workspaceContextState'
import {
  SIDEBAR_LAYOUT_DEFAULT_V8,
  SIDEBAR_LAYOUT_DEFAULT_V10,
  SIDEBAR_LAYOUT_DEFAULT_V11,
  SIDEBAR_LAYOUT_DEFAULT_WIDTH,
  SIDEBAR_LAYOUT_HISTORICAL_DEFAULTS,
  SIDEBAR_LAYOUT_MAX_WIDTH,
  SIDEBAR_LAYOUT_MIN_WIDTH,
} from './sidebarLayoutConstants'
import {
  DEFAULT_WORKSPACE_LIST_SORT_MODE,
  type WorkspaceListSortMode,
} from '@/utils/workspace-list-sort'
import { isActivityRailDomainId, type ActivityRailDomainId } from '@components/layout/activityRailOrder'

export type { WorkspaceListSortMode } from '@/utils/workspace-list-sort'
export type SpacePanelMode = 'desktop' | 'windows'
import type { CloudDocsBrowseView } from '@components/layout/cloudDocsOpenTabs'

export type { CloudDocsBrowseView }
export type ResourceScope = 'space' | 'organization'
export type SidebarMode = 'desktop' | 'conversations'
export type TaskViewMode = 'chat-focus' | 'split' | 'app-focus'

export const SIDEBAR_TABS_MIN_WIDTH = SIDEBAR_LAYOUT_MIN_WIDTH
export const SIDEBAR_TABS_MAX_WIDTH = SIDEBAR_LAYOUT_MAX_WIDTH
/** @deprecated 仅 migration / 测试引用历史默认宽度 */
export const LEGACY_SIDEBAR_TABS_DEFAULT_WIDTH = SIDEBAR_LAYOUT_DEFAULT_V8
/** @deprecated 仅 migration / 测试引用历史默认宽度 */
export const PREVIOUS_SIDEBAR_TABS_DEFAULT_WIDTH = SIDEBAR_LAYOUT_DEFAULT_V10
export const SIDEBAR_TABS_DEFAULT_WIDTH = SIDEBAR_LAYOUT_DEFAULT_WIDTH

interface SpaceViewPrefs {
  sidebarTabsWidth: number
  panelMode: SpacePanelMode
  resourceScope: ResourceScope
  sidebarMode: SidebarMode
  /** 云盘页「分享给我」视图是否打开 */
  cloudSharedViewOpen?: boolean
  /** 云文档侧栏浏览分段（全部 / 最近 / 分享给我） */
  cloudDocsBrowseView?: CloudDocsBrowseView
  /** 云文档侧栏底部「当前打开」Dock 是否折叠 */
  cloudDocsOpenTabsDockCollapsed?: boolean
  /**
   * 对话模式（sidebarMode='conversations'，chatPosition='middle'）下，
   * 右侧画布是否被折叠。语义对齐桌面模式的 chatSidePanelCollapsed：
   * 折叠按钮折"非主位"那个面板。
   *
   * **默认折叠**（`CONVERSATION_CANVAS_COLLAPSED_DEFAULT`）：进 Space 跟 Agent 对话时
   * 右侧工作台默认收起，让用户聚焦对话心流，需要时再用 ChatSidePanel 的「展开画布」
   * 按钮 / ⌘J 手动拉回。用户对某个 Space 的手动展开/折叠会 per-scope 记住。
   *
   * 桌面模式时这个字段不参与渲染（画布是主位，effectiveCanvasCollapsed 恒 false）。
   */
  canvasCollapsed?: boolean
}

/**
 * 对话模式右侧画布的默认折叠态。改为 true：默认收起工作台、聚焦对话心流。
 * 只作为「该 scope 尚无显式偏好」时的兜底；用户手动展开/折叠后走 per-scope 记忆。
 */
const CONVERSATION_CANVAS_COLLAPSED_DEFAULT = true

/**
 * Agent 任务（conversation:）与 IM 会话桌面（im:）都用三态视图记忆画布折叠。
 * 展开/收起画布时必须双向同步 taskViewMode，否则标签栏「收起」会因 mode 已是
 * chat-focus 而空操作（消息侧尤其常见）。
 */
function shouldMirrorTaskViewMode(scopeKey: string): boolean {
  return scopeKey.startsWith('conversation:') || scopeKey.startsWith('im:')
}

const DEFAULT_PREFS: SpaceViewPrefs = {
  sidebarTabsWidth: SIDEBAR_TABS_DEFAULT_WIDTH,
  panelMode: 'desktop',
  resourceScope: 'organization',
  sidebarMode: 'desktop',
  cloudSharedViewOpen: false,
  cloudDocsBrowseView: 'all',
  cloudDocsOpenTabsDockCollapsed: false,
  canvasCollapsed: CONVERSATION_CANVAS_COLLAPSED_DEFAULT,
}

const MAX_PINNED_AGENTS = 4

interface SpaceViewPrefsState {
  prefsBySpace: Record<string, SpaceViewPrefs>
  /** Phase 5：desktop/conversation 切换按 Organization+User 记忆，不再 per-Space 串台 */
  sidebarModeByOrganizationUser: Record<string, SidebarMode>
  /** Phase 5：对话模式画布折叠态按 workspace scope key 隔离 */
  canvasCollapsedByScopeKey: Record<string, boolean>
  /** 云文档知识库树展开节点（按 tabScopeKey 隔离） */
  cloudDocsExpandedNodeIdsByScopeKey: Record<string, string[]>
  /** 任务布局三态按 conversation scope 隔离，避免切任务串现场。 */
  taskViewModeByScopeKey: Record<string, TaskViewMode>
  /** 新任务默认执行现场：按组织记住用户最后主动使用的个人 Workspace。 */
  lastUsedWorkspaceIdByOrganization: Record<string, string>
  /** 云盘当前浏览文件夹：云盘资源桶按组织共享，因此不能按 Space 记忆。 */
  cloudDriveBrowseFolderIdByOrganization: Record<string, string>
  pinnedAgentIds: string[]
  /** 侧栏 WORKSPACE 列表排序：名称固定 / 最近活跃 */
  workspaceListSortMode: WorkspaceListSortMode
  /**
   * ActivityRail 五大域的用户自定义顺序（全量，含当前不可见域）。
   * undefined = 从未拖过，按默认顺序；读取经 resolveRailDomainOrder 归一化。
   */
  activityRailDomainOrder?: ActivityRailDomainId[]
  getPrefs: (spaceId: string) => SpaceViewPrefs
  getSidebarMode: (organizationId: string | null, userId: string | null, legacySpaceId?: string | null) => SidebarMode
  setSidebarModeForOrganizationUser: (organizationId: string, userId: string, mode: SidebarMode) => void
  getCanvasCollapsed: (scopeKey: string, legacySpaceId?: string | null) => boolean
  setCanvasCollapsedForScope: (scopeKey: string, collapsed: boolean) => void
  toggleCanvasCollapsedForScope: (scopeKey: string) => void
  getTaskViewMode: (scopeKey: string) => TaskViewMode
  setTaskViewModeForScope: (scopeKey: string, mode: TaskViewMode) => void
  clearTaskViewModeForScope: (scopeKey: string) => void
  getLastUsedWorkspaceId: (organizationId: string | null | undefined) => string | null
  setLastUsedWorkspaceId: (organizationId: string, workspaceId: string) => void
  getCloudDriveBrowseFolderId: (organizationId: string | null | undefined) => string | null
  setCloudDriveBrowseFolderId: (organizationId: string, folderId: string | null) => void
  setSidebarTabsWidth: (spaceId: string, width: number) => void
  setPanelMode: (spaceId: string, mode: SpacePanelMode) => void
  setResourceScope: (spaceId: string, scope: ResourceScope) => void
  setSidebarMode: (spaceId: string, mode: SidebarMode) => void
  setCloudSharedViewOpen: (spaceId: string, open: boolean) => void
  setCloudDocsBrowseView: (spaceId: string, view: CloudDocsBrowseView) => void
  setCloudDocsOpenTabsDockCollapsed: (spaceId: string, collapsed: boolean) => void
  getCloudDocsExpandedNodeIds: (tabScopeKey: string) => string[]
  toggleCloudDocsExpandedNode: (tabScopeKey: string, nodeId: string) => void
  setCloudDocsExpandedNodeIds: (tabScopeKey: string, nodeIds: string[]) => void
  togglePinnedAgent: (spaceId: string) => void
  setWorkspaceListSortMode: (mode: WorkspaceListSortMode) => void
  setActivityRailDomainOrder: (order: ActivityRailDomainId[]) => void
  /** 对话模式下右侧画布的折叠开关（per-space） */
  setCanvasCollapsed: (spaceId: string, collapsed: boolean) => void
  toggleCanvasCollapsed: (spaceId: string) => void
}

export const useSpaceViewPrefsStore = create<SpaceViewPrefsState>()(
  persist(
    (set, get) => ({
      prefsBySpace: {},
      sidebarModeByOrganizationUser: {},
      canvasCollapsedByScopeKey: {},
      cloudDocsExpandedNodeIdsByScopeKey: {},
      taskViewModeByScopeKey: {},
      lastUsedWorkspaceIdByOrganization: {},
      cloudDriveBrowseFolderIdByOrganization: {},
      pinnedAgentIds: [],
      workspaceListSortMode: DEFAULT_WORKSPACE_LIST_SORT_MODE,
      activityRailDomainOrder: undefined,

      getSidebarMode: (organizationId, userId, legacySpaceId) => {
        if (organizationId && userId) {
          const key = buildOrganizationUserPrefsKey({ organizationId, userId })
          const stored = get().sidebarModeByOrganizationUser[key]
          if (stored) return stored
        }
        if (legacySpaceId) {
          return get().getPrefs(legacySpaceId).sidebarMode ?? DEFAULT_PREFS.sidebarMode
        }
        return DEFAULT_PREFS.sidebarMode
      },

      setSidebarModeForOrganizationUser: (organizationId, userId, mode) => {
        const key = buildOrganizationUserPrefsKey({ organizationId, userId })
        set(state => {
          if (state.sidebarModeByOrganizationUser[key] === mode) return state
          return {
            sidebarModeByOrganizationUser: {
              ...state.sidebarModeByOrganizationUser,
              [key]: mode,
            },
          }
        })
      },

      getCanvasCollapsed: (scopeKey, legacySpaceId) => {
        const byScope = get().canvasCollapsedByScopeKey
        if (scopeKey in byScope) {
          return byScope[scopeKey] ?? CONVERSATION_CANVAS_COLLAPSED_DEFAULT
        }
        if (legacySpaceId) {
          // 只有 legacy per-space 记录里存过显式布尔值才尊重它；否则回落到默认（折叠）。
          const legacy = get().prefsBySpace[legacySpaceId]?.canvasCollapsed
          if (typeof legacy === 'boolean') return legacy
        }
        return CONVERSATION_CANVAS_COLLAPSED_DEFAULT
      },

      setCanvasCollapsedForScope: (scopeKey, collapsed) => {
        set(state => {
          const current = state.canvasCollapsedByScopeKey[scopeKey] ?? CONVERSATION_CANVAS_COLLAPSED_DEFAULT
          const currentMode = state.taskViewModeByScopeKey[scopeKey]
          // 展开画布时：已在 app-focus 则保持【右】，勿镜像成 split
          const nextTaskViewMode = !shouldMirrorTaskViewMode(scopeKey)
            ? null
            : collapsed
              ? 'chat-focus'
              : currentMode === 'app-focus'
                ? 'app-focus'
                : 'split'
          if (
            current === collapsed
            && (!nextTaskViewMode || state.taskViewModeByScopeKey[scopeKey] === nextTaskViewMode)
          ) return state
          return {
            canvasCollapsedByScopeKey: {
              ...state.canvasCollapsedByScopeKey,
              [scopeKey]: collapsed,
            },
            ...(nextTaskViewMode ? {
              taskViewModeByScopeKey: {
                ...state.taskViewModeByScopeKey,
                [scopeKey]: nextTaskViewMode,
              },
            } : {}),
          }
        })
      },

      toggleCanvasCollapsedForScope: (scopeKey) => {
        set(state => {
          const collapsed = !(state.canvasCollapsedByScopeKey[scopeKey] ?? CONVERSATION_CANVAS_COLLAPSED_DEFAULT)
          const currentMode = state.taskViewModeByScopeKey[scopeKey]
          const nextMode = !shouldMirrorTaskViewMode(scopeKey)
            ? null
            : collapsed
              ? 'chat-focus'
              : currentMode === 'app-focus'
                ? 'app-focus'
                : 'split'
          return {
            canvasCollapsedByScopeKey: {
              ...state.canvasCollapsedByScopeKey,
              [scopeKey]: collapsed,
            },
            ...(nextMode ? {
              taskViewModeByScopeKey: {
                ...state.taskViewModeByScopeKey,
                [scopeKey]: nextMode,
              },
            } : {}),
          }
        })
      },

      getTaskViewMode: (scopeKey) => {
        const stored = get().taskViewModeByScopeKey[scopeKey]
        if (stored) return stored
        return get().getCanvasCollapsed(scopeKey) ? 'chat-focus' : 'split'
      },

      setTaskViewModeForScope: (scopeKey, mode) => {
        set(state => {
          const nextCollapsed = mode === 'chat-focus'
          const currentCollapsed = state.canvasCollapsedByScopeKey[scopeKey] ?? CONVERSATION_CANVAS_COLLAPSED_DEFAULT
          // mode 已是目标值但 canvasCollapsed 脱节时仍要写回，否则消息侧标签栏
          // 「收起画布」会因为 early-return 变成空按钮。
          if (
            state.taskViewModeByScopeKey[scopeKey] === mode
            && currentCollapsed === nextCollapsed
          ) return state
          return {
            taskViewModeByScopeKey: {
              ...state.taskViewModeByScopeKey,
              [scopeKey]: mode,
            },
            // 兼容仍以 canvasCollapsed 驱动画布展开的资源打开链路。
            canvasCollapsedByScopeKey: {
              ...state.canvasCollapsedByScopeKey,
              [scopeKey]: nextCollapsed,
            },
          }
        })
      },

      clearTaskViewModeForScope: (scopeKey) => {
        set(state => {
          if (
            !(scopeKey in state.taskViewModeByScopeKey)
            && !(scopeKey in state.canvasCollapsedByScopeKey)
          ) return state
          const taskViewModeByScopeKey = { ...state.taskViewModeByScopeKey }
          const canvasCollapsedByScopeKey = { ...state.canvasCollapsedByScopeKey }
          delete taskViewModeByScopeKey[scopeKey]
          delete canvasCollapsedByScopeKey[scopeKey]
          return { taskViewModeByScopeKey, canvasCollapsedByScopeKey }
        })
      },

      getLastUsedWorkspaceId: (organizationId) => {
        if (!organizationId) return null
        return get().lastUsedWorkspaceIdByOrganization[organizationId] ?? null
      },

      setLastUsedWorkspaceId: (organizationId, workspaceId) => {
        if (!organizationId || !workspaceId) return
        set(state => {
          if (state.lastUsedWorkspaceIdByOrganization[organizationId] === workspaceId) {
            return state
          }
          return {
            lastUsedWorkspaceIdByOrganization: {
              ...state.lastUsedWorkspaceIdByOrganization,
              [organizationId]: workspaceId,
            },
          }
        })
      },

      getCloudDriveBrowseFolderId: (organizationId) => {
        if (!organizationId) return null
        return get().cloudDriveBrowseFolderIdByOrganization[organizationId] ?? null
      },

      setCloudDriveBrowseFolderId: (organizationId, folderId) => {
        if (!organizationId) return
        set(state => {
          const current = state.cloudDriveBrowseFolderIdByOrganization[organizationId] ?? null
          if (current === folderId) return state
          const next = { ...state.cloudDriveBrowseFolderIdByOrganization }
          if (folderId) next[organizationId] = folderId
          else delete next[organizationId]
          return { cloudDriveBrowseFolderIdByOrganization: next }
        })
      },

      getPrefs: (spaceId) => {
        const raw = get().prefsBySpace[spaceId] ?? DEFAULT_PREFS
        const organizationScope = resolveResourceScopeForSpace(get().prefsBySpace, spaceId)
        const prefs: SpaceViewPrefs = {
          sidebarTabsWidth: raw.sidebarTabsWidth ?? SIDEBAR_TABS_DEFAULT_WIDTH,
          panelMode: raw.panelMode ?? DEFAULT_PREFS.panelMode,
          resourceScope: organizationScope ?? raw.resourceScope ?? DEFAULT_PREFS.resourceScope,
          sidebarMode: raw.sidebarMode ?? DEFAULT_PREFS.sidebarMode,
          cloudSharedViewOpen: raw.cloudSharedViewOpen ?? false,
          cloudDocsBrowseView: raw.cloudDocsBrowseView ?? 'all',
          cloudDocsOpenTabsDockCollapsed: raw.cloudDocsOpenTabsDockCollapsed ?? false,
          canvasCollapsed: raw.canvasCollapsed ?? CONVERSATION_CANVAS_COLLAPSED_DEFAULT,
        }
        const clampedWidth = Math.max(
          SIDEBAR_TABS_MIN_WIDTH,
          Math.min(SIDEBAR_TABS_MAX_WIDTH, prefs.sidebarTabsWidth),
        )
        if (clampedWidth !== prefs.sidebarTabsWidth) {
          return { ...prefs, sidebarTabsWidth: clampedWidth }
        }
        return prefs
      },

      setSidebarTabsWidth: (spaceId, width) => {
        const clamped = Math.max(SIDEBAR_TABS_MIN_WIDTH, Math.min(SIDEBAR_TABS_MAX_WIDTH, Math.round(width)))
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          if (existing.sidebarTabsWidth === clamped) return state
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: { ...existing, sidebarTabsWidth: clamped },
            },
          }
        })
      },

      setPanelMode: (spaceId, mode) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          if (existing.panelMode === mode) return state
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: { ...existing, panelMode: mode },
            },
          }
        })
      },

      setResourceScope: (spaceId, scope) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          const organizationKey = getOrganizationPrefsKey(spaceId)
          const nextPrefsBySpace = { ...state.prefsBySpace }
          const previousEffective = resolveResourceScopeForSpace(state.prefsBySpace, spaceId) ?? existing.resourceScope
          if (previousEffective === scope && organizationKey && nextPrefsBySpace[organizationKey]?.resourceScope === scope) {
            return state
          }

          if (organizationKey) {
            const organizationExisting = nextPrefsBySpace[organizationKey] ?? DEFAULT_PREFS
            nextPrefsBySpace[organizationKey] = { ...organizationExisting, resourceScope: scope }
          } else {
            nextPrefsBySpace[spaceId] = { ...existing, resourceScope: scope }
          }

          return {
            prefsBySpace: nextPrefsBySpace,
          }
        })
      },

      setSidebarMode: (spaceId, mode) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          if (existing.sidebarMode === mode) return state
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: { ...existing, sidebarMode: mode },
            },
          }
        })
      },

      setCloudSharedViewOpen: (spaceId, open) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          if ((existing.cloudSharedViewOpen ?? false) === open) return state
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: { ...existing, cloudSharedViewOpen: open },
            },
          }
        })
      },

      setCloudDocsBrowseView: (spaceId, view) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          if ((existing.cloudDocsBrowseView ?? 'all') === view) return state
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: { ...existing, cloudDocsBrowseView: view },
            },
          }
        })
      },

      setCloudDocsOpenTabsDockCollapsed: (spaceId, collapsed) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          if ((existing.cloudDocsOpenTabsDockCollapsed ?? false) === collapsed) return state
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: { ...existing, cloudDocsOpenTabsDockCollapsed: collapsed },
            },
          }
        })
      },

      getCloudDocsExpandedNodeIds: (tabScopeKey) => {
        return get().cloudDocsExpandedNodeIdsByScopeKey[tabScopeKey] ?? []
      },

      toggleCloudDocsExpandedNode: (tabScopeKey, nodeId) => {
        set(state => {
          const current = state.cloudDocsExpandedNodeIdsByScopeKey[tabScopeKey] ?? []
          const exists = current.includes(nodeId)
          const next = exists ? current.filter(id => id !== nodeId) : [...current, nodeId]
          return {
            cloudDocsExpandedNodeIdsByScopeKey: {
              ...state.cloudDocsExpandedNodeIdsByScopeKey,
              [tabScopeKey]: next,
            },
          }
        })
      },

      setCloudDocsExpandedNodeIds: (tabScopeKey, nodeIds) => {
        set(state => ({
          cloudDocsExpandedNodeIdsByScopeKey: {
            ...state.cloudDocsExpandedNodeIdsByScopeKey,
            [tabScopeKey]: nodeIds,
          },
        }))
      },

      togglePinnedAgent: (spaceId) => {
        set(state => {
          const current = state.pinnedAgentIds
          if (current.includes(spaceId)) {
            return { pinnedAgentIds: current.filter(id => id !== spaceId) }
          }
          const next = [...current, spaceId]
          if (next.length > MAX_PINNED_AGENTS) next.shift()
          return { pinnedAgentIds: next }
        })
      },

      setWorkspaceListSortMode: (mode) => {
        set(state => {
          if (state.workspaceListSortMode === mode) return state
          return { workspaceListSortMode: mode }
        })
      },

      setActivityRailDomainOrder: (order) => {
        set(state => {
          const current = state.activityRailDomainOrder
          if (
            current
            && current.length === order.length
            && current.every((id, index) => id === order[index])
          ) return state
          return { activityRailDomainOrder: [...order] }
        })
      },

      setCanvasCollapsed: (spaceId, collapsed) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          if ((existing.canvasCollapsed ?? false) === collapsed) return state
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: { ...existing, canvasCollapsed: collapsed },
            },
          }
        })
      },

      toggleCanvasCollapsed: (spaceId) => {
        set(state => {
          const existing = state.prefsBySpace[spaceId] ?? DEFAULT_PREFS
          return {
            prefsBySpace: {
              ...state.prefsBySpace,
              [spaceId]: {
                ...existing,
                canvasCollapsed: !(existing.canvasCollapsed ?? false),
              },
            },
          }
        })
      },
    }),
    withPersistSafety({
      name: PERSIST_KEYS.spaceView,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-space-view-prefs'])),
      version: 19,
      partialize: (state) => ({
        prefsBySpace: state.prefsBySpace,
        sidebarModeByOrganizationUser: state.sidebarModeByOrganizationUser,
        canvasCollapsedByScopeKey: state.canvasCollapsedByScopeKey,
        cloudDocsExpandedNodeIdsByScopeKey: state.cloudDocsExpandedNodeIdsByScopeKey,
        taskViewModeByScopeKey: state.taskViewModeByScopeKey,
        lastUsedWorkspaceIdByOrganization: state.lastUsedWorkspaceIdByOrganization,
        cloudDriveBrowseFolderIdByOrganization: state.cloudDriveBrowseFolderIdByOrganization,
        pinnedAgentIds: state.pinnedAgentIds,
        workspaceListSortMode: state.workspaceListSortMode,
        activityRailDomainOrder: state.activityRailDomainOrder,
      }),
      migrate: (persistedState: unknown, version: number) => {
        let state = (persistedState ?? {}) as {
          prefsBySpace?: Record<string, SpaceViewPrefs>
          pinnedAgentIds?: string[]
          sidebarModeByOrganizationUser?: Record<string, SidebarMode>
          canvasCollapsedByScopeKey?: Record<string, boolean>
          cloudDocsExpandedNodeIdsByScopeKey?: Record<string, string[]>
          taskViewModeByScopeKey?: Record<string, TaskViewMode>
          lastUsedWorkspaceIdByOrganization?: Record<string, string>
          cloudDriveBrowseFolderIdByOrganization?: Record<string, string>
          workspaceListSortMode?: WorkspaceListSortMode
          activityRailDomainOrder?: unknown
        }
        if (version < 1 && state.prefsBySpace) {
          const migrated = { ...state.prefsBySpace }
          for (const [spaceId, prefs] of Object.entries(migrated)) {
            if (prefs.resourceScope === 'space') {
              migrated[spaceId] = { ...prefs, resourceScope: 'organization' }
            }
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 2 && state.prefsBySpace) {
          state = { ...state, prefsBySpace: migrateResourceScopesToOrganizationKeys(state.prefsBySpace) }
        }
        if (version < 3 && state.prefsBySpace) {
          const migrated = { ...state.prefsBySpace }
          for (const [key, prefs] of Object.entries(migrated)) {
            if (!prefs.sidebarMode) {
              migrated[key] = { ...prefs, sidebarMode: 'desktop' }
            }
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 4) {
          if (state.prefsBySpace) {
            const migrated = { ...state.prefsBySpace }
            for (const [key, prefs] of Object.entries(migrated)) {
              if ((prefs.sidebarMode as string) === 'agents') {
                migrated[key] = { ...prefs, sidebarMode: 'desktop' }
              }
            }
            state = { ...state, prefsBySpace: migrated }
          }
          if (!state.pinnedAgentIds) {
            state = { ...state, pinnedAgentIds: [] }
          }
        }
        // v5 migration（conversationCanvasFold 补默认值）已随对话画板拆除
        // 一并移除：残留的 conversationCanvasFold 字段无消费方，留在持久化里无害。
        if (version < 6 && state.prefsBySpace) {
          // v6：对话模式下右侧画布折叠态，旧记录默认未折叠
          const migrated = { ...state.prefsBySpace }
          for (const [key, prefs] of Object.entries(migrated)) {
            if (typeof prefs.canvasCollapsed !== 'boolean') {
              migrated[key] = { ...prefs, canvasCollapsed: false }
            }
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 7 && state.prefsBySpace) {
          // v7：云盘「分享给我」开关，旧记录默认关闭
          const migrated = { ...state.prefsBySpace }
          for (const [key, prefs] of Object.entries(migrated)) {
            if (typeof prefs.cloudSharedViewOpen !== 'boolean') {
              migrated[key] = { ...prefs, cloudSharedViewOpen: false }
            }
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 8) {
          const sidebarModeByOrganizationUser = { ...(state.sidebarModeByOrganizationUser ?? {}) }
          const canvasCollapsedByScopeKey = { ...(state.canvasCollapsedByScopeKey ?? {}) }
          if (state.prefsBySpace) {
            for (const [key, prefs] of Object.entries(state.prefsBySpace)) {
              if (key.startsWith('organization-user:')) continue
              if (key.startsWith('organization:')) {
                const organizationId = key.slice('organization:'.length)
                const userKey = `organization-user:${organizationId}:anonymous`
                if (!sidebarModeByOrganizationUser[userKey] && prefs.sidebarMode) {
                  sidebarModeByOrganizationUser[userKey] = prefs.sidebarMode
                }
              }
              if (typeof prefs.canvasCollapsed === 'boolean' && !canvasCollapsedByScopeKey[key]) {
                canvasCollapsedByScopeKey[key] = prefs.canvasCollapsed
              }
            }
          }
          state = {
            ...state,
            sidebarModeByOrganizationUser,
            canvasCollapsedByScopeKey,
          }
        }
        if (version < 9 && state.prefsBySpace) {
          const migrated = { ...state.prefsBySpace }
          for (const [key, prefs] of Object.entries(migrated)) {
            if (prefs.sidebarTabsWidth === SIDEBAR_LAYOUT_DEFAULT_V8) {
              migrated[key] = { ...prefs, sidebarTabsWidth: SIDEBAR_LAYOUT_DEFAULT_V10 }
            }
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 10 && state.prefsBySpace) {
          const migrated = { ...state.prefsBySpace }
          for (const [key, prefs] of Object.entries(migrated)) {
            if (
              prefs.sidebarTabsWidth === SIDEBAR_LAYOUT_DEFAULT_V8
              || prefs.sidebarTabsWidth === SIDEBAR_LAYOUT_DEFAULT_V10
            ) {
              migrated[key] = { ...prefs, sidebarTabsWidth: SIDEBAR_LAYOUT_DEFAULT_V11 }
            }
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 11 && state.prefsBySpace) {
          const migrated = { ...state.prefsBySpace }
          for (const [key, prefs] of Object.entries(migrated)) {
            if (SIDEBAR_LAYOUT_HISTORICAL_DEFAULTS.has(prefs.sidebarTabsWidth)) {
              migrated[key] = { ...prefs, sidebarTabsWidth: SIDEBAR_TABS_DEFAULT_WIDTH }
            }
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 12) {
          // v12：对话模式右侧画布默认从「展开」改为「折叠」（聚焦对话心流）。
          // 历史 canvasCollapsedByScopeKey 里绝大多数条目是切到桌面模式时由旧
          // 「切桌面自动重置画布展开」逻辑写入的 false 噪音（该逻辑已随本次一并移除），
          // 会盖掉新默认；legacy prefsBySpace.canvasCollapsed 同理。全部清掉，让所有
          // scope 回落到新默认（折叠）。用户之后对需要工作台的 Space 手动展开会被 per-scope 记住。
          state = { ...state, canvasCollapsedByScopeKey: {} }
          if (state.prefsBySpace) {
            const migrated = { ...state.prefsBySpace }
            for (const [key, prefs] of Object.entries(migrated)) {
              if ('canvasCollapsed' in prefs) {
                const { canvasCollapsed: _legacyCanvasCollapsed, ...rest } = prefs
                migrated[key] = rest
              }
            }
            state = { ...state, prefsBySpace: migrated }
          }
        }
        if (version < 13) {
          // v13：侧栏 Workspace 排序偏好；缺省按名称固定
          if (
            state.workspaceListSortMode !== 'name'
            && state.workspaceListSortMode !== 'activity'
          ) {
            state = { ...state, workspaceListSortMode: DEFAULT_WORKSPACE_LIST_SORT_MODE }
          }
        }
        if (version < 14) {
          const taskViewModeByScopeKey = { ...(state.taskViewModeByScopeKey ?? {}) }
          for (const [scopeKey, collapsed] of Object.entries(state.canvasCollapsedByScopeKey ?? {})) {
            if (!scopeKey.startsWith('conversation:') || taskViewModeByScopeKey[scopeKey]) continue
            taskViewModeByScopeKey[scopeKey] = collapsed ? 'chat-focus' : 'split'
          }
          state = { ...state, taskViewModeByScopeKey }
        }
        if (version < 15 && !state.lastUsedWorkspaceIdByOrganization) {
          state = { ...state, lastUsedWorkspaceIdByOrganization: {} }
        }
        if (version < 16 && state.prefsBySpace) {
          const migrated = { ...state.prefsBySpace }
          for (const [key, prefs] of Object.entries(migrated)) {
            let next = prefs
            if (prefs.cloudDocsBrowseView !== 'all'
              && prefs.cloudDocsBrowseView !== 'recent'
              && prefs.cloudDocsBrowseView !== 'shared') {
              next = { ...next, cloudDocsBrowseView: 'all' as const }
            }
            if (typeof prefs.cloudDocsOpenTabsDockCollapsed !== 'boolean') {
              next = { ...next, cloudDocsOpenTabsDockCollapsed: false }
            }
            if (next !== prefs) migrated[key] = next
          }
          state = { ...state, prefsBySpace: migrated }
        }
        if (version < 17 && !state.cloudDocsExpandedNodeIdsByScopeKey) {
          state = { ...state, cloudDocsExpandedNodeIdsByScopeKey: {} }
        }
        if (version < 18 && !state.cloudDriveBrowseFolderIdByOrganization) {
          state = { ...state, cloudDriveBrowseFolderIdByOrganization: {} }
        }
        if (version < 19) {
          // v19：ActivityRail 域顺序偏好；非法值（非数组 / 含未知域 id）回落默认顺序
          const order = state.activityRailDomainOrder
          if (
            order !== undefined
            && (!Array.isArray(order) || order.some(id => !isActivityRailDomainId(id)))
          ) {
            state = { ...state, activityRailDomainOrder: undefined }
          }
        }
        return state
      },
    }),
  ),
)

function getOrganizationIdBySpaceId(spaceId: string): string | null {
  if (!spaceId) return null
  const space = useSpaceStore.getState().spaces.find(item => item.id === spaceId)
  return typeof space?.organization_id === 'string' ? space.organization_id : null
}

function getOrganizationPrefsKey(spaceId: string): string | null {
  const organizationId = getOrganizationIdBySpaceId(spaceId)
  return organizationId ? `organization:${organizationId}` : null
}

function resolveResourceScopeForSpace(
  prefsBySpace: Record<string, SpaceViewPrefs>,
  spaceId: string,
): ResourceScope | null {
  const organizationKey = getOrganizationPrefsKey(spaceId)
  if (!organizationKey) return null
  return prefsBySpace[organizationKey]?.resourceScope ?? null
}

function migrateResourceScopesToOrganizationKeys(
  prefsBySpace: Record<string, SpaceViewPrefs>,
): Record<string, SpaceViewPrefs> {
  const migrated = { ...prefsBySpace }
  const spaces = useSpaceStore.getState().spaces
  const latestScopeByOrganization = new Map<string, ResourceScope>()

  for (const [spaceId, prefs] of Object.entries(prefsBySpace)) {
    const space = spaces.find(item => item.id === spaceId)
    if (!space?.organization_id) continue
    latestScopeByOrganization.set(space.organization_id, prefs.resourceScope ?? DEFAULT_PREFS.resourceScope)
  }

  for (const [organizationId, scope] of latestScopeByOrganization.entries()) {
    const key = `organization:${organizationId}`
    const existing = migrated[key] ?? DEFAULT_PREFS
    migrated[key] = { ...existing, resourceScope: scope }
  }

  return migrated
}
