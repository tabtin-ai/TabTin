/** @store-category prefs */

import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { createMigratingStorage, withPersistSafety } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { registerResetAction } from './sessionResetRegistry'
import { traceTabRestore } from '@/utils/tabRestoreTrace'
import type { ContextActiveKey, ContextItemRecord, OpenResourceTabParams } from './contextTabs/types'
import {
  buildTableKey,
  buildResourceTabKey,
  parseTabKey,
  isSameItem,
  normalizeItems,
  isValidTabKey,
  normalizeTabKeys,
  shouldDebugTabSwitch,
  shallowEqualItemSets,
  patchDisplayRecord,
  normalizePersistedState,
  mergeSyncedTabOrder,
} from './contextTabs/helpers'
import { contextRegistry } from '@/components/context-space/registry/instance'
import {
  decideActiveKeyCommit,
  nextNavigationIntent,
  type NavigationIntent,
  type SetActiveKeyOptions,
} from './contextTabs/navigationIntent'
import { migrateContextTabsState } from './contextTabs/migration'
import { buildContextTabsSignature } from './workbenchRestoreSignature'
import { createLogger } from '@/utils/logger'

const log = createLogger('ContextTabs')

// Re-export types for backward compatibility
export type { ContextActiveKey, ContextItemRecord, OpenResourceTabParams } from './contextTabs/types'
export type { NavigationIntent, NavigationWriter, SetActiveKeyOptions } from './contextTabs/navigationIntent'

/** useSyncExternalStore 稳定 fallback — 禁止在 selector 内联 `?? []` / `?? {}` */
export const EMPTY_TAB_ORDER: readonly string[] = []
export const EMPTY_CONTEXT_ITEMS: Record<string, ContextItemRecord> = {}

/**
 * 非持久化导航意图（每 scope 单调 revision）。
 * 不进 partialize——冷启动后由用户点击重新建立；restore 不得伪造用户意图。
 */
const navIntentBySpace = new Map<string, NavigationIntent>()

export function getNavigationIntent(spaceId: string): NavigationIntent | undefined {
  return navIntentBySpace.get(spaceId)
}

export function getNavigationRevision(spaceId: string): number {
  return navIntentBySpace.get(spaceId)?.revision ?? 0
}

function recordNavigationIntent(
  spaceId: string,
  args: {
    writer: NonNullable<SetActiveKeyOptions['writer']>
    targetKey: ContextActiveKey
    reason: string
    bumpRevision: boolean
  },
): NavigationIntent {
  const next = nextNavigationIntent(navIntentBySpace.get(spaceId), args)
  navIntentBySpace.set(spaceId, next)
  traceTabRestore('navIntent:record', {
    spaceId,
    revision: next.revision,
    targetKey: next.targetKey,
    writer: next.writer,
    reason: next.reason,
  })
  return next
}

function clearNavigationIntent(spaceId: string): void {
  if (!navIntentBySpace.has(spaceId)) return
  navIntentBySpace.delete(spaceId)
  traceTabRestore('navIntent:clear', { spaceId })
}

function clearAllNavigationIntents(): void {
  if (navIntentBySpace.size === 0) return
  navIntentBySpace.clear()
  traceTabRestore('navIntent:clearAll', {})
}

function isActiveStructurallyValid(
  spaceId: string,
  active: ContextActiveKey,
  order: readonly string[],
  items: Record<string, ContextItemRecord>,
): boolean {
  if (active == null) return true
  // 多步 sync 瞬时「order 有 / items 未到」仍视为有效用户目标（ follow-up）
  return order.includes(active) || active in items
}

const EMPTY_TABLE_TABS: string[] = []

// findSpaceByTabKey 的缓存式反向索引：tabOrderBySpace 引用不变时复用「tabKey → scopes[]」，
// 解析时再按 active / display / desktop 优先级挑选，避免 last-write-wins 误判前景 tab。
let _reverseIndexCache: {
  source: Record<string, string[]>
  index: Map<string, string[]>
} | null = null

const workspaceScopePriority = (scopeKey: string): number => {
  if (scopeKey.startsWith('desktop:')) return 0
  if (scopeKey.startsWith('conversation:')) return 1
  if (scopeKey.startsWith('im:')) return 2
  return 3
}

/**
 * 同一 tabKey 出现在多个 scope 桶时的反查兜底（findSpaceByTabKey）。
 * 仅用于兼容/诊断查找，**不得**作为 TabDoc 迁移 / dedupe 的 winner 决策
 * （迁移用调用方显式 tabScopeKey；启动 dedupe 用 foreground workspaceContext）。
 *
 * 挑选顺序：
 * 1. activeKeyBySpace[scope] === tabKey 的 scope
 * 2. 否则 displayKeyBySpace[scope] === tabKey
 * 3. 再按 desktop > conversation > im > legacy spaceId（仅反查稳定排序）
 * 4. 同优先级按 scopeKey 字典序
 */
export function resolveSpaceByTabKey(
  tabKey: string,
  scopes: readonly string[],
  activeKeyBySpace: Record<string, ContextActiveKey>,
  displayKeyBySpace: Record<string, ContextActiveKey>,
): string | null {
  if (scopes.length === 0) return null
  if (scopes.length === 1) return scopes[0]

  const activeScopes = scopes.filter(scope => activeKeyBySpace[scope] === tabKey)
  const displayScopes = scopes.filter(scope => displayKeyBySpace[scope] === tabKey)
  const pool = activeScopes.length > 0
    ? activeScopes
    : displayScopes.length > 0
      ? displayScopes
      : scopes

  return [...pool].sort((a, b) => {
    const byKind = workspaceScopePriority(a) - workspaceScopePriority(b)
    if (byKind !== 0) return byKind
    return a.localeCompare(b)
  })[0] ?? null
}

