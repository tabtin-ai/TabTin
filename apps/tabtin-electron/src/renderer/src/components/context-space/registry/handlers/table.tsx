import React from 'react'
import { Table, Table2 } from 'lucide-react'
import type { ContextTypeHandler } from '../types'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { openTableTabGuarded } from '../../restore/openResourceMembershipGuard'
import { tableStore } from '@stores/useTableStore'
import { viewStore } from '@stores/useViewStore'
import {
  getOrCreateRecordStore,
  peekViewStoreForTable,
} from '@components/table/tableStorePool'
import i18n from '@/i18n'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { metaStr } from '../homeSections/metaFieldUtils'

/**
 * 解析 tabdata tab 的当前 viewId — 优先级链：
 *   1. 池化 ViewStore（pool 里若已有该 tableId 实例则取其 currentViewId）
 *   2. 全局默认 ViewStore（仅当它正绑定在该表时取）
 *   3. tab item.meta.viewId（持久化记忆，冷启动场景的最后兜底）
 *
 * 说明：UI 实际渲染表格时用的是按 tableId 池化的 ViewStore（见 tableStorePool）。
 * 但 ChatPanel / appMeta.resolve 这种「跨表全局」场景如果直接读默认单例，常常拿到
 * 别表的 viewId 或在 chat 面板不挂载表 Pane 时拿不到。这里按池化 → 默认单例 → 持久化
 * 的顺序回退，保证三种场景都对：
 *   - 表 Pane 当前正激活：池化和默认单例都对
 *   - 表 Pane 已 unmount 但池里还在（LRU 未驱逐）：池化对
 *   - 池子也淘汰了 / 应用刚冷启动：从 meta.viewId 拿（写回逻辑见 TablePaneView）
 */
const resolveCurrentViewId = (tableId: string, metaViewId: unknown): string | null => {
  const pooled = peekViewStoreForTable(tableId)
  if (pooled) {
    const state = pooled.getState()
    if (state.tableId === tableId && state.currentViewId) {
      return state.currentViewId
    }
  }
  const defaultState = viewStore.getState()
  if (defaultState.tableId === tableId && defaultState.currentViewId) {
    return defaultState.currentViewId
  }
  if (typeof metaViewId === 'string' && metaViewId) {
    return metaViewId
  }
  return null
}

const loadTablePaneRenderer = () =>
  import('./renderers/TablePaneRenderer').then(m => ({ default: m.TablePaneRenderer }))
const TablePaneRenderer = React.lazy(loadTablePaneRenderer)

type CreateTableHandlerOptions = {
  appId?: string
}

