/**
 * TabData App 的 Home Section —— 渲染用户表列表（过滤非用户可见表）
 * 支持列表/宫格两种视图模式。
 */
import React, { useCallback, useMemo } from 'react'
import { Loader2, Plus, Table2 } from 'lucide-react'
import { Button, ScrollArea } from '@components/ui'
import { useSpaceContextState } from '../../SpaceContextAreaContext'
import { useTranslation } from 'react-i18next'
import { useSpaceAppEnabled } from '@stores/useSpaceApps'
import { MIN_CARD_WIDTH_WIDE, resourceGridTemplateColumns } from '../../constants'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import type { HomeSectionHandler, HomeSectionProps } from '../types'
import { type Table, getTableSpaceId } from '@tabtin/table-core'
import { HomeGridCard, getTypeGradient } from './HomeGridCard'
import { GridCardMetaRow, ResourceGridSpaceBadge } from './gridCardMeta'
import { ResourceCollectionSkeleton } from '@components/common/ListSkeletons'
import { ResourceListItem } from './ResourceListItem'
import type { SpaceContextItem } from '@/services/spaceApi'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useSpaceTables } from '@components/context-space/hooks/useSpaceTables'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { contextRegistry } from '../instance'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { openTableTabGuarded } from '../../restore/openResourceMembershipGuard'
import {
  buildSpaceItemChatContextDragPayload,
  writeChatContextDragPayload,
} from '../../hooks/chatContextDragPayload'
import { setResourceDragPreview } from '../../hooks/resourceDragPreview'
import {
  getEffectiveScopeForResourceType,
  isCrossSpaceScopedItem,
  isUserVisibleTabdataTable,
} from '@components/context-space/resourceScope'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import { SIDEBAR_LIST_PANEL } from '@components/layout/sidebarUi'

export const tableToContextItem = (table: Table): SpaceContextItem => ({
  id: `tabdata-${table.id}`,
  item_type: 'tabdata',
  title: table.name || '',
  preview: '',
  status: table.is_archived ? 'archived' : 'active',
  resource_id: table.id,
  space_id: table.space_id || '',
  space_name: table.space_name || '',
  metadata: {
    icon: table.icon,
    record_count: table.row_count,
    field_count: table.field_count,
    visibility: table.visibility,
  },
  is_archived: table.is_archived ?? false,
  updated_at: table.updated_at ?? null,
  created_at: table.created_at ?? null,
})