interface SpaceContextTabsState {
  activeKeyBySpace: Record<string, ContextActiveKey>
  displayKeyBySpace: Record<string, ContextActiveKey>
  tabOrderBySpace: Record<string, string[]>
  itemsBySpace: Record<string, Record<string, ContextItemRecord>>
  /**
   * 显式 closeTab 的 scope 级修订号（运行时态、不持久化）。布局层据此区分用户/Agent
   * 的关闭动作与恢复、水合、同步引起的 tab 列表变化。
   */
  explicitCloseRevisionByScope: Record<string, number>
  /**
   * 本次运行期内由用户显式关闭的标签。用于拒绝关闭前一帧迟到的 sync/restore 快照；
   * 用户再次主动打开同一标签时清除对应条目。无需持久化，最终的空标签状态本身会持久化。
   */
  explicitClosedTabKeysByScope: Record<string, string[]>
  /**
   * 父 chat session → 该 session 下用户最后一次激活过的 subagent runId。
   *
   * P2-13（PRD v3.1）：用户切对话再切回来时，期望"上次正看的子 Agent 详情还在"。
   * 当前 activeKeyBySpace 是 Space 级别，切 session 时 useTabSync P0-B fallback
   * 会把 active 从 subagent 移到第一个可见 tab（避免 dead activeKey），切回原
   * session 时这条信息丢失。
   *
   * 解决：每次 setActiveKey 到 subagent_session 类型时记录 (parentSessionId → runId)；
   * useTabSync 的 fallback effect 在 fallback 之前先 try recall：如果当前 session
   * 有记录、且对应 tabKey 仍在 visibleTabKeys 里 → 直接 setActiveKey 回去。
   *
   * 持久化：跟 activeKeyBySpace 一起进 partialize，重启后也能恢复。
   * 清理：clearOrphanSubagentTabs 时按 parentSessionId 清掉对应条目。
   */
  lastActiveSubagentByParentSession: Record<string, string>
  openResourceTab: (spaceId: string, params: OpenResourceTabParams) => void
  openTableTab: (
    spaceId: string,
    tableId: string,
    activate?: boolean,
    meta?: ContextItemRecord['meta'],
    title?: string,
  ) => void
  closeTab: (spaceId: string, tabKey: string, fallbackActiveKey?: ContextActiveKey) => void
  /** 用户/Agent 显式关闭：在 tab 真实存在时同步记录关闭意图。 */
  closeExplicitTab?: (spaceId: string, tabKey: string, fallbackActiveKey?: ContextActiveKey) => void
  /** 用户显式批量关闭。 */
  batchCloseExplicitTabs?: (spaceId: string, tabKeys: string[]) => void
  /** 资源 handler 已自行移除 tab 时，保留一次用户/Agent 显式关闭意图。 */
  recordExplicitTabClose: (spaceId: string, tabKeys?: string | string[]) => void
  closeResourceTabEverywhere: (type: string, id: string) => void
  closeTableTab: (spaceId: string, tableId: string, fallbackActiveKey?: ContextActiveKey) => void
  setTabOrder: (spaceId: string, orderedKeys: string[]) => void
  syncTabOrder: (spaceId: string, tabKeys: string[], activeKey?: string | null) => void
  upsertItems: (spaceId: string, items: ContextItemRecord[]) => void
  syncItemsByType: (spaceId: string, type: string, items: ContextItemRecord[]) => void
  getOpenTableTabs: (spaceId: string) => string[]
  /**
   * 设置前景 tab。可选 `options.writer` 声明写入者；缺省视为 `user`。
   * @returns 是否实际写入（被意图闸门拒绝时为 false）
   */
  setActiveKey: (spaceId: string, key: ContextActiveKey, options?: SetActiveKeyOptions) => boolean
  getActiveKey: (spaceId: string) => ContextActiveKey
  getNavigationIntent: (spaceId: string) => NavigationIntent | undefined
  getNavigationRevision: (spaceId: string) => number
  setDisplayKey: (spaceId: string, key: ContextActiveKey) => void
  getDisplayKey: (spaceId: string) => ContextActiveKey
  findSpaceByTabKey: (tabKey: string) => string | null
  replaceTabKey: (spaceId: string, oldTabKey: string, newTabKey: string, newId: string) => void
  removeItem: (spaceId: string, tabKey: string) => void
  /**
   * 清理父 chat session 删除后留下的 subagent_session orphan tabs（PRD §4.13）。
   *
   * 扫 `tabOrderBySpace[spaceId]` 全量（不能只看 visibleTabKeys——隐藏的 orphan
   * 也要清），找 `type === 'subagent_session' && meta.parentSessionId === sessionId`
   * 的 tab 一次性 batchCloseTab。**不**触发 handler.beforeClose——这是 session
   * 删除后的批量清理，弹确认毫无意义且违背批处理语义。
   *
   * 调用方：useChatStore.deleteSession / deleteSessionPermanently 成功之后。
   * 不动 IPC 缓存（独立的 useSubagentSessionStore.clearByParentSession 负责那一层）。
   */
  clearOrphanSubagentTabs: (spaceId: string, sessionId: string) => void
  /**
   * P2-13：try 恢复某 session 上次激活过的 subagent_session tab。
   *
   * @returns true 表示成功 setActiveKey 回上次激活的 subagent；false 表示无记录 /
   *           对应 tabKey 已不存在 / 已被 isVisibleInContext 隐藏。useTabSync 在
   *           fallback effect 内调用，false 时走原 fallback 路径（home/第一个可见 tab）。
   */
  recallActiveSubagentForSession: (spaceId: string, parentSessionId: string, visibleTabKeys: string[]) => boolean
  /**
   * 合并式更新某个 tab item 的 meta 字段。
   * - 仅当该 tabKey 存在于 itemsBySpace[spaceId] 才生效，否则静默 no-op
   * - 浅合并：metaPatch 的字段覆盖原 meta，不会清空未提到的键
   * - 与原 meta 完全相等时不触发 setState，避免 persist 抖动
   *
   * 用例：tabdata 的 lastViewId、tabdoc/tabcode 的滚动光标、tabweb 的 scrollY 等
   * 「tab 内部位置 / 视图」状态写回到持久化层，让冷启动恢复时能拿到。
   */
  setItemMeta: (spaceId: string, tabKey: string, metaPatch: Record<string, unknown>) => void
  syncOpenResourceTabTitle: (input: { type: string; id: string; title: string; spaceId?: string | null }) => void
  /** 将资源实例 icon 同步到已打开 tab 的 meta.icon（列表/侧栏图标即时更新） */
  syncOpenResourceTabIcon: (input: {
    type: string
    id: string
    icon: string | null | undefined
    spaceId?: string | null
  }) => void
  batchCloseTab: (spaceId: string, tabKeys: string[]) => void
  hasScopeData: (scopeKey: string) => boolean
  /**
   * Phase2 scope adapter：首次进入 Organization+User 共享 desktop scope 时，
   * 从当前 execution Space 的旧 per-space tabs 复制一份作为起点。
   * conversation scope 不调用此方法，因此新对话保持空白标签组。
   */
  ensureScopeInitializedFromLegacy: (scopeKey: string, legacySpaceId: string) => boolean
  /**
   * 草稿→正式会话：把 fromScope 的标签合并进 toScope 后清空 fromScope（单次 set 原子完成）。
   *
   * 与 ensureScopeInitializedFromLegacy + clearSpaceTabs 不同：目标已有数据时仍会
   * 把源里缺失的 tab 并入，避免「skip copy + 无条件 clear」丢掉用户已开标签。
   */
  rehomeScopeTabs: (fromScopeKey: string, toScopeKey: string) => boolean
  applyRestoreDecision: (
    spaceId: string,
    patch: {
      tabOrder: string[]
      items: Record<string, ContextItemRecord>
      activeKey: ContextActiveKey
      displayKey: ContextActiveKey
    },
    baseSignature: string,
  ) => boolean
  clearSpaceTabs: (spaceId: string) => void
  purgeStaleEntries: (validSpaceIds: Set<string>) => void
}

type SpaceContextTabsPersistState = Pick<
  SpaceContextTabsState,
  'activeKeyBySpace' | 'displayKeyBySpace' | 'tabOrderBySpace' | 'itemsBySpace' | 'lastActiveSubagentByParentSession'
>

import { isPersistedWorkspaceScopeKey } from '@components/layout/tabScopeRegistry'

const summarizeContextTabsPersistState = (state: Partial<SpaceContextTabsPersistState>) => {
  const active = state.activeKeyBySpace ?? {}
  const display = state.displayKeyBySpace ?? {}
  const orders = state.tabOrderBySpace ?? {}
  const itemsBySpace = state.itemsBySpace ?? {}
  const spaceIds = Array.from(new Set([
    ...Object.keys(active),
    ...Object.keys(display),
    ...Object.keys(orders),
    ...Object.keys(itemsBySpace),
  ])).sort()

  return {
    spaces: spaceIds.map(spaceId => {
      const order = orders[spaceId] ?? []
      const items = itemsBySpace[spaceId] ?? {}
      return {
        spaceId,
        active: active[spaceId] ?? null,
        display: display[spaceId] ?? null,
        order,
        itemKeys: Object.keys(items).sort(),
        missingItems: order.filter(key => !(key in items)),
      }
    }),
  }
}

/**
 * Post-mutation invariant check with self-healing.
 * Detects two classes of inconsistency and repairs them in a single setState:
 *   1. activeKey references a key that no longer exists in tabOrder
 *   2. tabOrder contains keys that have no corresponding item record
 *
 * Defined before `useSpaceContextTabsStore` but only called at runtime
 * (inside store actions), so the forward reference is safe.
 */
const assertTripleConsistency = (spaceId: string) => {
  const state = useSpaceContextTabsStore.getState()
  const active = state.activeKeyBySpace[spaceId] ?? null
  const order = state.tabOrderBySpace[spaceId] ?? []
  const items = state.itemsBySpace[spaceId] ?? {}
  const intent = navIntentBySpace.get(spaceId)

  const activeMissingFromOrder = active != null && !order.includes(active)
  const activeMissingFromItems = active != null && !(active in items)
  // 瞬时「order 有 / items 未到」：保留用户目标，只记诊断，不删 order、不改 active
  const protectedActiveTransient =
    active != null
    && order.includes(active)
    && !(active in items)
    && intent?.targetKey === active

  const orderOrphans = order.filter(key => {
    if (key in items) return false
    // 当前用户目标在 items 未到前不得被当成 orphan 删掉
    if (protectedActiveTransient && key === active) return false
    if (intent?.targetKey === key && intent.writer === 'user') return false
    return true
  })

  if (!activeMissingFromOrder && !activeMissingFromItems && orderOrphans.length === 0) {
    if (protectedActiveTransient) {
      traceTabRestore('contextTabs:selfHeal:deferTransientItemsGap', {
        spaceId,
        active,
        revision: intent?.revision ?? 0,
      })
    }
    return
  }

  if (activeMissingFromOrder || activeMissingFromItems) {
    log.warn('self-healing: activeKey structurally incomplete', {
      spaceId,
      active,
      activeMissingFromOrder,
      activeMissingFromItems,
    })
  }
  if (orderOrphans.length > 0) {
    log.warn('self-healing: removing orphaned tabOrder keys', { spaceId, keys: orderOrphans })
  }
  traceTabRestore('contextTabs:selfHeal', {
    spaceId,
    active,
    order,
    itemKeys: Object.keys(items).sort(),
    activeMissingFromOrder,
    activeMissingFromItems,
    orderOrphans,
    revision: intent?.revision ?? 0,
  })

  useSpaceContextTabsStore.setState(prev => {
    const prevActive = prev.activeKeyBySpace[spaceId] ?? null
    const prevOrder = prev.tabOrderBySpace[spaceId] ?? []
    const prevItems = prev.itemsBySpace[spaceId] ?? {}
    const prevIntent = navIntentBySpace.get(spaceId)

    // 保留：items 已有的 key；以及仍被用户意图保护、items 暂缺的 active
    const healedOrder = prevOrder.filter(key => {
      if (key in prevItems) return true
      if (prevIntent?.writer === 'user' && prevIntent.targetKey === key) return true
      return false
    })
    // active 在 order 缺失但 items 仍在 → 补回 order，而不是清 active
    let orderWithActive = healedOrder
    if (
      prevActive
      && prevActive in prevItems
      && !orderWithActive.includes(prevActive)
    ) {
      orderWithActive = [...orderWithActive, prevActive]
    }
    const orderChanged =
      orderWithActive.length !== prevOrder.length
      || orderWithActive.some((key, i) => key !== prevOrder[i])

    let healedActive = prevActive
    const structurallyValid = isActiveStructurallyValid(
      spaceId,
      healedActive,
      orderWithActive,
      prevItems,
    )
    const decision = decideActiveKeyCommit({
      writer: 'self_heal',
      currentActive: prevActive,
      nextActive: structurallyValid
        ? prevActive
        : (orderWithActive.length > 0 ? orderWithActive[0] : null),
      intent: prevIntent,
      currentActiveStructurallyValid: structurallyValid,
    })
    if (!structurallyValid && decision.allow) {
      healedActive = orderWithActive.length > 0 ? orderWithActive[0] : null
      recordNavigationIntent(spaceId, {
        writer: 'self_heal',
        targetKey: healedActive,
        reason: 'self-heal-invalid-active',
        bumpRevision: false,
      })
    }
    const activeChanged = healedActive !== prevActive

    if (!orderChanged && !activeChanged) return prev

    return {
      tabOrderBySpace: orderChanged
        ? { ...prev.tabOrderBySpace, [spaceId]: orderWithActive }
        : prev.tabOrderBySpace,
      activeKeyBySpace: activeChanged
        ? { ...prev.activeKeyBySpace, [spaceId]: healedActive }
        : prev.activeKeyBySpace,
      displayKeyBySpace: activeChanged
        ? patchDisplayRecord(prev.displayKeyBySpace, spaceId, healedActive)
        : prev.displayKeyBySpace,
    }
  })
}

