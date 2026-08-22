import type { ContextItemRecord } from '@stores/useSpaceContextTabsStore'
import { useChatStore } from '@stores/chat/useChatStore'
import type { SubagentSessionMeta } from '@stores/contextTabs/types'
import type { WorkbenchRestoreInput, RestoreTabStatus } from './types'
import { isResourceMembershipPending } from './resourceMembershipPending'

const parseTabKey = (tabKey: string): { type: string; id: string } | null => {
  const index = tabKey.indexOf(':')
  if (index <= 0 || index >= tabKey.length - 1) return null
  return { type: tabKey.slice(0, index), id: tabKey.slice(index + 1) }
}

const makeStatus = (
  tabKey: string,
  kind: RestoreTabStatus['kind'],
  reason: string,
): RestoreTabStatus => {
  const parsed = parseTabKey(tabKey)
  return {
    tabKey,
    kind,
    reason,
    type: parsed?.type,
    id: parsed?.id,
  }
}

export const isKeepStatus = (status: RestoreTabStatus): boolean =>
  status.kind !== 'stale'

export const isUsableActiveStatus = (status: RestoreTabStatus | undefined): boolean =>
  Boolean(status && status.kind !== 'stale')

/**
 * 只有子 Agent 标签的恢复判定依赖 Agent 会话索引。普通资源标签不应被
 * sessionsHydrated 卡住；TabChat 页面本身不会为了表格/文档去加载这份索引。
 */
export function requiresChatSessionIndex(
  items: Iterable<Pick<ContextItemRecord, 'type'>>,
): boolean {
  for (const item of items) {
    if (item.type === 'subagent_session') return true
  }
  return false
}

export const buildMinimalItem = (
  tabKey: string,
  seedTitle?: string,
  seedUrl?: string,
): ContextItemRecord | null => {
  const parsed = parseTabKey(tabKey)
  if (!parsed) return null
  const meta = seedUrl ? { url: seedUrl } : undefined
  return {
    tabKey,
    type: parsed.type,
    id: parsed.id,
    ...(seedTitle ? { title: seedTitle } : {}),
    ...(meta ? { meta } : {}),
  }
}

/**
 * 校验「资源类 tab」的 id 是否仍存在于 Space 的 UnifiedResources 列表里。
 *
 * 返回值：
 * - 'valid'：资源在
 * - 'missing'：资源列表已加载但找不到该 id（资源被删 / 转移 / 归档）
 * - 'pending'：资源列表还没加载完，无法判定（保守：维持 unknown）
 */
const checkResourceMembership = (
  input: WorkbenchRestoreInput,
  type: string,
  id: string,
): 'valid' | 'missing' | 'pending' => {
  if (!input.apps.requireResourceMembership(type)) return 'valid'
  if (!input.resourceMembership.loaded) return 'pending'
  const set = input.resourceMembership.byType[type]
  if (set && set.has(id)) return 'valid'
  return 'missing'
}

