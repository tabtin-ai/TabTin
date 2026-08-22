import { useEffect } from 'react'
import { contextRegistry } from '@components/context-space/registry'
import type { ContainerContext, ContextItem, ContextTabKey } from '@components/context-space/registry/types'
import { resolveTabItemCore } from '@components/context-space/registry/resolveUtils'
import { useCanvasLayoutStore, type CanvasPaneContent, type CanvasTabKey, type CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { findGroupForTabKey } from '../utils/canvasLayout'
import { computeFallbackTabKeyFromStore } from '../utils/activeKeyFallback'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useDiscardedViewStore } from '@hooks/useTabDiscardListener'
import { useCrawlTabStore, type CrawlspaceViewInfo } from '@stores/useCrawlTabStore'
import { createElectronIpcAdapter } from '@components/crawlspace-workspace/hooks/useCrawlSpaceViewManagerAdapter'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import {
  createTerminalSessionInScope,
  openTerminalTabInScope,
  useTerminalSessionStore,
} from '@components/context-space/sources/terminal'
import { createLogger } from '@/utils/logger'
import i18n from '@/i18n'
import { activateBrowserView } from '@/services/browserViewActivation'
import { isWebviewContainerEnabled } from '@/utils/browserContainerMode'
import { getWebviewManager } from '@/crawlspace/webview-manager/WebviewManager'
import { getWebviewKeepaliveController } from '@/crawlspace/webview-manager/webviewHostView'
import { seedManager } from '@stores/seed-manager'
import { openBrowserHomeInSpace } from '@/services/openBrowserHomeInSpace'

const log = createLogger('ContextSpaceToolHandler')

interface BasePayload {
  spaceId?: string | null
  tabScopeKey?: string | null
  workspaceScopeKey?: string | null
  crawlspaceId?: string | null
  projectId?: string | null
}

interface ListContextSpacePayload extends BasePayload {
  includeLayout?: boolean
}

export interface CloseContextTabPayload extends BasePayload {
  tabKey: string
}

export interface SetActiveContextTabPayload extends BasePayload {
  tabKey?: string | null
  paneId?: string | null
}

interface RestoreContextGroupPayload extends BasePayload {
  groupId: string
}

interface AssignPaneContentPayload extends BasePayload {
  groupId: string
  paneId: string
  tabKey: string
}

interface SplitPanePayload extends BasePayload {
  groupId: string
  paneId: string
  side: 'top' | 'right' | 'bottom' | 'left'
  tabKey: string
}

type SplitSideValue = 'left' | 'right' | 'top' | 'bottom'

interface MovePanePayload extends BasePayload {
  groupId: string
  sourcePaneId: string
  targetPaneId: string
  side: SplitSideValue
}

interface DockPanePayload extends BasePayload {
  groupId: string
  paneId: string
  side: SplitSideValue
}

interface CreateWebTabPayload extends BasePayload {
  runId?: string
  url?: string
  title?: string
  sessionName?: string
  /**  / ：本地 HTML 预览的 file:// 放行根（= 工作空间工作目录） */
  localPreviewRoot?: string
}

type OpenBrowserHomePayload = BasePayload

interface CreateSessionCrawlspacePayload extends BasePayload {
  sessionName: string
  title?: string
}

interface OpenTerminalTabPayload extends BasePayload {
  title?: string
  cwd?: string
  sessionId?: string
}

type ListTerminalSessionsPayload = BasePayload

type ListSessionsPayload = BasePayload

interface PurgeSessionPayload extends BasePayload {
  sessionName: string
}

type ActionPayloadMap = {
  list_context_space: ListContextSpacePayload
  close_context_tab: CloseContextTabPayload
  set_active_context_tab: SetActiveContextTabPayload
  restore_context_group: RestoreContextGroupPayload
  assign_pane_content: AssignPaneContentPayload
  split_pane_with_tab: SplitPanePayload
  move_pane: MovePanePayload
  dock_pane: DockPanePayload
  create_web_tab: CreateWebTabPayload
  open_browser_home: OpenBrowserHomePayload
  create_session_crawlspace: CreateSessionCrawlspacePayload
  open_terminal_tab: OpenTerminalTabPayload
  list_terminal_sessions: ListTerminalSessionsPayload
  list_sessions: ListSessionsPayload
  purge_session: PurgeSessionPayload
}

type ContextSpaceAction = keyof ActionPayloadMap

type ContextSpaceInvokePayload = {
  [K in ContextSpaceAction]: {
    requestId: string
    action: K
    payload: ActionPayloadMap[K]
  }
}[ContextSpaceAction]

/**
 * `close_context_tab` 等工具响应的可选 `code` 字段联合类型。
 *
 * 用字面量联合而非裸 `string`，让 Agent 调用方有自动补全 + 编译期防拼写错。
 *
 * 当前已定义：
 * - `CLOSE_CANCELLED`     beforeClose 钩子返回 false（用户在确认对话框中取消、保存失败、
 *                         或其他显式拒绝路径）。**这是非异常的业务结果**，不应被 Agent 当成
 *                         需要重试的错误。具体子语义（取消 vs 保存失败）通过 `error` 文案
 *                         区分；进一步细分需要升级 `dispatchBeforeClose` 接口（见遗留项）。
 * - `BEFORE_CLOSE_ERROR`  beforeClose 钩子执行抛错（如对话框被销毁、handler bug）。
 *                         **这是异常路径**，错误信息会穿透到 Agent，便于排障。
 *
 * 新增 code 时请保持 SCREAMING_SNAKE_CASE 命名 + 注释更新含义。
 * 跨包消费方（packages/action-tools）当前通过 `result.code` 透传，未做枚举映射 ——
 * 如要让 ToolError.code 标准化识别新值，需同步扩展 `ToolErrorCode` 枚举（见遗留项）。
 */
export type ContextSpaceErrorCode = 'CLOSE_CANCELLED' | 'BEFORE_CLOSE_ERROR'

type ContextSpaceResponsePayload = {
  requestId: string
  success: boolean
  data?: Record<string, unknown>
  error?: string
  code?: ContextSpaceErrorCode
}

const EMPTY_GROUPS: CanvasLayoutGroup[] = []
const EMPTY_VIEWS: CrawlspaceViewInfo[] = []
let createWebTabSequence = 0