export const useSpaceContextTabsStore = create<SpaceContextTabsState>()(
  persist<SpaceContextTabsState, [], [], SpaceContextTabsPersistState>(
    (set, get) => ({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      explicitCloseRevisionByScope: {},
      explicitClosedTabKeysByScope: {},
      lastActiveSubagentByParentSession: {},

  openResourceTab: (spaceId, params) => {
    const tabKey = buildResourceTabKey(params.type, params.id)
    if (!isValidTabKey(tabKey)) {
      log.warn('openResourceTab: invalid tabKey, skipping', { spaceId, type: params.type, id: params.id })
      return
    }
    const silent = params.silent === true
    set(state => {
      const closedKeys = state.explicitClosedTabKeysByScope[spaceId] ?? []
      const nextClosedKeys = closedKeys.filter(key => key !== tabKey)
      const existingItems = state.itemsBySpace[spaceId] || {}
      const record: ContextItemRecord = {
        tabKey,
        type: params.type,
        id: params.id,
        title: params.title,
        meta: params.meta,
      }
      const prev = existingItems[tabKey]
      const itemsChanged = !isSameItem(prev, record)
      const nextItems = itemsChanged
        ? { ...existingItems, [tabKey]: prev?.originTabKey ? { ...record, originTabKey: prev.originTabKey } : record }
        : existingItems

      const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
      let nextOrder = order
      if (!order.includes(tabKey)) {
        const activeKey = state.activeKeyBySpace[spaceId] ?? null
        const next = order.slice()
        if (activeKey && next.includes(activeKey)) {
          next.splice(next.indexOf(activeKey) + 1, 0, tabKey)
        } else {
          next.push(tabKey)
        }
        nextOrder = next
      }

      const normalizedKey = tabKey
      const prevActiveKey = state.activeKeyBySpace[spaceId] ?? null
      const shouldChangeActive = !silent && prevActiveKey !== normalizedKey

      // PRD §4.14 + 红线 #10：silent=true 时**永远不改 active / displayKey**——
      // 即便 dedup 命中（prev tab 已存在）也不改。聚合视图 silent 决策依赖此契约。
      if (!itemsChanged && nextOrder === order && !shouldChangeActive) {
        return state
      }

      // P2-13：openResourceTab 把新 tab 直接 set active 时（shouldChangeActive=true）
      // 同步更新 lastActiveSubagentByParentSession 记录——openResourceTab 不走 setActiveKey，
      // 必须在这里独立处理一次，否则用户首次 drill-in 不会写入 map → 切走切回无法 recall。
      let nextLastActive = state.lastActiveSubagentByParentSession
      if (shouldChangeActive && params.type === 'subagent_session') {
        const meta = params.meta as { parentSessionId?: string } | undefined
        if (meta?.parentSessionId && nextLastActive[meta.parentSessionId] !== params.id) {
          nextLastActive = { ...nextLastActive, [meta.parentSessionId]: params.id }
        }
      }

      if (shouldChangeActive) {
        recordNavigationIntent(spaceId, {
          writer: 'user',
          targetKey: normalizedKey,
          reason: `openResourceTab:${params.type}`,
          bumpRevision: true,
        })
      }

      return {
        explicitClosedTabKeysByScope: nextClosedKeys.length === closedKeys.length
          ? state.explicitClosedTabKeysByScope
          : { ...state.explicitClosedTabKeysByScope, [spaceId]: nextClosedKeys },
        itemsBySpace: itemsChanged
          ? { ...state.itemsBySpace, [spaceId]: nextItems }
          : state.itemsBySpace,
        tabOrderBySpace: nextOrder !== order
          ? { ...state.tabOrderBySpace, [spaceId]: nextOrder }
          : state.tabOrderBySpace,
        activeKeyBySpace: shouldChangeActive
          ? { ...state.activeKeyBySpace, [spaceId]: normalizedKey }
          : state.activeKeyBySpace,
        displayKeyBySpace: shouldChangeActive
          ? patchDisplayRecord(state.displayKeyBySpace, spaceId, normalizedKey)
          : state.displayKeyBySpace,
        lastActiveSubagentByParentSession: nextLastActive,
      }
    })
    assertTripleConsistency(spaceId)
    if (shouldDebugTabSwitch()) {
      log.debug('openResourceTab', { spaceId, type: params.type, id: params.id, silent })
    }
  },

  openTableTab: (spaceId, tableId, activate = true, meta, title) => {
    set(state => {
      const tabKey = buildTableKey(tableId)
      const closedKeys = state.explicitClosedTabKeysByScope[spaceId] ?? []
      const nextClosedKeys = closedKeys.filter(key => key !== tabKey)
      const existingItems = state.itemsBySpace[spaceId] || {}
      const prevItem = existingItems[tabKey]
      const nextMeta = meta ? { ...(prevItem?.meta ?? {}), ...meta } : prevItem?.meta
      const nextTitle = typeof title === 'string' && title.trim()
        ? title.trim()
        : prevItem?.title
      const nextItem: ContextItemRecord = {
        ...(prevItem ?? {}),
        tabKey,
        type: 'tabdata',
        id: tableId,
        ...(nextTitle ? { title: nextTitle } : {}),
        ...(nextMeta ? { meta: nextMeta } : {}),
      }
      const itemChanged = !isSameItem(prevItem, nextItem)
      const nextItems = itemChanged
        ? { ...existingItems, [tabKey]: nextItem }
        : existingItems

      const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
      if (order.includes(tabKey)) {
        if (!activate && !itemChanged) return state
        const patch: Partial<SpaceContextTabsState> = {}
        if (activate) {
          recordNavigationIntent(spaceId, {
            writer: 'user',
            targetKey: tabKey,
            reason: 'openTableTab',
            bumpRevision: true,
          })
          patch.activeKeyBySpace = { ...state.activeKeyBySpace, [spaceId]: tabKey }
          patch.displayKeyBySpace = patchDisplayRecord(state.displayKeyBySpace, spaceId, tabKey)
        }
        if (itemChanged) {
          patch.itemsBySpace = { ...state.itemsBySpace, [spaceId]: nextItems }
        }
        if (nextClosedKeys.length !== closedKeys.length) {
          patch.explicitClosedTabKeysByScope = {
            ...state.explicitClosedTabKeysByScope,
            [spaceId]: nextClosedKeys,
          }
        }
        return patch
      }
      const currentActiveKey = state.activeKeyBySpace[spaceId] ?? null
      const next = order.slice()
      if (currentActiveKey && next.includes(currentActiveKey)) {
        const insertIndex = next.indexOf(currentActiveKey) + 1
        next.splice(insertIndex, 0, tabKey)
      } else {
        next.push(tabKey)
      }
      const base: Partial<SpaceContextTabsState> = {
        tabOrderBySpace: { ...state.tabOrderBySpace, [spaceId]: next },
        itemsBySpace: { ...state.itemsBySpace, [spaceId]: nextItems },
        explicitClosedTabKeysByScope: nextClosedKeys.length === closedKeys.length
          ? state.explicitClosedTabKeysByScope
          : { ...state.explicitClosedTabKeysByScope, [spaceId]: nextClosedKeys },
      }
      if (activate) {
        recordNavigationIntent(spaceId, {
          writer: 'user',
          targetKey: tabKey,
          reason: 'openTableTab',
          bumpRevision: true,
        })
        base.activeKeyBySpace = { ...state.activeKeyBySpace, [spaceId]: tabKey }
        base.displayKeyBySpace = patchDisplayRecord(state.displayKeyBySpace, spaceId, tabKey)
      }
      return base
    })
    assertTripleConsistency(spaceId)
    if (shouldDebugTabSwitch()) {
      log.debug('openTableTab', { spaceId, tableId, activate })
    }
  },

  /**
   * 关闭 Space 的某个 tab（移除 tab item + 调整 active key）。
   *
   * **单根契约下的产品决策（见 docs/single-root-space-prd.md §2.1 / §2.4）**：
   * 关 tab **不**撤销 workspace 授权——main 端 `session.workspaceSnapshot.allowedPaths`
   * 来自 `agent.working_dir` + `sessionApprovedPaths`，跟 tab 生命周期解耦。
   *
   * 撤销授权的入口（按粒度从粗到细）：
   *   - **修改 Agent 工作目录**：到 Agent 设置面板改 `working_dir`，下次 setActiveSpace
   *     hydrate 时 main 端的 allowedPaths 自动收敛到新目录
   *   - **重启 / 切 Space / 切 Agent**：清空 `sessionApprovedPaths`（审批通过的临时
   *     路径仅 session 内有效，下次需要重新审批）
   *
   * 设计意图：tab 是 UI 临时容器，关 tab 是高频随手操作；授权状态应该跟用户
   * 显式行为绑定（改 working_dir、关 session），不靠"关 tab 副作用"驱动。
   */
  closeTab: (spaceId, tabKey, fallbackActiveKey) => {
    set(state => {
      const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
      const closedIdx = order.indexOf(tabKey)
      const nextOrder = order.filter(key => key !== tabKey)

      const existingItems = state.itemsBySpace[spaceId]
      const hasItem = existingItems && tabKey in existingItems
      let nextItems = existingItems
      if (hasItem) {
        nextItems = { ...existingItems }
        delete nextItems[tabKey]
      }

      const currentActive = state.activeKeyBySpace[spaceId] ?? null
      let nextActive = currentActive
      if (currentActive === tabKey) {
        if (fallbackActiveKey !== undefined) {
          nextActive = fallbackActiveKey
        } else {
          const fallbackIdx = Math.min(closedIdx, nextOrder.length - 1)
          nextActive = fallbackIdx >= 0 ? nextOrder[fallbackIdx] : null
        }
      }

      if (closedIdx < 0 && !hasItem && currentActive !== tabKey) return state

      const activeChanged = nextActive !== currentActive
      if (activeChanged) {
        recordNavigationIntent(spaceId, {
          writer: 'fallback',
          targetKey: nextActive,
          reason: 'closeTab',
          bumpRevision: true,
        })
      }

      return {
        tabOrderBySpace: closedIdx >= 0
          ? { ...state.tabOrderBySpace, [spaceId]: nextOrder }
          : state.tabOrderBySpace,
        itemsBySpace: hasItem
          ? { ...state.itemsBySpace, [spaceId]: nextItems }
          : state.itemsBySpace,
        activeKeyBySpace: activeChanged
          ? { ...state.activeKeyBySpace, [spaceId]: nextActive }
          : state.activeKeyBySpace,
        displayKeyBySpace: activeChanged
          ? patchDisplayRecord(state.displayKeyBySpace, spaceId, nextActive)
          : state.displayKeyBySpace,

      }
    })
    assertTripleConsistency(spaceId)
    if (shouldDebugTabSwitch()) {
      log.debug('closeTab', { spaceId, tabKey, fallbackActiveKey })
    }
  },

  closeExplicitTab: (spaceId, tabKey, fallbackActiveKey) => {
    const wasOpen = get().tabOrderBySpace[spaceId]?.includes(tabKey) ?? false
    if (wasOpen) get().recordExplicitTabClose(spaceId, tabKey)
    get().closeTab(spaceId, tabKey, fallbackActiveKey)
  },

  batchCloseExplicitTabs: (spaceId, tabKeys) => {
    const hasOpenTab = tabKeys.some(key => get().tabOrderBySpace[spaceId]?.includes(key))
    if (hasOpenTab) get().recordExplicitTabClose(spaceId, tabKeys)
    get().batchCloseTab(spaceId, tabKeys)
  },

  recordExplicitTabClose: (spaceId, tabKeys) => {
    set(state => {
      const candidates = Array.isArray(tabKeys) ? tabKeys : tabKeys ? [tabKeys] : []
      const persistOnlyPrefixes = contextRegistry.getPersistedOnlyPrefixes()
      const incoming = candidates.filter(tabKey =>
        persistOnlyPrefixes.some(prefix => tabKey.startsWith(prefix)),
      )
      const existing = state.explicitClosedTabKeysByScope[spaceId] ?? []
      const next = Array.from(new Set([...existing, ...incoming]))
      return {
        explicitCloseRevisionByScope: {
          ...state.explicitCloseRevisionByScope,
          [spaceId]: (state.explicitCloseRevisionByScope[spaceId] ?? 0) + 1,
        },
        explicitClosedTabKeysByScope: next.length === existing.length
          ? state.explicitClosedTabKeysByScope
          : { ...state.explicitClosedTabKeysByScope, [spaceId]: next },
      }
    })
  },

  closeResourceTabEverywhere: (type, id) => {
    if (!type || !id) return
    const tabKey = buildResourceTabKey(type, id)
    const state = get()
    const scopeKeys = new Set([
      ...Object.keys(state.tabOrderBySpace),
      ...Object.keys(state.itemsBySpace),
      ...Object.keys(state.activeKeyBySpace),
    ])
    for (const scopeKey of scopeKeys) {
      if (
        state.tabOrderBySpace[scopeKey]?.includes(tabKey)
        || Boolean(state.itemsBySpace[scopeKey]?.[tabKey])
        || state.activeKeyBySpace[scopeKey] === tabKey
      ) {
        get().closeTab(scopeKey, tabKey, null)
      }
    }
  },

  closeTableTab: (spaceId, tableId, fallbackActiveKey) => {
    const tabKey = buildTableKey(tableId)
    get().closeTab(spaceId, tabKey, fallbackActiveKey)
  },

  setTabOrder: (spaceId, orderedKeys) => {
    const normalizedKeys = normalizeTabKeys(orderedKeys)
    if (!normalizedKeys) return
    set(state => {
      const current = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
      if (current.length === normalizedKeys.length && current.every((key, index) => key === normalizedKeys[index])) {
        return state
      }
      return {
        tabOrderBySpace: {
          ...state.tabOrderBySpace,
          [spaceId]: normalizedKeys
        }
      }
    })
  },

  syncTabOrder: (spaceId, tabKeys, activeKey) => {
    set(state => {
      const normalizedInputKeys = normalizeTabKeys(tabKeys)
      if (!normalizedInputKeys) {
        traceTabRestore('contextTabs:syncTabOrder:invalid', { spaceId, tabKeys, activeKey })
        return state
      }
      const explicitlyClosed = new Set(state.explicitClosedTabKeysByScope[spaceId] ?? [])
      const normalizedKeys = normalizedInputKeys
      const normalizedActiveKey =
        typeof activeKey === 'string' && isValidTabKey(activeKey) && !explicitlyClosed.has(activeKey)
          ? activeKey
          : null
      if (shouldDebugTabSwitch()) {
        const prevOrder = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
        const prevBrowserKeys = prevOrder.filter(k => k.startsWith('tabweb:'))
        const incomingBrowserKeys = normalizedKeys.filter(k => k.startsWith('tabweb:'))
        if (prevBrowserKeys.length !== incomingBrowserKeys.length) {
          log.debug('syncTabOrder browser keys changed', {
            spaceId,
            prev: prevBrowserKeys.length,
            incoming: incomingBrowserKeys.length,
          })
        }
      }
      // activeKey 不再自动追加到 tabOrder — 它只是选中指针。
      // persistOnly 结构纪律见 mergeSyncedTabOrder：空投影不得掏空仍存活的文档类 tab。
      const existing = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
      const items = state.itemsBySpace[spaceId] || {}
      const persistOnlyPrefixes = contextRegistry.getPersistedOnlyPrefixes()
      const { next, added, removed, preservedPersistOnly } = mergeSyncedTabOrder({
        existingOrder: existing,
        incomingKeys: normalizedKeys,
        items,
        isPersistOnlyKey: tabKey => persistOnlyPrefixes.some(prefix => tabKey.startsWith(prefix)),
        activeKey: normalizedActiveKey,
        blockedKeys: explicitlyClosed,
      })
      traceTabRestore('contextTabs:syncTabOrder', {
        spaceId,
        activeKey: normalizedActiveKey,
        incoming: normalizedKeys,
        existing,
        next,
        removed,
        added,
        preservedPersistOnly,
      })
      if (next.length === existing.length && next.every((key, index) => key === existing[index])) {
        return state
      }
      if (shouldDebugTabSwitch()) {
        log.debug('syncTabOrder', {
          spaceId,
          activeKey: normalizedActiveKey,
          prev: existing,
          next,
          preservedPersistOnly,
        })
      }
      return {
        tabOrderBySpace: {
          ...state.tabOrderBySpace,
          [spaceId]: next
        }
      }
    })
  },

  upsertItems: (spaceId, items) => {
    set(state => {
      const existing = state.itemsBySpace[spaceId] || {}
      let changed = false
      const next = { ...existing }
      items.forEach(item => {
        if (!isSameItem(existing[item.tabKey], item)) {
          const prev = existing[item.tabKey]
          next[item.tabKey] = prev?.originTabKey && !item.originTabKey
            ? { ...item, originTabKey: prev.originTabKey }
            : item
          changed = true
        }
      })
      if (!changed) return state
      return {
        itemsBySpace: {
          ...state.itemsBySpace,
          [spaceId]: next
        }
      }
    })
  },

  syncItemsByType: (spaceId, type, items) => {
    const normalizedItems = normalizeItems(items)
    set(state => {
      const existing = state.itemsBySpace[spaceId] || {}
      const existingOfType = Object.values(existing).filter(i => i.type === type)
      if (shallowEqualItemSets(existingOfType, normalizedItems)) return state

      const incomingMap = new Map(normalizedItems.map(item => [item.tabKey, item]))
      let changed = false
      const next: Record<string, ContextItemRecord> = { ...existing }

      Object.entries(existing).forEach(([key, item]) => {
        if (item.type === type && !incomingMap.has(key)) {
          if (item.meta?.discarded) return
          delete next[key]
          changed = true
        }
      })

      normalizedItems.forEach(item => {
        if (!isSameItem(existing[item.tabKey], item)) {
          const prev = existing[item.tabKey]
          next[item.tabKey] = prev?.originTabKey && !item.originTabKey
            ? { ...item, originTabKey: prev.originTabKey }
            : item
          changed = true
        }
      })

      traceTabRestore('contextTabs:syncItemsByType', {
        spaceId,
        type,
        incomingKeys: normalizedItems.map(item => item.tabKey),
        existingKeys: existingOfType.map(item => item.tabKey),
        changed,
      })

      if (!changed) return state
      return {
        itemsBySpace: {
          ...state.itemsBySpace,
          [spaceId]: next
        }
      }
    })
  },

  getOpenTableTabs: (spaceId) => {
    const order = get().tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
    const tableIds: string[] = []
    for (const key of order) {
      const parsed = parseTabKey(key)
      if (parsed?.type === 'tabdata') tableIds.push(parsed.id)
    }
    return tableIds.length > 0 ? tableIds : EMPTY_TABLE_TABS
  },

  setActiveKey: (spaceId, key, options) => {
    const normalizedKey = typeof key === 'string' && isValidTabKey(key) ? key : null
    const writer = options?.writer ?? 'user'
    const reason = options?.reason ?? 'setActiveKey'
    let applied = false

    set(state => {
      const prevActive = state.activeKeyBySpace[spaceId] ?? null
      const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
      const items = state.itemsBySpace[spaceId] ?? {}
      const intent = navIntentBySpace.get(spaceId)
      const structurallyValid = isActiveStructurallyValid(spaceId, prevActive, order, items)
      const decision = decideActiveKeyCommit({
        writer,
        currentActive: prevActive,
        nextActive: normalizedKey,
        intent,
        expectedRevision: options?.expectedRevision,
        currentActiveStructurallyValid: structurallyValid,
      })

      if (!decision.allow) {
        log.info('setActiveKey: blocked by navigation intent', {
          spaceId: spaceId.slice(0, 8),
          from: prevActive,
          to: normalizedKey,
          writer,
          reason,
          decision: decision.reason,
          revision: intent?.revision ?? 0,
        })
        traceTabRestore('navIntent:activeBlocked', {
          spaceId,
          prevActive,
          nextActive: normalizedKey,
          writer,
          reason,
          decision: decision.reason,
          revision: intent?.revision ?? 0,
        })
        return state
      }

      if (prevActive === normalizedKey) {
        if (decision.bumpRevision || writer === 'user') {
          recordNavigationIntent(spaceId, {
            writer,
            targetKey: normalizedKey,
            reason,
            bumpRevision: decision.bumpRevision || writer === 'user',
          })
        }
        applied = true
        return state
      }

      const debugStack = (() => {
        try {
          return new Error().stack?.split('\n').slice(2, 8).map(l => l.trim()).filter(Boolean) ?? []
        } catch {
          return []
        }
      })()
      log.debug('setActiveKey CHANGE', {
        spaceId: spaceId.slice(0, 8),
        from: prevActive,
        to: normalizedKey,
        writer,
        reason,
        stack: debugStack,
      })
      if (normalizedKey && !order.includes(normalizedKey)) {
        log.warn('setActiveKey: key not in tabOrder', { spaceId, key: normalizedKey })
      }

      let revision = getNavigationRevision(spaceId)
      if (writer === 'user' || decision.bumpRevision) {
        revision = recordNavigationIntent(spaceId, {
          writer,
          targetKey: normalizedKey,
          reason,
          bumpRevision: decision.bumpRevision || writer === 'user',
        }).revision
      } else {
        // 后台写入可改 active，但不得把 user intent 元数据冲成 restore/source_sync
        const prevIntent = navIntentBySpace.get(spaceId)
        if (prevIntent) {
          navIntentBySpace.set(spaceId, {
            ...prevIntent,
            targetKey: normalizedKey,
            at: Date.now(),
          })
          revision = prevIntent.revision
        }
        traceTabRestore('navIntent:activeMigratedWithoutBump', {
          spaceId,
          prevActive,
          nextActive: normalizedKey,
          writer,
          reason,
          revision,
        })
      }
      traceTabRestore('contextTabs:setActiveKey', {
        spaceId,
        prevActive,
        nextActive: normalizedKey,
        writer,
        reason,
        revision,
        order,
      })

      let nextLastActive = state.lastActiveSubagentByParentSession
      if (normalizedKey) {
        const item = state.itemsBySpace[spaceId]?.[normalizedKey]
        if (item?.type === 'subagent_session') {
          const meta = item.meta as { parentSessionId?: string } | undefined
          if (meta?.parentSessionId && nextLastActive[meta.parentSessionId] !== item.id) {
            nextLastActive = { ...nextLastActive, [meta.parentSessionId]: item.id }
          }
        }
      }
      applied = true
      return {
        activeKeyBySpace: {
          ...state.activeKeyBySpace,
          [spaceId]: normalizedKey
        },
        displayKeyBySpace: patchDisplayRecord(state.displayKeyBySpace, spaceId, normalizedKey),
        lastActiveSubagentByParentSession: nextLastActive,
      }
    })
    if (shouldDebugTabSwitch()) {
      log.debug('setActiveKey', { spaceId, key: normalizedKey, writer, reason, applied })
    }
    return applied
  },

  getActiveKey: (spaceId) => {
    return get().activeKeyBySpace[spaceId] ?? null
  },

  getNavigationIntent: (spaceId) => getNavigationIntent(spaceId),

  getNavigationRevision: (spaceId) => getNavigationRevision(spaceId),

  setDisplayKey: (spaceId, key) => {
    set(state => {
      const normalizedKey = key == null
        ? null
        : typeof key === 'string' && isValidTabKey(key)
          ? key
          : undefined
      if (normalizedKey === undefined) {
        return state
      }
      const nextDisplay = patchDisplayRecord(state.displayKeyBySpace, spaceId, normalizedKey)
      if (nextDisplay === state.displayKeyBySpace) {
        return state
      }
      return {
        displayKeyBySpace: nextDisplay
      }
    })
  },

  getDisplayKey: (spaceId) => {
    return get().displayKeyBySpace[spaceId] ?? null
  },

      findSpaceByTabKey: (tabKey) => {
        const { tabOrderBySpace, activeKeyBySpace, displayKeyBySpace } = get()
        if (!_reverseIndexCache || _reverseIndexCache.source !== tabOrderBySpace) {
          const index = new Map<string, string[]>()
          for (const [spaceId, order] of Object.entries(tabOrderBySpace)) {
            for (const key of order) {
              const list = index.get(key)
              if (list) list.push(spaceId)
              else index.set(key, [spaceId])
            }
          }
          _reverseIndexCache = { source: tabOrderBySpace, index }
        }
        const scopes = _reverseIndexCache.index.get(tabKey)
        if (!scopes || scopes.length === 0) return null
        const resolved = resolveSpaceByTabKey(
          tabKey,
          scopes,
          activeKeyBySpace,
          displayKeyBySpace,
        )
        if (scopes.length > 1) {
          // 生产导航应显式传 tabScopeKey；全局反查仅兼容/诊断 fallback
          log.warn('findSpaceByTabKey: duplicate tabKey across scopes', {
            tabKey,
            scopes,
            resolved,
            activeIn: scopes.filter(scope => activeKeyBySpace[scope] === tabKey),
          })
          traceTabRestore('navIntent:findSpaceByTabKeyMultiScope', {
            tabKey,
            scopes,
            resolved,
          })
        }
        return resolved
      },

      replaceTabKey: (spaceId, oldTabKey, newTabKey, newId) => {
        if (oldTabKey === newTabKey) return
        let resolvedSpaceId = spaceId
        set(state => {
          let targetSpaceId = spaceId
          let order = state.tabOrderBySpace[targetSpaceId] ?? EMPTY_TAB_ORDER
          let items = state.itemsBySpace[targetSpaceId] || {}

          if (!items[oldTabKey] && !order.includes(oldTabKey)) {
            const matchedSpaceId = Object.keys(state.itemsBySpace).find((candidateSpaceId) => {
              const candidateItems = state.itemsBySpace[candidateSpaceId] || {}
              return Boolean(candidateItems[oldTabKey])
            })
            if (matchedSpaceId) {
              targetSpaceId = matchedSpaceId
              order = state.tabOrderBySpace[targetSpaceId] ?? EMPTY_TAB_ORDER
              items = state.itemsBySpace[targetSpaceId] || {}
            }
          }
          resolvedSpaceId = targetSpaceId

          const oldItem = items[oldTabKey]
          if (!oldItem && !order.includes(oldTabKey)) return state

          const nextOrder = order.map(k => (k === oldTabKey ? newTabKey : k))

          const nextItems = { ...items }
          if (oldItem) {
            delete nextItems[oldTabKey]
            nextItems[newTabKey] = {
              ...oldItem,
              tabKey: newTabKey,
              id: newId,
              originTabKey: oldItem.originTabKey || oldTabKey,
            }
          }

          const activeKey = state.activeKeyBySpace[targetSpaceId] ?? null
          const nextActive = activeKey === oldTabKey ? newTabKey : activeKey
          const nextDisplay = patchDisplayRecord(state.displayKeyBySpace, targetSpaceId, nextActive)

          return {
            tabOrderBySpace: { ...state.tabOrderBySpace, [targetSpaceId]: nextOrder },
            itemsBySpace: { ...state.itemsBySpace, [targetSpaceId]: nextItems },
            activeKeyBySpace: { ...state.activeKeyBySpace, [targetSpaceId]: nextActive },
            displayKeyBySpace: nextDisplay,
          }
        })
        assertTripleConsistency(resolvedSpaceId)
        if (shouldDebugTabSwitch()) {
          log.debug('replaceTabKey', { spaceId: resolvedSpaceId, oldTabKey, newTabKey })
        }
      },

      setItemMeta: (spaceId, tabKey, metaPatch) => {
        if (!metaPatch || typeof metaPatch !== 'object') return
        set(state => {
          const existing = state.itemsBySpace[spaceId]
          const item = existing?.[tabKey]
          if (!item) return state
          const prevMeta = item.meta ?? {}
          let changed = false
          for (const [key, value] of Object.entries(metaPatch)) {
            if (prevMeta[key] !== value) {
              changed = true
              break
            }
          }
          if (!changed) return state
          const nextMeta = { ...prevMeta, ...metaPatch }
          return {
            itemsBySpace: {
              ...state.itemsBySpace,
              [spaceId]: {
                ...existing,
                [tabKey]: { ...item, meta: nextMeta },
              },
            },
          }
        })
      },

      syncOpenResourceTabTitle: ({ type, id, title, spaceId }) => {
        const nextTitle = title.trim()
        if (!type || !id) return
        const tabKey = buildResourceTabKey(type, id)
        set(state => {
          const targetSpaceIds = spaceId ? [spaceId] : Object.keys(state.itemsBySpace)
          let changed = false
          const nextItemsBySpace = { ...state.itemsBySpace }

          for (const targetSpaceId of targetSpaceIds) {
            const items = state.itemsBySpace[targetSpaceId]
            const item = items?.[tabKey]
            if (!item || item.title === nextTitle) continue
            nextItemsBySpace[targetSpaceId] = {
              ...items,
              [tabKey]: { ...item, title: nextTitle },
            }
            changed = true
          }

          return changed ? { itemsBySpace: nextItemsBySpace } : state
        })
      },

      syncOpenResourceTabIcon: ({ type, id, icon, spaceId: _spaceId }) => {
        if (!type || !id) return
        const tabKey = buildResourceTabKey(type, id)
        const nextIcon = typeof icon === 'string' ? icon.trim() : ''
        set(state => {
          // 桌面/对话 scope key（desktop:organization:...）不等于资源所属 Space UUID。
          // 侧栏「标签」挂在这些 scope 上，必须扫所有已打开该资源的 scope，不能只按 spaceId 过滤。
          const targetSpaceIds = Object.keys(state.itemsBySpace).filter(
            sid => Boolean(state.itemsBySpace[sid]?.[tabKey]),
          )
          let changed = false
          const nextItemsBySpace = { ...state.itemsBySpace }

          for (const targetSpaceId of targetSpaceIds) {
            const items = state.itemsBySpace[targetSpaceId]
            const item = items?.[tabKey]
            if (!item) continue
            const prevIcon = typeof item.meta?.icon === 'string' ? item.meta.icon : ''
            if (prevIcon === nextIcon) continue
            const nextMeta = { ...(item.meta ?? {}) }
            if (nextIcon) {
              nextMeta.icon = nextIcon
            } else {
              delete nextMeta.icon
            }
            nextItemsBySpace[targetSpaceId] = {
              ...items,
              [tabKey]: {
                ...item,
                meta: Object.keys(nextMeta).length > 0 ? nextMeta : undefined,
              },
            }
            changed = true
          }

          return changed ? { itemsBySpace: nextItemsBySpace } : state
        })
      },

      removeItem: (spaceId, tabKey) => {
        set(state => {
          const existing = state.itemsBySpace[spaceId]
          if (!existing || !(tabKey in existing)) return state
          const nextItems = { ...existing }
          delete nextItems[tabKey]

          const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
          const nextOrder = order.filter(k => k !== tabKey)
          const orderChanged = nextOrder.length !== order.length

          let nextActive = state.activeKeyBySpace[spaceId] ?? null
          const activeChanged = nextActive === tabKey
          if (activeChanged) {
            const idx = Math.min(order.indexOf(tabKey), nextOrder.length - 1)
            nextActive = idx >= 0 ? nextOrder[idx] : null
          }

          return {
            itemsBySpace: { ...state.itemsBySpace, [spaceId]: nextItems },
            tabOrderBySpace: orderChanged
              ? { ...state.tabOrderBySpace, [spaceId]: nextOrder }
              : state.tabOrderBySpace,
            activeKeyBySpace: activeChanged
              ? { ...state.activeKeyBySpace, [spaceId]: nextActive }
              : state.activeKeyBySpace,
            displayKeyBySpace: activeChanged
              ? patchDisplayRecord(state.displayKeyBySpace, spaceId, nextActive)
              : state.displayKeyBySpace,
          }
        })
        assertTripleConsistency(spaceId)
      },

      batchCloseTab: (spaceId, tabKeys) => {
        if (tabKeys.length === 0) return
        set(state => {
          const removeSet = new Set(tabKeys)
          const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
          const nextOrder = order.filter(k => !removeSet.has(k))
          const orderChanged = nextOrder.length !== order.length

          const existingItems = state.itemsBySpace[spaceId]
          let nextItems = existingItems
          let itemsChanged = false
          if (existingItems) {
            for (const key of tabKeys) {
              if (key in nextItems!) {
                if (!itemsChanged) {
                  nextItems = { ...existingItems }
                  itemsChanged = true
                }
                delete nextItems![key]
              }
            }
          }

          const currentActive = state.activeKeyBySpace[spaceId] ?? null
          let nextActive = currentActive
          if (currentActive && removeSet.has(currentActive)) {
            const closedIdx = order.indexOf(currentActive)
            const fallbackIdx = Math.min(closedIdx, nextOrder.length - 1)
            nextActive = fallbackIdx >= 0 ? nextOrder[fallbackIdx] : null
          }

          if (!orderChanged && !itemsChanged && nextActive === currentActive) return state

          return {
            tabOrderBySpace: orderChanged
              ? { ...state.tabOrderBySpace, [spaceId]: nextOrder }
              : state.tabOrderBySpace,
            itemsBySpace: itemsChanged
              ? { ...state.itemsBySpace, [spaceId]: nextItems! }
              : state.itemsBySpace,
            activeKeyBySpace: nextActive !== currentActive
              ? { ...state.activeKeyBySpace, [spaceId]: nextActive }
              : state.activeKeyBySpace,
            displayKeyBySpace: nextActive !== currentActive
              ? patchDisplayRecord(state.displayKeyBySpace, spaceId, nextActive)
              : state.displayKeyBySpace,

          }
        })
        assertTripleConsistency(spaceId)
        if (shouldDebugTabSwitch()) {
          log.debug('batchCloseTab', { spaceId, count: tabKeys.length })
        }
      },

      hasScopeData: (scopeKey) => {
        const state = get()
        return Boolean(
          (state.tabOrderBySpace[scopeKey]?.length ?? 0) > 0 ||
          Object.keys(state.itemsBySpace[scopeKey] ?? {}).length > 0 ||
          state.activeKeyBySpace[scopeKey] != null ||
          state.displayKeyBySpace[scopeKey] != null,
        )
      },

      ensureScopeInitializedFromLegacy: (scopeKey, legacySpaceId) => {
        if (!scopeKey || !legacySpaceId || scopeKey === legacySpaceId) return false
        let copied = false
        set(state => {
          const targetHasData = Boolean(
            (state.tabOrderBySpace[scopeKey]?.length ?? 0) > 0 ||
            Object.keys(state.itemsBySpace[scopeKey] ?? {}).length > 0 ||
            state.activeKeyBySpace[scopeKey] != null ||
            state.displayKeyBySpace[scopeKey] != null,
          )
          if (targetHasData) return state

          const sourceOrder = state.tabOrderBySpace[legacySpaceId]
          const sourceItems = state.itemsBySpace[legacySpaceId]
          const sourceActive = state.activeKeyBySpace[legacySpaceId] ?? null
          const sourceDisplay = state.displayKeyBySpace[legacySpaceId] ?? null
          const sourceHasData = Boolean(
            (sourceOrder?.length ?? 0) > 0 ||
            Object.keys(sourceItems ?? {}).length > 0 ||
            sourceActive != null ||
            sourceDisplay != null,
          )
          if (!sourceHasData) return state

          copied = true
          return {
            tabOrderBySpace: sourceOrder
              ? { ...state.tabOrderBySpace, [scopeKey]: sourceOrder.slice() }
              : state.tabOrderBySpace,
            itemsBySpace: sourceItems
              ? { ...state.itemsBySpace, [scopeKey]: { ...sourceItems } }
              : state.itemsBySpace,
            activeKeyBySpace: {
              ...state.activeKeyBySpace,
              [scopeKey]: sourceActive,
            },
            displayKeyBySpace: patchDisplayRecord(
              { ...state.displayKeyBySpace, [scopeKey]: sourceDisplay },
              scopeKey,
              sourceDisplay,
            ),
          }
        })
        if (copied && shouldDebugTabSwitch()) {
          log.debug('initialized scope from legacy space', {
            scopeKey,
            legacySpaceId,
          })
        }
        return copied
      },

      rehomeScopeTabs: (fromScopeKey, toScopeKey) => {
        if (!fromScopeKey || !toScopeKey || fromScopeKey === toScopeKey) return false
        let moved = false
        set(state => {
          const sourceOrder = state.tabOrderBySpace[fromScopeKey] ?? EMPTY_TAB_ORDER
          const sourceItems = state.itemsBySpace[fromScopeKey] ?? {}
          const sourceActive = state.activeKeyBySpace[fromScopeKey] ?? null
          const sourceDisplay = state.displayKeyBySpace[fromScopeKey] ?? null
          const sourceHasData = Boolean(
            sourceOrder.length > 0 ||
            Object.keys(sourceItems).length > 0 ||
            sourceActive != null ||
            sourceDisplay != null,
          )
          if (!sourceHasData) return state

          const targetOrder = state.tabOrderBySpace[toScopeKey] ?? EMPTY_TAB_ORDER
          const targetItems = state.itemsBySpace[toScopeKey] ?? {}
          const targetActive = state.activeKeyBySpace[toScopeKey] ?? null
          const targetDisplay = state.displayKeyBySpace[toScopeKey] ?? null

          const mergedOrder = targetOrder.slice()
          const adoptedKeys: string[] = []
          for (const tabKey of sourceOrder) {
            if (!mergedOrder.includes(tabKey)) {
              mergedOrder.push(tabKey)
              adoptedKeys.push(tabKey)
            }
          }

          // 目标已有同 key 时保留目标侧 item（含用户在正式 scope 上的后续改写）
          const mergedItems: Record<string, ContextItemRecord> = {
            ...sourceItems,
            ...targetItems,
          }

          const nextActive = targetActive ?? sourceActive
          const nextDisplay = targetDisplay ?? sourceDisplay

          const nextOrderBySpace = { ...state.tabOrderBySpace }
          const nextItemsBySpace = { ...state.itemsBySpace }
          const nextActiveBySpace = { ...state.activeKeyBySpace }
          const nextDisplayBySpace = { ...state.displayKeyBySpace }

          nextOrderBySpace[toScopeKey] = mergedOrder
          nextItemsBySpace[toScopeKey] = mergedItems
          nextActiveBySpace[toScopeKey] = nextActive
          delete nextOrderBySpace[fromScopeKey]
          delete nextItemsBySpace[fromScopeKey]
          delete nextActiveBySpace[fromScopeKey]
          delete nextDisplayBySpace[fromScopeKey]

          moved = true
          if (adoptedKeys.length > 0 && targetOrder.length > 0) {
            log.info('rehomeScopeTabs: merged source tabs into non-empty target', {
              fromScopeKey,
              toScopeKey,
              adoptedCount: adoptedKeys.length,
              targetCountBefore: targetOrder.length,
            })
          }

          return {
            tabOrderBySpace: nextOrderBySpace,
            itemsBySpace: nextItemsBySpace,
            activeKeyBySpace: nextActiveBySpace,
            displayKeyBySpace: patchDisplayRecord(
              nextDisplayBySpace,
              toScopeKey,
              nextDisplay,
            ),
          }
        })
        if (moved) {
          clearNavigationIntent(fromScopeKey)
          assertTripleConsistency(toScopeKey)
          if (shouldDebugTabSwitch()) {
            log.debug('rehomeScopeTabs', { fromScopeKey, toScopeKey })
          }
        }
        return moved
      },

      applyRestoreDecision: (spaceId, patch, baseSignature) => {
        let normalizedOrder = normalizeTabKeys(patch.tabOrder) ?? []
        const normalizedItems: Record<string, ContextItemRecord> = {}
        normalizeItems(patch.items).forEach(item => {
          if (isValidTabKey(item.tabKey)) {
            normalizedItems[item.tabKey] = item
          }
        })
        let normalizedActive =
          typeof patch.activeKey === 'string' && isValidTabKey(patch.activeKey)
            ? patch.activeKey
            : null
        let normalizedDisplay =
          typeof patch.displayKey === 'string' && isValidTabKey(patch.displayKey)
            ? patch.displayKey
            : null

        let applied = false
        set(state => {
          const explicitlyClosed = new Set(state.explicitClosedTabKeysByScope[spaceId] ?? [])
          if (explicitlyClosed.size > 0) {
            normalizedOrder = normalizedOrder.filter(key => !explicitlyClosed.has(key))
            for (const tabKey of explicitlyClosed) delete normalizedItems[tabKey]
            if (normalizedActive && explicitlyClosed.has(normalizedActive)) normalizedActive = null
            if (normalizedDisplay && explicitlyClosed.has(normalizedDisplay)) normalizedDisplay = null
          }
          const currentActive = state.activeKeyBySpace[spaceId] ?? null
          const currentOrder = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
          const currentItems = state.itemsBySpace[spaceId] ?? {}
          const currentSignature = buildContextTabsSignature({
            activeKey: currentActive,
            displayKey: state.displayKeyBySpace[spaceId] ?? null,
            tabOrder: currentOrder,
            items: currentItems,
          })
          if (currentSignature !== baseSignature) {
            log.warn('applyRestoreDecision: signature-mismatch (skipped)', {
              spaceId: spaceId.slice(0, 8),
              base: baseSignature.slice(0, 80),
              cur: currentSignature.slice(0, 80),
            })
            traceTabRestore('contextTabs:applyRestoreDecision:signatureMismatch', {
              spaceId,
              expected: baseSignature,
              actual: currentSignature,
              revision: getNavigationRevision(spaceId),
            })
            return state
          }

          const intent = navIntentBySpace.get(spaceId)
          const structurallyValid = isActiveStructurallyValid(
            spaceId,
            currentActive,
            currentOrder,
            currentItems,
          )
          // 用户目标仍在下一帧结构中（或至少还在当前 items/order）→ restore 不得改 active。
          // home（targetKey=null）是合法用户目标，不依赖 items/order 里存在某 key。
          const userTargetStillPresent =
            intent?.writer === 'user'
            && (
              intent.targetKey == null
              || intent.targetKey in normalizedItems
              || normalizedOrder.includes(intent.targetKey)
              || isActiveStructurallyValid(spaceId, intent.targetKey, currentOrder, currentItems)
            )
          const activeDecision = decideActiveKeyCommit({
            writer: 'restore',
            currentActive,
            nextActive: normalizedActive,
            intent,
            currentActiveStructurallyValid: structurallyValid,
          })
          if (!activeDecision.allow && userTargetStillPresent) {
            normalizedActive = currentActive
            normalizedDisplay =
              typeof currentActive === 'string' && currentActive.startsWith('tabweb:')
                ? currentActive
                : null
            // 确保用户目标不因 reconcile 被踢出 order/items
            if (currentActive && !(currentActive in normalizedItems) && currentItems[currentActive]) {
              normalizedItems[currentActive] = currentItems[currentActive]
            }
            if (currentActive && !normalizedOrder.includes(currentActive)) {
              normalizedOrder.push(currentActive)
            }
            traceTabRestore('navIntent:restoreActivePreserved', {
              spaceId,
              preservedActive: currentActive,
              restoreWanted: patch.activeKey,
              revision: intent?.revision ?? 0,
              decision: activeDecision.reason,
            })
          }

          const nextSignature = buildContextTabsSignature({
            activeKey: normalizedActive,
            displayKey: normalizedDisplay,
            tabOrder: normalizedOrder,
            items: normalizedItems,
          })
          if (nextSignature === currentSignature) {
            log.debug('applyRestoreDecision: noop-idempotent', {
              spaceId: spaceId.slice(0, 8),
            })
            applied = true
            return state
          }

          log.info('applyRestoreDecision: applying', {
            spaceId: spaceId.slice(0, 8),
            from: currentSignature.slice(0, 80),
            to: nextSignature.slice(0, 80),
            activeKey: normalizedActive,
            displayKey: normalizedDisplay,
            orderLen: normalizedOrder.length,
            itemsLen: Object.keys(normalizedItems).length,
            revision: intent?.revision ?? 0,
          })
          applied = true
          traceTabRestore('contextTabs:applyRestoreDecision', {
            spaceId,
            activeKey: normalizedActive,
            displayKey: normalizedDisplay,
            tabOrder: normalizedOrder,
            itemKeys: Object.keys(normalizedItems).sort(),
            writer: 'restore',
            revision: intent?.revision ?? 0,
          })
          return {
            tabOrderBySpace: {
              ...state.tabOrderBySpace,
              [spaceId]: normalizedOrder,
            },
            itemsBySpace: {
              ...state.itemsBySpace,
              [spaceId]: normalizedItems,
            },
            activeKeyBySpace: {
              ...state.activeKeyBySpace,
              [spaceId]: normalizedActive,
            },
            displayKeyBySpace: patchDisplayRecord(
              { ...state.displayKeyBySpace, [spaceId]: normalizedDisplay },
              spaceId,
              normalizedDisplay,
            ),
          }
        })
        return applied
      },

      clearOrphanSubagentTabs: (spaceId, sessionId) => {
        if (!spaceId || !sessionId) return
        const state = useSpaceContextTabsStore.getState()
        const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
        const items = state.itemsBySpace[spaceId] ?? {}

        // P2-13：父 session 删除时同步清掉 lastActiveSubagentByParentSession 记录，
        // 避免下次 session id 复用（极小概率，但语义干净）时 recall 到 dead runId。
        // 即便不清也无害（recall 时会 check tabKey 在不在 visibleTabKeys），这里
        // 主要是数据卫生。
        if (state.lastActiveSubagentByParentSession[sessionId]) {
          set(s => {
            const next = { ...s.lastActiveSubagentByParentSession }
            delete next[sessionId]
            return { lastActiveSubagentByParentSession: next }
          })
        }

        if (order.length === 0) return

        const toRemove: string[] = []
        for (const tabKey of order) {
          const item = items[tabKey]
          if (!item || item.type !== 'subagent_session') continue
          const meta = item.meta as { parentSessionId?: string } | undefined
          if (meta?.parentSessionId === sessionId) toRemove.push(tabKey)
        }
        if (toRemove.length === 0) return

        if (shouldDebugTabSwitch()) {
          log.debug('clearOrphanSubagentTabs', { spaceId, sessionId, count: toRemove.length })
        }
        useSpaceContextTabsStore.getState().batchCloseTab(spaceId, toRemove)
      },

      recallActiveSubagentForSession: (spaceId, parentSessionId, visibleTabKeys) => {
        if (!spaceId || !parentSessionId) return false
        const state = useSpaceContextTabsStore.getState()
        const lastRunId = state.lastActiveSubagentByParentSession[parentSessionId]
        if (!lastRunId) return false
        const tabKey = buildResourceTabKey('subagent_session', lastRunId)
        // 必须 still 在 visibleTabKeys 里——用户可能在切走后手动 × 关闭了该 subagent
        // 标签，或者 session 切换过程中该 subagent tab 已被 filter 隐藏（runId 还在
        // 但 parentSessionId 不匹配，不可能发生但兜底）
        if (!visibleTabKeys.includes(tabKey)) return false
        const order = state.tabOrderBySpace[spaceId] ?? EMPTY_TAB_ORDER
        if (!order.includes(tabKey)) return false
        if (state.activeKeyBySpace[spaceId] === tabKey) return true  // 已经是该 key，无需切
        if (shouldDebugTabSwitch()) {
          log.debug('recallActiveSubagentForSession', { spaceId, parentSessionId, tabKey })
        }
        useSpaceContextTabsStore.getState().setActiveKey(spaceId, tabKey)
        return true
      },

      clearSpaceTabs: (spaceId) => {
        clearNavigationIntent(spaceId)
        set(state => {
          const nextActive = { ...state.activeKeyBySpace }
          const nextDisplay = { ...state.displayKeyBySpace }
          delete nextActive[spaceId]
          delete nextDisplay[spaceId]
          const nextOrder = { ...state.tabOrderBySpace }
          delete nextOrder[spaceId]
          const nextItems = { ...state.itemsBySpace }
          delete nextItems[spaceId]
          const nextClosed = { ...state.explicitClosedTabKeysByScope }
          delete nextClosed[spaceId]
          return {
            activeKeyBySpace: nextActive,
            displayKeyBySpace: nextDisplay,
            tabOrderBySpace: nextOrder,
            itemsBySpace: nextItems,
            explicitClosedTabKeysByScope: nextClosed,
          }
        })
      },

      purgeStaleEntries: (validSpaceIds: Set<string>) => {
        set(state => {
          const filterRecord = <V,>(record: Record<string, V>): Record<string, V> => {
            const next: Record<string, V> = {}
            for (const [key, value] of Object.entries(record)) {
              if (validSpaceIds.has(key) || isPersistedWorkspaceScopeKey(key)) next[key] = value
            }
            return next
          }
          const prevKeyCount = Object.keys(state.tabOrderBySpace).length
          const nextActive = filterRecord(state.activeKeyBySpace)
          const nextDisplay = filterRecord(state.displayKeyBySpace)
          const nextOrder = filterRecord(state.tabOrderBySpace)
          const nextItems = filterRecord(state.itemsBySpace)
          const purgedCount = prevKeyCount - Object.keys(nextOrder).length
          if (purgedCount > 0) {
            log.info('purged stale space entries', { count: purgedCount })
          }
          if (purgedCount === 0) return state
          return {
            activeKeyBySpace: nextActive,
            displayKeyBySpace: nextDisplay,
            tabOrderBySpace: nextOrder,
            itemsBySpace: nextItems
          }
        })
      }
    }),
    withPersistSafety({
      name: PERSIST_KEYS.contextTabs,
      storage: createJSONStorage(() => createMigratingStorage(localStorage, ['agent-space-context-tabs'])),
      partialize: (state) => {
        const normalized = normalizePersistedState({
          activeKeyBySpace: state.activeKeyBySpace,
          displayKeyBySpace: state.displayKeyBySpace,
          tabOrderBySpace: state.tabOrderBySpace,
          itemsBySpace: state.itemsBySpace,
          lastActiveSubagentByParentSession: state.lastActiveSubagentByParentSession,
        })
        // PRD §4.16 / 红线 #9：subagent_session.meta.task 是用户 prompt（敏感），
        // 不进 localStorage——重启后 Pane / Tab title 从 SubagentRun / IPC 重新拉。
        // 只保留 parentSessionId / parentToolCallId / label / speakerId（restore 必需）。
        const sanitizedItems: typeof normalized.itemsBySpace = {}
        for (const [spaceId, spaceItems] of Object.entries(normalized.itemsBySpace)) {
          const next: typeof spaceItems = {}
          for (const [tabKey, item] of Object.entries(spaceItems)) {
            let sanitizedMeta = item.meta
            if (item.type === 'tabdata' && sanitizedMeta) {
              const {
                recordFocusRecordId: _droppedRecordFocusRecordId,
                recordFocusRequestId: _droppedRecordFocusRequestId,
                notificationIntentKey: _droppedNotificationIntentKey,
                openComments: _droppedOpenComments,
                recordId: _droppedRecordId,
                commentId: _droppedCommentId,
                ...rest
              } = sanitizedMeta as Record<string, unknown>
              sanitizedMeta = Object.keys(rest).length > 0 ? (rest as typeof item.meta) : undefined
            }
            if (item.type === 'subagent_session' && sanitizedMeta && 'task' in sanitizedMeta) {
              const { task: _droppedTask, ...rest } = sanitizedMeta as Record<string, unknown>
              sanitizedMeta = Object.keys(rest).length > 0 ? (rest as typeof item.meta) : undefined
            }
            next[tabKey] = sanitizedMeta === item.meta ? item : { ...item, meta: sanitizedMeta }
          }
          sanitizedItems[spaceId] = next
        }
        const sanitized = { ...normalized, itemsBySpace: sanitizedItems }
        traceTabRestore('contextTabs:partialize', summarizeContextTabsPersistState(sanitized))
        return sanitized
      },
      version: 1,
      migrate: (persistedState, version) =>
        migrateContextTabsState<SpaceContextTabsPersistState>(persistedState, version),
      merge: (persisted: unknown, currentState: SpaceContextTabsState): SpaceContextTabsState => {
        const persistedState = (persisted || {}) as Partial<SpaceContextTabsState>
        traceTabRestore('contextTabs:merge:start', summarizeContextTabsPersistState(persistedState))

        if (shouldDebugTabSwitch()) {
          log.debug('merge started', {
            spaceIds: Object.keys(persistedState.tabOrderBySpace || {}),
          })
        }

        const normalized = normalizePersistedState(persistedState)
        traceTabRestore('contextTabs:merge:normalized', summarizeContextTabsPersistState(normalized))

        if (shouldDebugTabSwitch()) {
          log.debug('merge completed', {
            spaceIds: Object.keys(normalized.tabOrderBySpace),
          })
        }

        return {
          ...currentState,
          ...normalized,
        }
      }
    })
  )
)

registerResetAction('context-tabs', 'reset', () => {
  clearAllNavigationIntents()
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
    explicitCloseRevisionByScope: {},
    explicitClosedTabKeysByScope: {},
    lastActiveSubagentByParentSession: {},
  })
})

// 注：原 `selectHiddenSubagentTabCount` selector 已于 2026-05-29 移除——它只服务
// ChatSessionBar 顶部那条「N 个子 Agent 标签属于其他对话」提示条。该提示与「每个
// session 只看自己的子 Agent」的设计自相矛盾（把别的对话的状态拎到当前视图当噪音），
// 已连同提示条一并删除。subagent_session tab 的 session 过滤本身（isVisibleInContext）
// 保留不变——切换对话时各看各的，不需要再额外提示。
