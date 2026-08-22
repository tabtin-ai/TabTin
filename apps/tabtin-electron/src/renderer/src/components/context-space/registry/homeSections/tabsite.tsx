import React, { useCallback, useMemo } from 'react'
import { Globe2, Plus, ExternalLink } from 'lucide-react'
import { Button, ScrollArea } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceAppEnabled } from '@stores/useSpaceApps'
import { useResourcesByType } from '@/hooks/useResourcesByType'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import type { HomeSectionHandler, HomeSectionProps } from '../types'
import { HomeGridCard, getTypeGradient } from './HomeGridCard'
import { MIN_CARD_WIDTH_WIDE, resourceGridTemplateColumns } from '../../constants'
import { buildCoverContent } from './StructuredPreviews'
import { GridCardMetaRow, ResourceGridSpaceBadge } from './gridCardMeta'
import { ResourceCollectionSkeleton } from '@components/common/ListSkeletons'
import { metaStr } from './metaFieldUtils'
import { isCrossSpaceScopedItem } from '@components/context-space/resourceScope'
import { cn } from '@utils/cn'
import { CANVAS_TAB_TEXT, CANVAS_TEXT_META, CANVAS_TEXT_META_BASE, CANVAS_TEXT_MICRO, CANVAS_TEXT_SECONDARY } from '@components/layout/canvasUi'
import { SIDEBAR_LIST_PANEL } from '@components/layout/sidebarUi'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'