const isCanvasTabKey = (tabKey: string): tabKey is CanvasTabKey => {
  const delimiterIndex = tabKey.indexOf(':')
  return delimiterIndex > 0 && delimiterIndex < tabKey.length - 1
}

// ---------------------------------------------------------------------------
// ContainerContext for Tool-side (no optimistic update, no rollback)
// ---------------------------------------------------------------------------

const resolveSpaceCrawlspaceId = (spaceId?: string, crawlspaceId?: string | null, scopeKey?: string | null) => {
  if (crawlspaceId) return crawlspaceId
  if (!spaceId) return null
  const store = useCrawlTabStore.getState()
  const crawlspace = scopeKey
    ? store.getScopedCrawlspace(scopeKey) ?? store.getSpaceCrawlspace(spaceId)
    : store.getSpaceCrawlspace(spaceId)
  return crawlspace?.id ?? null
}

const resolveSpaceIdFromCrawlspace = (crawlspaceId?: string | null): string | null => {
  if (!crawlspaceId) return null
  const store = useCrawlTabStore.getState()
  const tab = store.tabs.find(t => t.id === crawlspaceId && t.kind === 'workspace')
  return tab?.metadata?.crawlspaceConfig?.spaceId ?? tab?.metadata?.crawlspaceConfig?.projectId ?? null
}

const buildToolContainerCtx = (spaceId: string, crawlspaceId?: string | null, scopeKey?: string | null): ContainerContext => ({
  spaceId,
  crawlspaceId: crawlspaceId ?? resolveSpaceCrawlspaceId(spaceId, null, scopeKey),
  closeBrowserView: async (csId, viewId) => {
    // closeCrawlspaceView 是 store action，返 `{ok, code?, message?}`；失败必须 throw，
    // 让 ContainerContext caller 知道关 view 失败。
    const closeRes = await useCrawlTabStore.getState().closeCrawlspaceView(csId, viewId)
    if (!closeRes.ok) {
      throw new Error(closeRes.message || `closeBrowserView failed: ${closeRes.code}`)
    }
    return closeRes
  },
})

// ---------------------------------------------------------------------------
// Resolve a ContextItem for a parsed tabKey using handler.resolveTabItem
// ---------------------------------------------------------------------------

const resolveItem = (
  type: string,
  id: string,
  tabKey: string,
  spaceId: string,
  crawlspaceId?: string | null,
  scopeKey?: string | null,
): ContextItem => {
  const safeTabKey = (isCanvasTabKey(tabKey) ? tabKey : contextRegistry.buildTabKey(type, id)) as ContextTabKey
  const persisted = useSpaceContextTabsStore.getState().itemsBySpace?.[scopeKey ?? spaceId]?.[tabKey] ?? null
  const resolved = resolveTabItemCore(type, id, {
    spaceId,
    tabKey: safeTabKey,
    persistedItem: persisted,
    crawlspaceId,
  })
  if (resolved) return resolved
  return {
    type: type as ContextItem['type'],
    id,
    tabKey: safeTabKey,
    title: persisted?.title || id,
    meta: persisted?.meta,
  }
}

// ---------------------------------------------------------------------------
// Build context items: unified resolveTabItem loop + browser supplement
// ---------------------------------------------------------------------------

/**
 * 收集所有 handler 提供的非 tabOrder 来源 items。
 * 目前 browser handler 通过 getSourceItems 提供 crawlspace viewList 中的额外视图。
 */
const collectHandlerSourceItems = (crawlspaceId: string | null, existingKeys: Set<string>) => {
  const sourceCtx = { crawlspaceId }
  const supplementItems: ContextItem[] = []
  for (const handler of contextRegistry.getAllHandlers()) {
    if (!handler.getSourceItems) continue
    const items = handler.getSourceItems(sourceCtx, existingKeys)
    for (const item of items) {
      supplementItems.push(item)
      existingKeys.add(item.tabKey)
    }
  }
  const viewList = crawlspaceId
    ? useCrawlTabStore.getState().crawlspaceContextCache[crawlspaceId]?.viewList || EMPTY_VIEWS
    : EMPTY_VIEWS
  return { supplementItems, viewList }
}

const resolvePayloadScopeKey = (payload: BasePayload | undefined | null, fallbackSpaceId?: string | null): string | null =>
  payload?.tabScopeKey ?? payload?.workspaceScopeKey ?? fallbackSpaceId ?? null

/**
 * CLI / Agent 未显式指定 scope 时，应操作人当前看见的标签池（桌面或对话），
 * 不能退回用执行宿主 ID 当标签 scope。显式 scope 仍保留，供定向调用使用。
 */
const resolveContextActionScopeKey = (
  payload: BasePayload | undefined | null,
  fallbackSpaceId?: string | null,
): string | null => {
  const explicitScopeKey = payload?.tabScopeKey ?? payload?.workspaceScopeKey
  if (explicitScopeKey) return explicitScopeKey
  const foregroundScopeKey = resolveForegroundTabScopeKey(fallbackSpaceId)
  return foregroundScopeKey || fallbackSpaceId || null
}

/**
 * ：工具打开网页/终端标签的 scope 优先级。
 *
 * 1. 显式 payload（conversation: / desktop: 等）——发起任务的归属，并行时不可被前台盖掉
 * 2. 前台 UI scope——人手 CLI / 未带归属时的可见落点
 * 3. 执行宿主 ID——仅兼容垫底，不当正常标签桶
 *
 * 裸宿主 ID（与 spaceId 相同）视为「未给真实 scope」，升到前台，避免写进看不见的 legacy 桶。
 */
const resolveToolOpenTabScopeKey = (
  spaceId: string,
  explicitScopeKey: string | null | undefined,
): string => {
  const raw = (explicitScopeKey || '').trim()
  const foreground = resolveForegroundTabScopeKey(spaceId) || spaceId
  if (raw && raw !== spaceId) return raw
  return foreground || raw || spaceId
}