const TabDataSection: React.FC<HomeSectionProps> = ({
  spaceId,
  tabScopeKey,
  onCreateResource,
  onSearchNavigate,
  viewMode = 'list',
}) => {
  const { t } = useTranslation('context')
  const isTableEnabled = useSpaceAppEnabled(spaceId, 'tabdata')
  const { creatingAppIds } = useSpaceContextState()
  const isCreating = creatingAppIds.has('tabdata')
  const requestedScope = useSpaceViewPrefsStore(s => s.getPrefs(spaceId).resourceScope)
  const resourceScope = getEffectiveScopeForResourceType(requestedScope, 'tabdata')
  const {
    visibleTables,
    isLoading,
    error,
    resolvedOrganizationId,
  } = useSpaceTables(spaceId, undefined, resourceScope)

  const userTables = useMemo(
    () => (visibleTables ?? []).filter(isUserVisibleTabdataTable),
    [visibleTables],
  )
  const effectiveTabScopeKey = tabScopeKey ?? resolveForegroundTabScopeKey(spaceId)

  const handleTableOpen = async (table: Table) => {
    if (onSearchNavigate) {
      await onSearchNavigate(tableToContextItem(table))
      return
    }
    // 跨 Space 不切换全局 Space，在当前 scope 以 foreignShared 外部资源 tab 打开
    // （与 useResourceInit.handleSearchNavigate 同一范式）。
    const targetSpaceId = getTableSpaceId(table) ?? spaceId
    const tabs = useSpaceContextTabsStore.getState()
    if (targetSpaceId !== spaceId) {
      tabs.openResourceTab(effectiveTabScopeKey, {
        type: 'tabdata',
        id: table.id,
        title: table.name || '',
        meta: { spaceId: targetSpaceId, organizationId: resolvedOrganizationId ?? undefined, foreignShared: true },
      })
      return
    }
    openTableTabGuarded(effectiveTabScopeKey, table.id, {
      refreshSpaceId: spaceId,
    })
  }

  const handleTableDragStart = useCallback((event: React.DragEvent, table: Table) => {
    writeChatContextDragPayload(
      event.dataTransfer,
      buildSpaceItemChatContextDragPayload(tableToContextItem(table), contextRegistry),
    )
    setResourceDragPreview(event.dataTransfer, {
      label: table.name || t('home.untitled', { defaultValue: '未命名' }),
      icon: table.icon || contextRegistry.getDisplayEmoji('tabdata'),
    })
    event.dataTransfer.effectAllowed = 'copy'
  }, [t])

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-2">
      <div className="flex items-center justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onCreateResource('tabdata')}
          disabled={!isTableEnabled || isCreating}
          aria-busy={isCreating || undefined}
        >
          {isCreating
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <Plus className="h-3 w-3" />}
          {t('home.assetBrowser.newTable')}
        </Button>
      </div>

      {isLoading && userTables.length === 0 ? (
        <ResourceCollectionSkeleton
          mode={viewMode}
          count={viewMode === 'grid' ? 6 : 5}
          minCardWidth={MIN_CARD_WIDTH_WIDE}
        />
      ) : null}

      {error ? <div className="text-body text-destructive">{error}</div> : null}

      {!isLoading && userTables.length === 0 && !error ? (
        <div className="rounded-[12px] border border-dashed border-border/60 px-4 py-6 text-center text-body text-muted-foreground">
          {t('home.assetBrowser.tablesEmpty')}
        </div>
      ) : null}

      {userTables.length > 0 ? (
        viewMode === 'list' ? (
          <ScrollArea className={cn(SIDEBAR_LIST_PANEL, 'h-full w-full [&>[data-radix-scroll-area-viewport]>div]:!block')}>
            <div className="flex min-h-full min-w-0 w-full flex-col gap-0.5">
              {userTables.map(table => (
                <div
                  key={table.id}
                  draggable
                  onDragStart={event => handleTableDragStart(event, table)}
                >
                  <ResourceListItem
                    item={tableToContextItem(table)}
                    snippet={`${table.row_count ?? 0} ${t('home.assetBrowser.rowUnit', { defaultValue: '行' })} · ${table.field_count ?? 0} ${t('home.assetBrowser.fieldUnit', { defaultValue: '字段' })}`}
                    trailingBadge={isCrossSpaceScopedItem(resourceScope, spaceId, getTableSpaceId(table)) ? (
                      <span className={cn('shrink-0', 'inline-flex', 'items-center', 'gap-0.5', 'rounded-full', 'bg-muted/60', 'px-1.5', 'py-0.5', 'font-normal', CANVAS_TEXT_META)}>
                        ↗ {table.space_name || ''}
                      </span>
                    ) : undefined}
                    onClick={() => handleTableOpen(table)}
                  />
                </div>
              ))}
            </div>
          </ScrollArea>
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: resourceGridTemplateColumns() }}>
            {userTables.map(table => {
              const preview = table.description || `${table.row_count ?? 0} 行 · ${table.field_count ?? 0} 字段`
              const isFromOtherSpace = isCrossSpaceScopedItem(resourceScope, spaceId, getTableSpaceId(table))
              return (
                <div
                  key={table.id}
                  draggable
                  onDragStart={event => handleTableDragStart(event, table)}
                >
                  <HomeGridCard
                    gradient={getTypeGradient('tabdata')}
                    previewText={preview}
                    icon={table.icon || <Table2 className="h-8 w-8 text-info/35" />}
                    title={table.name}
                    subtitle={
                      <GridCardMetaRow
                        typeLabel={t('home.assetBrowser.rowCount', { count: table.row_count ?? 0, defaultValue: '{{count}} 行' })}
                        time={formatRelativeTime(table.updated_at, t)}
                        trailing={isFromOtherSpace ? (
                          <ResourceGridSpaceBadge spaceName={table.space_name || ''} />
                        ) : undefined}
                      />
                    }
                    onClick={() => handleTableOpen(table)}
                  />
                </div>
              )
            })}
          </div>
        )
      ) : null}
    </div>
  )
}

export const tabdataHomeSection: HomeSectionHandler = {
  appId: 'tabdata',
  labelKey: 'home.assetBrowser.tables',
  Component: TabDataSection,
  renderInsideContextHome: true,
}
