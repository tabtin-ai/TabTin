/**
 * SpaceContextAreaContext
 *
 * 将 SpaceContextArea 40+ props 拆分为 StateCtx（高频变化的数据）
 * 与 ActionsCtx（稳定回调引用），消除深层 prop drilling。
 *
 * 拆分原则：
 *   - StateCtx：每次标签切换 / 数据加载都可能变化，消费者按需 select
 *   - ActionsCtx：回调函数由 useCallback 包裹，引用稳定，单独一个 Context
 *     避免 state 变化导致仅消费 actions 的子树重渲染
 */

import { createContext, useContext, type ReactNode } from 'react'
import type { ContextItem } from '@components/context-space/registry'
import type { CreateResourceHandler } from './hooks/createResourceTypes'
import type { CanvasLayoutGroup, CanvasPaneContent } from '@stores/useCanvasLayoutStore'
import type { Table } from '@tabtin/table-core'
import type { SpaceContextItem } from '@tabtin/app-shell'

// ─── State ────────────────────────────────────────────────────

export interface SpaceContextAreaState {
  spaceId: string
  /** 当前 workspace 的标签 / canvas / browser scope key。 */
  tabScopeKey: string
  /** 当前 scope 的工作台恢复已完成；未完成时不显示 desktop fallback。 */
  restoreSettled?: boolean
  activeTabKey: string | null
  activeTabType: string
  activeTableId: string | null
  /**
   * 全量 tab items（含被 handler.isVisibleInContext 隐藏的，例如非当前 session 的 subagent_session）。
   * 仅供需要"全量视角"的消费方使用（如 keepAlive eviction 计算 / 检测某 tab 是否已存在等）；
   * UI 渲染（paneItems / 标签栏 / DesktopPanel）一律用 `visibleItems`。
   */
  orderedItems: ContextItem[]
  /**
   * 标签逻辑 lookup 用 items。它包含当前上下文可见的真实 tab（含 grouped panes），
   * 但不包含被 `isVisibleInContext` 隐藏的跨 session tab。
   */
  tabLookupItems: ContextItem[]
  /**
   * UI 渲染消费的过滤后 items（PRD §4.3 三集合分离）。
   * = orderedItems 经过 `groupedTabKeys` 和 handler.isVisibleInContext 过滤后的子集。
   * 任何"标签栏 / Pane 挂载 / 桌面已打开列表"等用户可视入口都必须用这一份。
   */
  visibleItems: ContextItem[]
  groupedTabKeys: Set<string>
  canvasGroups: CanvasLayoutGroup[]
  shouldShowCanvasGroup: boolean
  activeCanvasGroupId: string | null
  openTableTabs: string[]
  groupedTableIds: Set<string>
  terminalSessionIds: string[]
  groupedTerminalIds: Set<string>
  crawlspaceId?: string | null
  homeTables: Table[]
  isLoading: boolean
  error: string | null
  isCrawlspaceReady: boolean
  /**
   * 正在走网络创建的 App（tabdoc / tabdata 等）。
   * 工作台各入口据此 disabled，避免「点了没反馈 → 连点 → 报错」。
   */
  creatingAppIds: ReadonlySet<string>
}

// ─── Actions ──────────────────────────────────────────────────

export interface SpaceContextAreaActions {
  createHandlers: Record<string, CreateResourceHandler>
  onOpenAppHome: (appId: string, meta?: Record<string, unknown>) => void
  onOpenSpaceSettings: () => void
  onTableClick: (table: Table) => void
  onSearchNavigate?: (item: SpaceContextItem) => void | Promise<void>
  onSelectHome: () => void
  onSelectItem: (item: ContextItem) => void
  onCloseItem: (item: ContextItem) => void
  onRefreshItem: (item: ContextItem) => void
  onCloseOtherItems: (item: ContextItem) => void
  onCloseLeftItems: (item: ContextItem) => void
  onCloseRightItems: (item: ContextItem) => void
  onCloseOthersForGroup: (group: CanvasLayoutGroup) => void
  onCloseLeftForGroup: (group: CanvasLayoutGroup) => void
  onCloseRightForGroup: (group: CanvasLayoutGroup) => void
  onReorderItem: (dragged: ContextItem, target: ContextItem, position: 'before' | 'after') => void
  onReopenClosedTab: () => void
  onRestoreGroup: (group: CanvasLayoutGroup) => void
  buildContentFromActiveTab: () => CanvasPaneContent | null
  buildContentFromDrag: (tabKey: string, raw: string) => CanvasPaneContent | null
}

// ─── Contexts ─────────────────────────────────────────────────

const StateCtx = createContext<SpaceContextAreaState | null>(null)
const ActionsCtx = createContext<SpaceContextAreaActions | null>(null)

StateCtx.displayName = 'SpaceContextAreaState'
ActionsCtx.displayName = 'SpaceContextAreaActions'

// ─── Provider ─────────────────────────────────────────────────

export interface SpaceContextAreaProviderProps {
  state: SpaceContextAreaState
  actions: SpaceContextAreaActions
  children: ReactNode
}

export function SpaceContextAreaProvider({ state, actions, children }: SpaceContextAreaProviderProps) {
  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>
        {children}
      </ActionsCtx.Provider>
    </StateCtx.Provider>
  )
}

// ─── Hooks ────────────────────────────────────────────────────

export function useSpaceContextState(): SpaceContextAreaState {
  const ctx = useContext(StateCtx)
  if (!ctx) throw new Error('useSpaceContextState must be used within SpaceContextAreaProvider')
  return ctx
}

/** 表格等深层组件可选读取；不在 Provider 内时返回 null，不抛错。 */
export function useOptionalSpaceContextState(): SpaceContextAreaState | null {
  return useContext(StateCtx)
}

export function useSpaceContextActions(): SpaceContextAreaActions {
  const ctx = useContext(ActionsCtx)
  if (!ctx) throw new Error('useSpaceContextActions must be used within SpaceContextAreaProvider')
  return ctx
}

/** 表格等深层组件可选读取；不在 Provider 内时返回 null，不抛错。 */
export function useOptionalSpaceContextActions(): SpaceContextAreaActions | null {
  return useContext(ActionsCtx)
}