const buildContextItems = (spaceId?: string, crawlspaceId?: string | null, scopeKey?: string | null) => {
  const storageKey = scopeKey ?? spaceId
  const tabsStore = useSpaceContextTabsStore.getState()
  const crawlStore = useCrawlTabStore.getState()
  const tabOrder = storageKey ? tabsStore.tabOrderBySpace[storageKey] || [] : []
  const activeTabKey = storageKey ? tabsStore.activeKeyBySpace[storageKey] ?? null : null
  const groups = storageKey ? useCanvasLayoutStore.getState().spaceGroups[storageKey] || EMPTY_GROUPS : EMPTY_GROUPS

  const groupedTabKeys = new Set<string>()
  groups.forEach(group => {
    group.panes.forEach(pane => {
      if (pane.content?.tabKey) {
        groupedTabKeys.add(pane.content.tabKey)
      }
    })
  })

  // Phase 1: resolve items from tabOrder via handler.resolveTabItem
  const contextItemByTabKey = new Map<string, ContextItem>()
  const resolvedKeys = new Set<string>()
  for (const tabKey of tabOrder) {
    const parsed = contextRegistry.parseTabKey(tabKey)
    if (!parsed) continue
    const item = resolveItem(parsed.type, parsed.id, tabKey, spaceId || '', crawlspaceId, storageKey)
    contextItemByTabKey.set(tabKey, item)
    resolvedKeys.add(tabKey)
  }

  // Phase 2: supplement handler-provided source items (e.g., browser views not in tabOrder)
  const { supplementItems, viewList } = collectHandlerSourceItems(crawlspaceId ?? null, resolvedKeys)
  for (const item of supplementItems) {
    contextItemByTabKey.set(item.tabKey, item)
  }

  // Phase 3: resolve grouped/active keys not yet resolved
  const extraKeys = new Set<string>()
  groupedTabKeys.forEach(key => { if (!resolvedKeys.has(key)) extraKeys.add(key) })
  if (activeTabKey && !resolvedKeys.has(activeTabKey)) extraKeys.add(activeTabKey)
  for (const tabKey of extraKeys) {
    const parsed = contextRegistry.parseTabKey(tabKey)
    if (!parsed) continue
    const item = resolveItem(parsed.type, parsed.id, tabKey, spaceId || '', crawlspaceId, storageKey)
    contextItemByTabKey.set(tabKey, item)
    resolvedKeys.add(tabKey)
  }

  // Phase 4: filter closing browser views + build ordered key list
  const closingViewIds = new Set(viewList.filter(view => view.isClosing).map(view => view.viewId))
  const recentlyClosedViewIds = crawlStore._recentlyClosedViewIds
  const shouldSkip = (tabKey: string) => {
    const parsed = contextRegistry.parseTabKey(tabKey)
    return parsed?.type === 'tabweb'
      && (closingViewIds.has(parsed.id) || recentlyClosedViewIds.has(parsed.id))
  }

  const currentTabKeySet = new Set<string>()
  resolvedKeys.forEach(key => {
    if (!shouldSkip(key)) currentTabKeySet.add(key)
  })

  const currentTabKeys: string[] = []
  const seen = new Set<string>()
  tabOrder.forEach(key => {
    if (!currentTabKeySet.has(key) || seen.has(key)) return
    seen.add(key)
    currentTabKeys.push(key)
  })
  Array.from(currentTabKeySet)
    .filter(key => !seen.has(key))
    .sort()
    .forEach(key => {
      seen.add(key)
      currentTabKeys.push(key)
    })

  return {
    tabOrder,
    activeTabKey,
    currentTabKeys,
    itemsByTabKey: contextItemByTabKey,
    groups,
    browserViews: viewList,
  }
}

const buildCanvasContent = (tabKey: string, browserTabs: CrawlspaceViewInfo[]): CanvasPaneContent => {
  const safeTabKey = isCanvasTabKey(tabKey) ? tabKey : contextRegistry.buildTabKey('unknown', tabKey)
  const item = { tabKey: safeTabKey, id: tabKey.split(':')[1] || tabKey, type: tabKey.split(':')[0] || 'unknown' }
  const ctx = { browserTabs }
  return contextRegistry.buildCanvasContent(item as ContextItem, ctx) || { tabKey: safeTabKey }
}

const resolvePayloadSpaceId = (payload: BasePayload | undefined | null): string | null =>
  payload?.spaceId ?? payload?.projectId ?? null

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * 纯视觉 meta 字段——只服务侧边栏 / 画布的人眼渲染，对 Agent 推理无价值。
 * `favicon` 常是 base64 data URI，随 `list_context_space` 返回会白白膨胀 token
 * 并把图标暴露给 Agent；`themeColor` 是 Session 颜色条。这里在 Agent 消费点
 * （工具返回）剥离，源头 handler.resolveTabItem 仍保留这些字段供 UI 使用。
 */
const VISUAL_ONLY_TAB_META_KEYS = ['favicon', 'themeColor'] as const

/**
 * 从单个 tab 剥离纯视觉 meta 字段，保留其余全部语义字段（url / cwd / route /
 * viewId / section 等各 handler 自定义字段不受影响）。meta 为空时原样返回。
 */
export const stripVisualTabMeta = <T extends { meta?: Record<string, unknown> }>(tab: T): T => {
  if (!tab.meta) return tab
  let hasVisual = false
  const nextMeta: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(tab.meta)) {
    if ((VISUAL_ONLY_TAB_META_KEYS as readonly string[]).includes(key)) {
      hasVisual = true
      continue
    }
    nextMeta[key] = value
  }
  if (!hasVisual) return tab
  return { ...tab, meta: nextMeta }
}