export function classifyRestoreTab(
  input: WorkbenchRestoreInput,
  tabKey: string,
): RestoreTabStatus {
  const parsed = parseTabKey(tabKey)
  if (!parsed) return makeStatus(tabKey, 'stale', 'invalid_tab_key')

  const { type, id } = parsed
  const persistedItem = input.itemsByTabKey[tabKey]
  const browserItem = input.browser.items.find(item => item.tabKey === tabKey)
  const tableItem = input.table.items.find(item => item.tabKey === tabKey)
  const terminalItem = input.terminal.items.find(item => item.tabKey === tabKey)
  const isEmbeddedBrowserItem = Boolean(persistedItem?.meta?.embeddedAppId)
  const appId = input.apps.getAppId(type) ?? (isEmbeddedBrowserItem ? String(persistedItem?.meta?.embeddedAppId ?? '') : undefined)

  if (!input.apps.ready && appId) {
    return makeStatus(tabKey, 'unknown', 'apps_not_ready')
  }
  if (input.apps.ready && appId && !input.apps.isAppEnabled(appId)) {
    return makeStatus(tabKey, 'suspended', 'app_disabled')
  }

  if (type === 'tabweb' || isEmbeddedBrowserItem) {
    const viewId = id
    if (input.browser.recentlyClosedViewIds.has(viewId)) {
      return makeStatus(tabKey, 'stale', 'recently_closed_view')
    }
    const hasLiveView = input.browser.viewList.some(view => view.viewId === viewId && !view.isClosing)
    if (browserItem || hasLiveView) {
      return makeStatus(tabKey, 'valid', browserItem ? 'browser_item_live' : 'browser_view_live')
    }
    const seed = input.browser.persistedSeeds.find(item => item.viewId === viewId)
    if (seed || persistedItem?.meta?.discarded) {
      return makeStatus(tabKey, 'recoverable', seed ? 'browser_seed' : 'browser_discarded_item')
    }
    if (!input.readiness.crawlTabsHydrated || input.browser.coldStartPending) {
      return makeStatus(tabKey, 'unknown', 'browser_not_ready')
    }
    return makeStatus(tabKey, 'stale', 'browser_no_live_seed_or_cache')
  }

  if (type === 'tabdata') {
    // 「分享给我」独立 tab：表格属于他人私有 Space，不在当前 Space 资源索引里，
    // 不能按成员校验当作 missing 清除。实际读写权限仍由 TablePermission / 后端鉴权控制。
    if (persistedItem?.meta?.foreignShared) {
      return makeStatus(tabKey, 'valid', 'foreign_shared_resource')
    }
    if (input.table.isLoading || input.table.hasError) {
      return makeStatus(tabKey, 'unknown', input.table.isLoading ? 'table_source_loading' : 'table_source_error')
    }
    // 资源存在性校验：tabdata 的 id 即 tableId（后端资源 id），UnifiedResources 加载完后
    // 找不到 → 资源已被删 → 标 stale。
    // 注意：input.table.items 是从 tabOrder 推导出的「占位条」，光看 tableItem 不够判定。
    const membership = checkResourceMembership(input, type, id)
    if (membership === 'missing') {
      if (isResourceMembershipPending(persistedItem?.meta, input.nowMs ?? Date.now())) {
        return makeStatus(tabKey, 'unknown', 'table_resource_membership_pending')
      }
      return makeStatus(tabKey, 'stale', 'table_resource_missing')
    }
    if (membership === 'pending') {
      return makeStatus(tabKey, 'unknown', 'table_resource_loading')
    }
    if (tableItem || persistedItem) {
      return makeStatus(tabKey, 'valid', tableItem ? 'table_item_live' : 'table_persisted_item')
    }
    return makeStatus(tabKey, 'unknown', 'table_not_in_current_source')
  }

  // PRD §4.13 / 红线 #2：subagent_session 在 policies 集中决策（不写在 handler 的
  // validateRestore——现有架构没有调用那个钩子）。
  // 三种结果：
  //   - meta.parentSessionId 缺失 → stale（清理 orphan / 老格式）
  //   - chat sessions 还没 hydrate → unknown（保守等待，避免冷启动期误清）
  //   - parentSession 不存在 → stale（父 session 被删，子 Agent tab 清理）
  //   - parentSession 存在 → valid
  if (type === 'subagent_session') {
    const meta = persistedItem?.meta as SubagentSessionMeta | undefined
    if (!meta?.parentSessionId) {
      return makeStatus(tabKey, 'stale', 'subagent_meta_missing')
    }
    const chatState = useChatStore.getState()
    if (!chatState.sessionsHydrated) {
      // 红线 #11：水合未完成不要返回 stale（会被自动清理）
      // useWorkbenchRestoreCoordinator 会在存在 subagent_session 时把 sessionsHydrated
      // 加入 readyToRestore。这里仍保留 unknown 兜底，
      // 防御未来有人改了 readyToRestore 条件忘记同步本判定。
      return makeStatus(tabKey, 'unknown', 'sessions_not_hydrated')
    }
    const session = chatState.getSessionById(meta.parentSessionId)
    if (!session) {
      return makeStatus(tabKey, 'stale', 'parent_session_deleted')
    }
    return makeStatus(tabKey, 'valid', 'subagent_session_valid')
  }

  if (type === 'terminal') {
    if (!input.terminal.hydrated) {
      return makeStatus(tabKey, 'unknown', 'terminal_sessions_not_hydrated')
    }
    if (input.terminal.splitSubPaneSessionIds.has(id)) {
      return makeStatus(tabKey, 'stale', 'terminal_split_subpane')
    }
    if (terminalItem || input.terminal.sessionIds.includes(id)) {
      return makeStatus(tabKey, 'valid', terminalItem ? 'terminal_item_live' : 'terminal_session_live')
    }
    return makeStatus(tabKey, 'stale', 'terminal_session_missing')
  }

  // 通用资源类 tab（tabdoc / tabslide / tabvideo 等带 requireResourceMembership 的 type）：
  // 在仍有 persisted item 的前提下做 Space 资源存在性校验，缺失则 stale 自清。
  // tabcode 等不依赖后端资源的 type 不在此校验范围（handler 没声明 requireResourceMembership）。
  if (persistedItem) {
    // 「分享给我」独立 tab：资源属于他人私有 Space，不在当前 Space 资源索引里，
    // 不能按成员校验当作 missing 清除——按 meta.foreignShared 放行。
    if (persistedItem.meta?.foreignShared) {
      return makeStatus(tabKey, 'valid', 'foreign_shared_resource')
    }
    const membership = checkResourceMembership(input, type, id)
    if (membership === 'missing') {
      if (isResourceMembershipPending(persistedItem.meta, input.nowMs ?? Date.now())) {
        return makeStatus(tabKey, 'unknown', 'resource_membership_pending')
      }
      return makeStatus(tabKey, 'stale', 'resource_missing')
    }
    if (membership === 'pending') {
      return makeStatus(tabKey, 'unknown', 'resource_loading')
    }
    return makeStatus(tabKey, 'valid', 'persisted_item')
  }

  return makeStatus(tabKey, 'unknown', 'unowned_non_browser_reference')
}