export const createTableHandler = (options: CreateTableHandlerOptions = {}): ContextTypeHandler => ({
  type: 'tabdata',
  appId: options.appId ?? 'tabdata',
  prefetch: loadTablePaneRenderer,
  renderMode: 'persistent',
  appEntryMode: 'resources',
  aggregateAppId: 'cloud-resources',
  displayLabel: 'Tables',
  displayEmoji: '📊',
  agent: {
    displayName: '多维表',
    capability: '结构化业务数据与多视图管理（grid / kanban / calendar / gallery），适合 CRM、任务看板、清单、内容库。',
    aliases: ['表格', 'table', '数据表'],
  },
  backendAliases: ['table'],
  requireResourceMembership: true,
  searchable: true,
  searchLabelKey: 'organization:search.tables',
  quickAction: {
    icon: <Table className="h-3.5 w-3.5" />,
    labelKey: 'context:home.quickActions.newTable',
    shortLabelKey: 'context:home.quickActions.shortTable',
  },
  appMeta: {
    idField: 'current_table_id',
    /**
     * tabdata 自定义 resolve：在 current_table_id 之上补 current_view_id。
     *
     * 历史背景：早期实现只读「全局默认 ViewStore」，导致两个 bug：
     *   1. 表 UI 实际用的是按 tableId 池化的 ViewStore（tableStorePool），
     *      默认单例可能没绑定在 item.id 上 → 注入失败。
     *   2. 没有「上次激活视图」的持久化层，关 tab 重开必回默认视图。
     *
     * 修复：resolveCurrentViewId 按 池化 store → 默认单例 → meta.viewId 三级回退。
     * meta.viewId 由 TablePaneView 在用户切视图时 debounce 写回。
     */
    resolve: (item) => {
      const meta: Record<string, unknown> = {
        current_table_id: item.id,
      }
      const viewId = resolveCurrentViewId(item.id, item.meta?.viewId)
      if (viewId) {
        meta.current_view_id = viewId
      }
      return meta
    },
    metaDeps: { useViewStoreId: true, tabMetaKeys: ['viewId'] },
  },
  mention: { icon: Table2, color: 'text-accent bg-accent/10', mentionType: 'table' },
  attachToChat: {
    refType: 'table',
    buildRef: (item) => {
      if (!item.id) return null
      const viewId = resolveCurrentViewId(item.id, item.meta?.viewId)
      return {
        resourceId: item.id,
        label: item.title || i18n.t('label.untitledTable', { ns: 'context' }),
        meta: viewId ? { view_id: viewId } : undefined,
      }
    },
  },
  onSelect: (item, ctx) => {
    // ：与 tabdoc 对称——打开已有表时打 pending，防 restore 误判 missing
    openTableTabGuarded(
      ctx.tabScopeKey ?? resolveForegroundTabScopeKey(ctx.spaceId),
      item.id,
      { meta: item.meta, refreshSpaceId: ctx.spaceId },
    )
  },
  /**
   * 关闭 table tab：仅推入 closedTabsStore 供 ⌘⇧T 还原。
   * 契约：不得修改 tabOrder / activeKey — useCloseHandlers 统一兜底 closeTab。
   */
  onClose: (item, ctx) => {
    useClosedTabsStore.getState().push({
      type: 'tabdata',
      id: item.id,
      tabKey: item.tabKey,
      title: item.title || i18n.t('label.untitledTable', { ns: 'context' }),
      spaceId: ctx.spaceId,
    })
  },
  onRefresh: (item) => {
    const ts = tableStore.getState()
    const rs = getOrCreateRecordStore(item.id).getState()
    void ts.getTable(item.id)
    void ts.loadTableStats(item.id)
    void rs.loadRecordsByTable(item.id)
  },
  resolveTabItem: (id, ctx) => {
    const allTables = tableStore.getState().tables ?? []
    const table = allTables.find((t) => t.id === id)
    return {
      type: 'tabdata',
      id,
      tabKey: ctx.tabKey,
      title: table?.name || ctx.persistedItem?.title || i18n.t('label.untitledTable', { ns: 'context' }),
      meta: ctx.persistedItem?.meta,
    }
  },
  getTabLabel: item => item.title || i18n.t('label.untitledTable', { ns: 'context' }),
  getTabIcon: () => <TabTypeEmoji appIdOrType="tabdata" />,
  getDragPayload: item => ({
    type: 'tabdata',
    id: item.id,
    title: item.title,
    viewId: (item as Record<string, unknown>).viewId ?? null,
  }),
  buildCanvasContent: (item) => ({ tabKey: item.tabKey }),
  buildCanvasContentFromDrag: (tabKey) => ({ tabKey }),
  renderPane: (item, ctx) => {
    const resourceSpaceId = metaStr(item.meta, 'spaceId') ?? ctx?.spaceId ?? null
    const organizationId = metaStr(item.meta, 'organizationId')
    return (
      <React.Suspense
        fallback={
          <div className="flex h-full items-center justify-center text-body text-muted-foreground">
            {i18n.t('label.loading', { ns: 'context' })}
          </div>
        }
      >
        <TablePaneRenderer
          tableId={item.id}
          title={item.title}
          spaceId={resourceSpaceId}
          organizationId={organizationId}
          isPaneActive={ctx?.isPaneActive ?? false}
          isVisible={ctx?.isVisible ?? true}
          onPaneInteraction={ctx?.onPaneInteraction}
        />
      </React.Suspense>
    )
  },
})

export const tableHandler = createTableHandler()