const TabSiteSection: React.FC<HomeSectionProps> = ({
  spaceId,
  onCreateResource,
  onSearchNavigate,
  viewMode = 'list',
}) => {
  const { t } = useTranslation('context')
  const isEnabled = useSpaceAppEnabled(spaceId, 'tabsite')
  const { items, isLoading, scope } = useResourcesByType(spaceId, 'tabsite')

  const displayItems = useMemo(
    () =>
      items.map((item) => ({
        rawItem: item,
        id: item.resource_id || item.id,
        title: item.title || t('label.untitledSite'),
        updated_at: item.updated_at,
        preview: item.preview || '',
        status: metaStr(item.metadata, 'status') || 'draft',
        metadata: item.metadata || {},
        space_id: item.space_id,
        space_name: item.space_name,
      })),
    [items, t],
  )

  const handleCreate = useCallback(() => {
    onCreateResource?.('tabsite')
  }, [onCreateResource])

  const handleOpen = useCallback(
    (item: (typeof displayItems)[number]) => {
      if (onSearchNavigate) {
        void onSearchNavigate(item.rawItem)
        return
      }

      const targetSpaceId = item.space_id || spaceId
      useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(targetSpaceId), {
        type: 'tabsite',
        id: item.id,
        title: item.title,
        meta: { spaceId: targetSpaceId },
      })
    },
    [onSearchNavigate, spaceId],
  )

  if (!isEnabled) {
    return (
      <div className="px-2.5 py-4 text-center text-body text-muted-foreground">
        {t('home.assetBrowser.sitesUnavailable')}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-1">
      <div className="flex items-center justify-end px-2">
        <Button variant="ghost" size="sm" onClick={handleCreate}>
          <Plus className="h-3 w-3" />
          {t('home.assetBrowser.newSite')}
        </Button>
      </div>
      {isLoading && displayItems.length === 0 ? (
        <ResourceCollectionSkeleton
          mode={viewMode}
          count={viewMode === 'grid' ? 6 : 5}
          minCardWidth={MIN_CARD_WIDTH_WIDE}
        />
      ) : displayItems.length === 0 ? (
        <div className="px-2.5 py-4 text-center text-body text-muted-foreground">
          {t('home.assetBrowser.sitesEmpty')}
        </div>
      ) : viewMode === 'list' ? (
        <ScrollArea className={cn(SIDEBAR_LIST_PANEL, 'h-full w-full [&>[data-radix-scroll-area-viewport]>div]:!block')}>
          <div className="flex min-h-full min-w-0 w-full flex-col gap-0.5">
            {displayItems.map((item) => {
              const publishedUrl = metaStr(item.metadata, 'published_url')
              const isFromOtherSpace = isCrossSpaceScopedItem(scope, spaceId, item.space_id)
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleOpen(item)}
                  className="flex h-auto w-full min-w-0 items-center justify-start gap-2.5 rounded-interactive px-2.5 py-1.5 text-left font-normal whitespace-normal"
                >
                  <Globe2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body">{item.title}</div>
                    <div className="flex items-center gap-1.5 text-body text-muted-foreground">
                      <span
                        className={`rounded-full px-1.5 py-0.5 CANVAS_TEXT_META font-medium ${
                          item.status === 'archived'
                            ? 'bg-destructive/10 text-destructive'
                            : item.status === 'published'
                              ? 'bg-foreground/[0.04] text-primary-text'
                              : 'bg-foreground/[0.04] text-muted-foreground'
                        }`}
                      >
                        {item.status === 'archived'
                          ? t('home.assetBrowser.archived', { defaultValue: '已归档' })
                          : item.status === 'published'
                            ? t('home.assetBrowser.published', { defaultValue: '已发布' })
                            : t('home.assetBrowser.draft', { defaultValue: '草稿' })}
                      </span>
                      {publishedUrl && (
                        <span className="flex items-center gap-0.5 truncate">
                          <ExternalLink className="h-2.5 w-2.5" />
                          <span className="truncate">{publishedUrl.replace(/^https?:\/\//, '')}</span>
                        </span>
                      )}
                      {isFromOtherSpace && (
                        <span className={cn('shrink-0', 'inline-flex', 'items-center', 'gap-0.5', 'rounded-full', 'bg-muted/60', 'px-1.5', 'py-0.5', 'font-normal', CANVAS_TEXT_META)}>
                          ↗ {item.space_name || ''}
                        </span>
                      )}
                    </div>
                  </div>
                  {item.updated_at && (
                    <span className={cn('shrink-0', CANVAS_TEXT_META)}>
                      {formatRelativeTime(item.updated_at, t)}
                    </span>
                  )}
                </Button>
              )
            })}
          </div>
        </ScrollArea>
      ) : (
        <div className="grid gap-3" style={{ gridTemplateColumns: resourceGridTemplateColumns() }}>
          {displayItems.map((item) => {
            const isFromOtherSpace = isCrossSpaceScopedItem(scope, spaceId, item.space_id)
            const cover = buildCoverContent('tabsite', item.metadata, item.preview)
            const statusLabel = item.status === 'archived'
              ? t('home.assetBrowser.archived', { defaultValue: '已归档' })
              : item.status === 'published'
                ? t('home.assetBrowser.published', { defaultValue: '已发布' })
                : t('home.assetBrowser.draft', { defaultValue: '草稿' })
            const statusClassName = item.status === 'archived'
              ? 'bg-destructive/10 text-destructive'
              : item.status === 'published'
                ? 'bg-foreground/[0.04] text-primary-text'
                : 'bg-foreground/[0.04] text-muted-foreground'
            return (
              <HomeGridCard
                key={item.id}
                gradient={getTypeGradient('tabsite')}
                coverContent={cover}
                previewText={!cover ? (item.preview || null) : null}
                icon={item.status === 'archived' ? '📦' : item.status === 'published' ? '🌐' : '🔧'}
                typeLabel={!cover && !item.preview ? 'TabSite' : null}
                title={item.title}
                subtitle={
                  <GridCardMetaRow
                    prefix={
                      <span className={`rounded px-1 py-0.5 CANVAS_TEXT_META font-medium ${statusClassName}`}>
                        {statusLabel}
                      </span>
                    }
                    time={item.updated_at ? formatRelativeTime(item.updated_at, t) : undefined}
                    trailing={isFromOtherSpace ? (
                      <ResourceGridSpaceBadge spaceName={item.space_name || ''} />
                    ) : undefined}
                  />
                }
                onClick={() => handleOpen(item)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

export const tabsiteHomeSection: HomeSectionHandler = {
  appId: 'tabsite',
  labelKey: 'home.assetBrowser.sites',
  Component: TabSiteSection,
  renderInsideContextHome: true,
}