const listContextSpace = (payload: ListContextSpacePayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const scopeKey = resolveContextActionScopeKey(payload, spaceId)
  const crawlspaceId = resolveSpaceCrawlspaceId(spaceId ?? undefined, payload?.crawlspaceId, scopeKey)
  const includeLayout = payload?.includeLayout !== false
  const { activeTabKey, currentTabKeys, itemsByTabKey, groups } = buildContextItems(spaceId ?? undefined, crawlspaceId, scopeKey)
  const visibleTabKeySet = new Set(currentTabKeys)

  const tabs = currentTabKeys
    .map(key => itemsByTabKey.get(key))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
    .map(stripVisualTabMeta)

  const filteredTabOrder = currentTabKeys.slice()
  const normalizedActiveTabKey = activeTabKey && visibleTabKeySet.has(activeTabKey)
    ? activeTabKey
    : null

  const formattedGroups = groups
    .map(group => {
      const panes = group.panes
        .filter(pane => {
          const tabKey = pane.content?.tabKey
          return Boolean(tabKey && visibleTabKeySet.has(tabKey))
        })
        .map(pane => ({
          id: pane.id,
          tabKey: pane.content?.tabKey ?? null
        }))

      if (panes.length === 0) {
        return null
      }

      const activePaneId = panes.some(pane => pane.id === group.activePaneId)
        ? group.activePaneId
        : panes[0]?.id ?? null

      return {
        id: group.id,
        spaceId: group.spaceId,
        anchorTabKey: visibleTabKeySet.has(group.anchorTabKey) ? group.anchorTabKey : panes[0]?.tabKey ?? null,
        activePaneId,
        panes,
        layout: includeLayout ? group.layout : null
      }
    })
    .filter((group): group is NonNullable<typeof group> => Boolean(group))

  return {
    success: true,
    data: {
      spaceId,
      crawlspaceId,
      activeTabKey: normalizedActiveTabKey,
      tabOrder: filteredTabOrder,
      tabs,
      groups: formattedGroups
    }
  }
}

const closeContextTab = async (payload: CloseContextTabPayload) => {
  const spaceId = resolvePayloadSpaceId(payload) ?? resolveSpaceIdFromCrawlspace(payload?.crawlspaceId)
  const scopeKey = resolveContextActionScopeKey(payload, spaceId)
  const tabKey = payload?.tabKey
  const crawlspaceId = resolveSpaceCrawlspaceId(spaceId ?? undefined, payload?.crawlspaceId, scopeKey)
  if (!spaceId || !tabKey) {
    return { success: false, error: 'spaceId/tabKey is required (could not resolve from crawlspaceId either)' }
  }

  const tabsStore = useSpaceContextTabsStore.getState()
  const canvasStore = useCanvasLayoutStore.getState()

  const activeTabKey = scopeKey ? tabsStore.activeKeyBySpace[scopeKey] ?? null : null
  const tabOrder = scopeKey ? tabsStore.tabOrderBySpace[scopeKey] ?? [] : []
  const groups = scopeKey ? canvasStore.spaceGroups[scopeKey] || EMPTY_GROUPS : EMPTY_GROUPS
  const parsed = contextRegistry.parseTabKey(tabKey)
  if (!parsed) {
    return { success: false, error: 'invalid tabKey' }
  }

  // 提前 resolve item / 构造 toolCtx —— 后续 beforeClose 与 dispatchClose 共用同一对象，
  // 让 hook 看到的 item 引用一致，便于 handler 内部缓存比对。
  const toolCtx = buildToolContainerCtx(spaceId, crawlspaceId, scopeKey)
  const contextItem = resolveItem(parsed.type, parsed.id, tabKey, spaceId, crawlspaceId, scopeKey)

  // Step 0 (W2.5 T8): beforeClose 数据保护 —— 与 UI 路径（useCloseHandlers）一致。
  //   tabdoc 等 handler 在 dirty 状态会通过 beforeClose 弹三选确认对话框（取消/放弃/保存并关闭）。
  //   原则：保护人的数据是第一优先级。Agent 通过 MCP 工具关 dirty tab 时**也应当弹**对话框，
  //   让用户保有最终选择权（透明 · 安全承诺）。
  //
  //   错误处理：
  //   - 用户主动取消（resolve false）→ 返回 CLOSE_CANCELLED，结构化 code 让 Agent 区分
  //   - beforeClose 抛错 → 返回 BEFORE_CLOSE_ERROR，错误信息穿透到 Agent，**不静默吞掉**
  //   两种失败路径都不调用 dispatchClose / closeTab，tab 状态完全不变。
  let allowed: boolean
  try {
    allowed = await contextRegistry.dispatchBeforeClose(contextItem, toolCtx)
  } catch (error) {
    return {
      success: false,
      code: 'BEFORE_CLOSE_ERROR',
      error: `beforeClose hook threw: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  if (!allowed) {
    return {
      success: false,
      code: 'CLOSE_CANCELLED',
      error: 'User cancelled the close action in the confirmation dialog.',
    }
  }

  // 与 UI 侧 useCloseHandlers 路径一致：beforeClose 通过后清 discarded 标记。
  // 让 Agent 通过工具关 discarded（休眠）的浏览器标签时与人类操作行为对齐，避免遗留状态。
  if (contextItem.meta?.discarded) {
    useDiscardedViewStore.getState().clearDiscarded(parsed.id)
  }

  // Step 1: 用与 UI 端一致的算法预计算 fallback（canvas survivor → visible 邻居 → tabOrder 兜底）
  const isClosingActive = activeTabKey === tabKey
  const plannedFallback = isClosingActive
    ? computeFallbackTabKeyFromStore({ closingTabKey: tabKey, tabOrder, spaceGroups: groups })
    : null

  const group = findGroupForTabKey(groups, tabKey)
  const paneIdToClose = group
    ? group.panes.find(item => item.content?.tabKey === tabKey)?.id ?? null
    : null

  // Step 2: Handler resource cleanup via onClose
  // 契约：不得改 activeKey / tabOrder。dispatchClose 内置守卫：
  //   - dev/test 违约 throw（外层 try-catch 捕获，整个 close 中止）
  //   - prod 违约降级为 console.warn，并通过 DispatchCloseResult.needsClose 反映
  const dispatchResult = await contextRegistry.dispatchClose(contextItem, toolCtx)

  // Step 3: 本地 canvas / activeKey 清理（与 useCloseHandlers 时序对齐）
  if (isClosingActive) {
    const postActive = scopeKey ? useSpaceContextTabsStore.getState().activeKeyBySpace[scopeKey] ?? null : null
    if (postActive !== plannedFallback) {
      if (scopeKey) useSpaceContextTabsStore.getState().setActiveKey(scopeKey, plannedFallback)
    }
  }

  if (group && paneIdToClose) {
    if (scopeKey) canvasStore.closePane(scopeKey, group.id, paneIdToClose)
  }

  // Step 4: 按 dispatchResult.needsClose 决定是否兜底 closeTab。
  // 契约保证 needsClose 默认 true（handler 不动 tabOrder）；仅 prod 守卫降级 + handler 已自行
  // 移除 item.tabKey 时为 false，避免重复 closeTab 触发 self-healing 噪声日志。
  if (dispatchResult.needsClose) {
    const tabs = useSpaceContextTabsStore.getState()
    if (tabs.closeExplicitTab) {
      tabs.closeExplicitTab(scopeKey ?? spaceId, tabKey, plannedFallback ?? undefined)
    } else {
      tabs.closeTab(scopeKey ?? spaceId, tabKey, plannedFallback ?? undefined)
    }
  } else {
    // source-driven handler 已自行移除 tab；仍记录这次 Agent 的明确关闭意图。
    useSpaceContextTabsStore.getState().recordExplicitTabClose?.(scopeKey ?? spaceId, tabKey)
  }

  // Step 5: closeTab 后的最终清理（见 ContextTypeHandler.onAfterClose 文档）。
  // 紧接 closeTab 同步调用，让 source store 删除（如 terminal session）与 closeTab 处于
  // 同一 sync render 闭环，避免 syncTabOrder 看到中间状态把已关闭的 tabKey 加回 tabOrder。
  contextRegistry.dispatchAfterClose(contextItem, toolCtx)

  const nextActiveTabKey = scopeKey ? useSpaceContextTabsStore.getState().activeKeyBySpace[scopeKey] ?? null : null
  return { success: true, data: { nextActiveTabKey } }
}

export const invokeCloseContextTab = async (payload: CloseContextTabPayload) => {
  return closeContextTab(payload)
}

const setActiveContextTab = async (payload: SetActiveContextTabPayload) => {
  const spaceId = resolvePayloadSpaceId(payload) ?? resolveSpaceIdFromCrawlspace(payload?.crawlspaceId)
  const scopeKey = resolveContextActionScopeKey(payload, spaceId)
  const tabKey = payload?.tabKey ?? null
  if (!spaceId) {
    return { success: false, error: 'spaceId is required (could not resolve from crawlspaceId either)' }
  }
  const tabsStore = useSpaceContextTabsStore.getState()
  const canvasStore = useCanvasLayoutStore.getState()
  if (payload?.paneId) {
    const groups = scopeKey ? canvasStore.spaceGroups[scopeKey] || EMPTY_GROUPS : EMPTY_GROUPS
    const group = groups.find(item => item.panes.some(pane => pane.id === payload.paneId))
    if (group) {
      if (scopeKey) canvasStore.setActivePane(scopeKey, group.id, payload.paneId)
    }
  }

  if (tabKey) {
    const parsed = contextRegistry.parseTabKey(tabKey)
    if (parsed) {
      if (parsed.type === 'tabweb') {
        const crawlspaceId = resolveSpaceCrawlspaceId(spaceId, payload?.crawlspaceId, scopeKey)
        if (!crawlspaceId) {
          return { success: false, error: 'crawlspaceId is required for browser tabs' }
        }
        const result = await activateBrowserView(crawlspaceId, parsed.id, {
          spaceId,
          ...(scopeKey ? { selection: { tabScopeKey: scopeKey, tabKey } } : {}),
        })
        if (!result.ok) {
          return { success: false, error: result.message || 'setActiveView failed' }
        }
        if (result.code === 'cancelled' || result.code === 'superseded') {
          return { success: false, error: `browser activation ${result.code}` }
        }
        return { success: true, data: { activeTabKey: tabKey } }
      }
      const handler = contextRegistry.getHandler(parsed.type)
      if (handler?.onSelect) {
        const crawlspaceId = resolveSpaceCrawlspaceId(spaceId, payload?.crawlspaceId, scopeKey)
        const contextItem = resolveItem(parsed.type, parsed.id, tabKey, spaceId, crawlspaceId, scopeKey)
        handler.onSelect(contextItem, buildToolContainerCtx(spaceId, crawlspaceId, scopeKey))
      } else {
        if (scopeKey) tabsStore.setActiveKey(scopeKey, tabKey)
      }
    } else {
      if (scopeKey) tabsStore.setActiveKey(scopeKey, tabKey)
    }
  } else {
    if (scopeKey) tabsStore.setActiveKey(scopeKey, tabKey)
  }

  return { success: true, data: { activeTabKey: tabKey } }
}

/** 供 CLI/Agent bridge 的入口级测试复用，运行时仍由 handleInvoke 调用同一实现。 */
export const invokeSetActiveContextTab = async (payload: SetActiveContextTabPayload) => {
  return setActiveContextTab(payload)
}

const restoreContextGroup = (payload: RestoreContextGroupPayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const scopeKey = resolvePayloadScopeKey(payload, spaceId)
  const groupId = payload?.groupId
  if (!spaceId || !groupId) {
    return { success: false, error: 'spaceId/groupId is required' }
  }
  const tabsStore = useSpaceContextTabsStore.getState()
  const canvasStore = useCanvasLayoutStore.getState()
  const groups = scopeKey ? canvasStore.spaceGroups[scopeKey] || EMPTY_GROUPS : EMPTY_GROUPS
  const group = groups.find(item => item.id === groupId)
  if (!group) {
    return { success: false, error: 'group not found' }
  }

  const groupTabKeys = group.panes
    .map(pane => pane.content?.tabKey)
    .filter((key): key is CanvasTabKey => Boolean(key))
  if (groupTabKeys.length === 0) {
    if (scopeKey) canvasStore.removeGroup(scopeKey, groupId)
    return { success: true, data: { tabOrder: scopeKey ? tabsStore.tabOrderBySpace[scopeKey] || [] : [] } }
  }

  const baseOrder = scopeKey ? tabsStore.tabOrderBySpace[scopeKey] || [] : []
  const groupTabKeySet = new Set<string>(groupTabKeys)
  const withoutGroup = baseOrder.filter(key => !groupTabKeySet.has(key))
  let insertIndex = withoutGroup.length
  const activeTabKey = scopeKey ? tabsStore.activeKeyBySpace[scopeKey] ?? null : null
  if (activeTabKey) {
    if (groupTabKeySet.has(activeTabKey)) {
      const firstGroupIndex = baseOrder.findIndex(key => groupTabKeySet.has(key))
      if (firstGroupIndex !== -1) {
        insertIndex = baseOrder.slice(0, firstGroupIndex).filter(key => !groupTabKeySet.has(key)).length
      }
    } else {
      const activeIndex = withoutGroup.indexOf(activeTabKey)
      if (activeIndex !== -1) {
        insertIndex = activeIndex + 1
      }
    }
  }

  const nextOrder = [
    ...withoutGroup.slice(0, insertIndex),
    ...groupTabKeys,
    ...withoutGroup.slice(insertIndex)
  ]
  if (scopeKey) {
    tabsStore.setTabOrder(scopeKey, nextOrder)
    canvasStore.removeGroup(scopeKey, groupId)
  }

  return { success: true, data: { tabOrder: nextOrder } }
}

const assignPaneContent = (payload: AssignPaneContentPayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const scopeKey = resolvePayloadScopeKey(payload, spaceId)
  const groupId = payload?.groupId
  const paneId = payload?.paneId
  const tabKey = payload?.tabKey
  if (!spaceId || !groupId || !paneId || !tabKey) {
    return { success: false, error: 'spaceId/groupId/paneId/tabKey is required' }
  }
  const canvasStore = useCanvasLayoutStore.getState()
  const crawlspaceId = resolveSpaceCrawlspaceId(spaceId, payload?.crawlspaceId, scopeKey)
  const { browserViews } = buildContextItems(spaceId, crawlspaceId, scopeKey)
  const content = buildCanvasContent(tabKey, browserViews)
  if (scopeKey) {
    canvasStore.assignPaneContent(scopeKey, groupId, paneId, content)
    useSpaceContextTabsStore.getState().setActiveKey(scopeKey, tabKey)
  }
  return { success: true }
}

const splitPaneWithTab = (payload: SplitPanePayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const scopeKey = resolvePayloadScopeKey(payload, spaceId)
  const groupId = payload?.groupId
  const paneId = payload?.paneId
  const side = payload?.side
  const tabKey = payload?.tabKey
  if (!spaceId || !groupId || !paneId || !side || !tabKey) {
    return { success: false, error: 'spaceId/groupId/paneId/side/tabKey is required' }
  }
  const canvasStore = useCanvasLayoutStore.getState()
  const crawlspaceId = resolveSpaceCrawlspaceId(spaceId, payload?.crawlspaceId, scopeKey)
  const { browserViews } = buildContextItems(spaceId, crawlspaceId, scopeKey)
  const content = buildCanvasContent(tabKey, browserViews)
  const direction = side === 'top' || side === 'bottom' ? 'vertical' : 'horizontal'
  if (scopeKey) {
    canvasStore.splitPaneWithContent(scopeKey, groupId, paneId, direction, side, content)
    useSpaceContextTabsStore.getState().setActiveKey(scopeKey, tabKey)
  }
  return { success: true }
}

const movePane = (payload: MovePanePayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const scopeKey = resolvePayloadScopeKey(payload, spaceId)
  const groupId = payload?.groupId
  const sourcePaneId = payload?.sourcePaneId
  const targetPaneId = payload?.targetPaneId
  const side = payload?.side
  if (!spaceId || !groupId || !sourcePaneId || !targetPaneId || !side) {
    return { success: false, error: 'spaceId/groupId/sourcePaneId/targetPaneId/side is required' }
  }
  if (scopeKey) useCanvasLayoutStore.getState().movePane(scopeKey, groupId, sourcePaneId, targetPaneId, side)
  return { success: true }
}

const dockPane = (payload: DockPanePayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const scopeKey = resolvePayloadScopeKey(payload, spaceId)
  const groupId = payload?.groupId
  const paneId = payload?.paneId
  const side = payload?.side
  if (!spaceId || !groupId || !paneId || !side) {
    return { success: false, error: 'spaceId/groupId/paneId/side is required' }
  }
  if (scopeKey) useCanvasLayoutStore.getState().dockPaneToOuter(scopeKey, groupId, paneId, side)
  return { success: true }
}

export const invokeCreateWebTab = async (payload: CreateWebTabPayload) => {
  const spaceId = resolvePayloadSpaceId(payload) ?? resolveSpaceIdFromCrawlspace(payload?.crawlspaceId)
  const payloadScopeKey = resolvePayloadScopeKey(payload, spaceId)
  const explicitScopeKey = payload?.tabScopeKey ?? payload?.workspaceScopeKey ?? null
  const targetUrl = payload?.url || 'about:blank'
  const title = payload?.title
  const sessionName = payload?.sessionName
  const localPreviewRoot =
    typeof payload?.localPreviewRoot === 'string' && payload.localPreviewRoot.trim()
      ? payload.localPreviewRoot.trim()
      : undefined
  if (!spaceId) {
    return { success: false, error: 'spaceId is required' }
  }
  const scopeKey = sessionName
    ? (payloadScopeKey || spaceId)
    : resolveToolOpenTabScopeKey(spaceId, explicitScopeKey)

  const store = useCrawlTabStore.getState()
  const crawlspace = sessionName
    ? store.ensureNamedCrawlspace(spaceId, sessionName, {
        title: title || sessionName,
      })
    : store.ensureScopedCrawlspace(spaceId, scopeKey ?? spaceId, {
        title: title || i18n.t('label.newTab', { ns: 'context' }),
      })
  const crawlspaceId = crawlspace.id
  const viewTitle = title || i18n.t('label.newTab', { ns: 'context' })
  let createViewFailure: string | undefined
  const ipcAdapter = createElectronIpcAdapter(crawlspaceId, spaceId, {
    onCreateViewFailure: (message) => {
      createViewFailure = message
    },
  })
  const viewId = `view-${crawlspaceId}-${Date.now()}-${++createWebTabSequence}`
  const tabKey = contextRegistry.buildTabKey('tabweb', viewId)

  const created = await ipcAdapter.createView(
    viewId,
    targetUrl,
    payload.runId,
    viewTitle,
    undefined,
    localPreviewRoot ? { localPreviewRoot } : undefined,
  )
  if (!created) {
    return { success: false, error: createViewFailure || 'IPC createView failed' }
  }

  // ：本地 HTML 预览种子必须带放行根，否则冷启动 / 恢复重建会被门禁拒成空白页。
  if (localPreviewRoot) {
    seedManager.ensureSeed(crawlspaceId, {
      viewId,
      url: targetUrl,
      title: title || undefined,
      localPreviewRoot,
    })
  }

  // 隔离 scope 的 Browser source 只接纳已在 tabOrder 的显式成员。
  // 静默登记保证新标签可发现，但不改变 activeKey / displayKey。
  useSpaceContextTabsStore.getState().openResourceTab(scopeKey ?? spaceId, {
    type: 'tabweb',
    id: viewId,
    title: viewTitle,
    meta: { url: targetUrl, crawlspaceId, spaceId },
    silent: true,
  })

  // Agent/CLI 创建标签只更新浏览器运行时目标，不能提交工作台 selection。
  // 用户主动打开仍走 openWebTabInSpace；Agent 明确展示则走 set_active_context_tab。
  const result = await activateBrowserView(crawlspaceId, viewId, {
    spaceId,
    ...(localPreviewRoot
      ? {
          fallbackView: {
            viewId,
            url: targetUrl,
            title: viewTitle,
            localPreviewRoot,
          },
        }
      : {}),
  })
  if (!result.ok || result.code === 'cancelled') {
    const activationError = !result.ok
      ? (result.message || 'setActiveView failed')
      : `browser activation ${result.code}`
    let rollbackError: string | null = null
    try {
      const closeResult = await store.closeCrawlspaceView(crawlspaceId, viewId)
      if (!closeResult.ok) {
        rollbackError = closeResult.message || `close view failed: ${closeResult.code}`
      }
    } catch (error) {
      rollbackError = error instanceof Error ? error.message : String(error)
    }

    if (rollbackError) {
      log.error('create_web_tab 激活失败且回滚关闭失败', {
        crawlspaceId,
        viewId,
        activationError,
        rollbackError,
      })
    } else {
      useSpaceContextTabsStore.getState().closeTab(scopeKey ?? spaceId, tabKey)
    }
    return {
      success: false,
      error: rollbackError
        ? `${activationError}; rollback close failed: ${rollbackError}`
        : activationError,
    }
  }

  // 不再 about:blank + loadUrl：webview 模式下 createView 只登记 hub、guest 要等
  // EmbeddedCrawlView.show 才创建——过早 loadUrl 会 View not found，tab 永久 blank。
  // 与手动 createWebTab（useSpaceContextNavigation）对齐：目标 URL 在 createView
  // 时写入 store/hub，show → WebviewManager.src 即加载；WCV 路径 createView 也会
  // 直接 load，无需二次 loadUrl。

  //  治本：webview 模式对齐 WCV 的「创建即有真实网页进程」契约。
  // Agent/CLI 建的 tab 常落在隐藏画布/溢出区，EmbeddedCrawlView.show 永远
  // 不触发 → guest 永不 attach → CLI open 20s 超时、--tab-id 全程
  // VIEW_NOT_FOUND。这里创建成功后立即在隐藏稳定层后台挂载 <webview>
  // （throttle 档，ensure 幂等，用户点开时 show 复用同一元素，不会重建，
  // 也不会产生 WCV 影子视图——建的是 guest 本体并经 adopt 注册 ViewFactory）。
  // 挂载失败不阻断创建：行为回落到修复前（等显示时挂载），只记 warn。
  await ensureBackgroundWebviewMount(crawlspaceId, viewId, targetUrl, payload.runId)

  return { success: true, data: { crawlspaceId, viewId, tabKey } }
}

export const invokeOpenBrowserHome = async (payload: OpenBrowserHomePayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  if (!spaceId) return { success: false, error: 'spaceId is required' }

  const explicitScopeKey = payload?.tabScopeKey ?? payload?.workspaceScopeKey ?? null
  const tabScopeKey = resolveToolOpenTabScopeKey(spaceId, explicitScopeKey)
  const result = await openBrowserHomeInSpace(spaceId, { tabScopeKey })
  if (!result.ok) return { success: false, error: result.error }
  return { success: true, data: result }
}

/** ：webview 模式下把新建 tab 的 guest 在隐藏层立即挂载（不依赖标签可见）。 */
async function ensureBackgroundWebviewMount(
  crawlspaceId: string,
  viewId: string,
  url: string,
  runId?: string,
): Promise<void> {
  if (!isWebviewContainerEnabled()) return
  const config = useCrawlTabStore.getState().getCrawlspaceConfig(crawlspaceId)
  if (!config?.profile || !config?.partition) {
    log.warn('create_web_tab 后台挂载跳过：缺少 crawlspace 配置', { crawlspaceId, viewId })
    return
  }
  try {
    const manager = getWebviewManager()
    await manager.ensure(viewId, {
      url,
      profile: config.profile,
      partition: config.partition,
      crawlspaceId,
      kind: 'workspace-view',
      isPreview: false,
      runId,
    })
    if (runId) {
      getWebviewKeepaliveController(manager).activateKnownRun(viewId)
    }
    log.info('create_web_tab 后台挂载 webview 完成', { crawlspaceId, viewId })
  } catch (error) {
    log.warn('create_web_tab 后台挂载 webview 失败（回落显示时挂载）', {
      crawlspaceId,
      viewId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const createSessionCrawlspace = (payload: CreateSessionCrawlspacePayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const sessionName = payload?.sessionName
  if (!spaceId) return { success: false, error: 'spaceId is required' }
  if (!sessionName) return { success: false, error: 'sessionName is required' }

  const store = useCrawlTabStore.getState()
  const crawlspace = store.ensureNamedCrawlspace(spaceId, sessionName, {
    title: payload?.title || sessionName,
  })
  const config = crawlspace.metadata?.crawlspaceConfig
  return {
    success: true,
    data: {
      crawlspaceId: crawlspace.id,
      sessionName,
      partition: config?.partition,
      profile: config?.profile,
    },
  }
}

const listSessions = (payload: ListSessionsPayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  if (!spaceId) return { success: false, error: 'spaceId is required' }

  const store = useCrawlTabStore.getState()
  const sessions = store.getSpaceSessionList(spaceId)
  return { success: true, data: { sessions } }
}

const purgeSession = async (payload: PurgeSessionPayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  const sessionName = payload?.sessionName
  if (!spaceId) return { success: false, error: 'spaceId is required' }
  if (!sessionName) return { success: false, error: 'sessionName is required' }

  const store = useCrawlTabStore.getState()
  const crawlspace = store.getNamedCrawlspace(spaceId, sessionName)
  if (!crawlspace) return { success: false, error: `session "${sessionName}" not found` }

  const views = store.getCrawlspaceViews(crawlspace.id)
  for (const view of views) {
    try {
      await store.closeCrawlspaceView(crawlspace.id, view.viewId)
    } catch { /* view 可能已关闭 */ }
  }

  store.purgeCrawlspaceData(crawlspace.id)
  return { success: true, data: { crawlspaceId: crawlspace.id, sessionName, closedViews: views.length } }
}

/**
 * 打开 / 聚焦 TabTin 应用内可交互终端（node-pty + xterm）。
 * CLI：`tabtin terminal open [--cwd] [--title] [--session-id]`
 */
export const invokeOpenTerminalTab = (payload: OpenTerminalTabPayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  if (!spaceId) {
    return { success: false, error: 'spaceId is required' }
  }

  const explicitScopeKey = payload?.tabScopeKey ?? payload?.workspaceScopeKey ?? null
  const storageKey = resolveToolOpenTabScopeKey(spaceId, explicitScopeKey)
  const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId.trim() : ''
  const title = typeof payload?.title === 'string' ? payload.title.trim() : undefined
  const cwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : undefined

  try {
    if (sessionId) {
      const entry = useTerminalSessionStore.getState().getSessionEntry(sessionId)
      if (!entry) {
        return { success: false, error: `terminal session not found: ${sessionId}` }
      }
      const { tabKey } = openTerminalTabInScope(entry.key, sessionId, {
        title: title || entry.session.title,
      })
      log.info('open_terminal_tab focused existing', { sessionId, tabKey, storageKey: entry.key })
      return {
        success: true,
        data: {
          sessionId,
          tabKey,
          created: false,
          title: entry.session.title,
          cwd: entry.session.cwd,
        },
      }
    }

    const created = createTerminalSessionInScope({
      spaceId,
      storageKey,
      title,
      source: 'user',
      cwd,
    })
    const session = useTerminalSessionStore.getState().getSessionEntry(created.sessionId)?.session
    log.info('open_terminal_tab created', {
      sessionId: created.sessionId,
      tabKey: created.tabKey,
      storageKey,
      cwd: cwd ?? null,
    })
    return {
      success: true,
      data: {
        sessionId: created.sessionId,
        tabKey: created.tabKey,
        created: true,
        title: session?.title ?? title,
        cwd: session?.cwd ?? cwd,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message === 'TERMINAL_NOT_ON_CONTROL_DEVICE') {
      return {
        success: false,
        error: '当前设备不是 Agent 的控制设备，无法打开应用内终端。请切换到控制设备后重试。',
      }
    }
    log.error('open_terminal_tab failed', { spaceId, storageKey, error: message })
    return { success: false, error: message }
  }
}

/**
 * 列出当前前台 scope 下的用户终端会话。
 * CLI：`tabtin terminal list`
 */
export const invokeListTerminalSessions = (payload: ListTerminalSessionsPayload) => {
  const spaceId = resolvePayloadSpaceId(payload)
  if (!spaceId) {
    return { success: false, error: 'spaceId is required' }
  }

  const storageKey = resolveContextActionScopeKey(payload, spaceId) || spaceId
  const sessions = useTerminalSessionStore.getState().getSessionsBySpace(storageKey)

  return {
    success: true,
    data: {
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        source: session.source,
        cwd: session.cwd ?? null,
        createdAt: session.createdAt,
      })),
    },
  }
}

const handleInvoke = async (message: ContextSpaceInvokePayload): Promise<ContextSpaceResponsePayload> => {
  const { requestId, action, payload } = message
  try {
    switch (action) {
      case 'list_context_space':
        return { requestId, ...listContextSpace(payload) }
      case 'close_context_tab': {
        const body = await closeContextTab(payload)
        return { requestId, ...body } as ContextSpaceResponsePayload
      }
      case 'set_active_context_tab':
        return { requestId, ...(await setActiveContextTab(payload)) }
      case 'restore_context_group':
        return { requestId, ...restoreContextGroup(payload) }
      case 'assign_pane_content':
        return { requestId, ...assignPaneContent(payload) }
      case 'split_pane_with_tab':
        return { requestId, ...splitPaneWithTab(payload) }
      case 'move_pane':
        return { requestId, ...movePane(payload) }
      case 'dock_pane':
        return { requestId, ...dockPane(payload) }
      case 'create_web_tab':
        return { requestId, ...(await invokeCreateWebTab(payload)) }
      case 'open_browser_home':
        return { requestId, ...(await invokeOpenBrowserHome(payload)) }
      case 'create_session_crawlspace':
        return { requestId, ...createSessionCrawlspace(payload) }
      case 'open_terminal_tab':
        return { requestId, ...invokeOpenTerminalTab(payload) }
      case 'list_terminal_sessions':
        return { requestId, ...invokeListTerminalSessions(payload) }
      case 'list_sessions':
        return { requestId, ...listSessions(payload) }
      case 'purge_session':
        return { requestId, ...(await purgeSession(payload)) }
      default:
        return { requestId, success: false, error: `unknown action: ${action}` }
    }
  } catch (error) {
    return { requestId, success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export const registerContextSpaceToolHandler = () => {
  const ipc = window.electron?.ipcRenderer
  if (!ipc) return () => {}

  let isActive = true
  const handler = async (_event: unknown, message: ContextSpaceInvokePayload) => {
    if (!isActive || !message?.requestId) return
    const response = await handleInvoke(message)
    ipc.send('context-space:response', response)
  }

  const announceReady = () => {
    if (isActive) ipc.send('context-space:ready')
  }
  const unsub = ipc.on('context-space:invoke', handler)
  const unsubReadyCheck = ipc.on('context-space:ready-check', announceReady)
  announceReady()
  return () => {
    isActive = false
    unsub?.()
    unsubReadyCheck?.()
  }
}

export const useContextSpaceToolHandler = () => {
  useEffect(() => {
    return registerContextSpaceToolHandler()
  }, [])
}
