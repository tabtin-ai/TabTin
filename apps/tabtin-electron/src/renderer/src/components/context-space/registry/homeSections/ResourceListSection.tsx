/**
 * 通用资源列表 Section —— 消费 useUnifiedResources 实现 WS 实时更新。
 *
 * tabslide 等 HomeSection 的共享实现。
 * 新资源通过 WS → useUnifiedResources → useResourcesByType 自动出现在列表中。
 * 支持列表/宫格两种视图模式，由 ContextHome 透传 viewMode prop 控制。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { LIST_ITEM_SNIPPET_MAX_CHARS, MIN_CARD_WIDTH_WIDE, resourceGridTemplateColumns } from '../../constants'
import { Loader2, Plus, Pin, PinOff, type LucideIcon } from 'lucide-react'
import { useSpaceContextState } from '../../SpaceContextAreaContext'
import { Button, ContextMenu, ContextMenuItem, ScrollArea, toast } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceAppEnabled } from '@stores/useSpaceApps'
import { useUnifiedResources } from '@/stores/useUnifiedResources'
import { openResourceTabGuarded } from '../../restore/openResourceMembershipGuard'
import { useResourcesByType } from '@/hooks/useResourcesByType'
import { SpaceApiService } from '@/services/spaceApi'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import type { HomeSectionHandler, HomeSectionProps } from '../types'
import { contextRegistry } from '../instance'
import { HomeGridCard, getTypeGradient } from './HomeGridCard'
import { GridCardMetaRow, ResourceGridSpaceBadge } from './gridCardMeta'
import { buildCoverContent } from './StructuredPreviews'
import { ResourceCollectionSkeleton } from '@components/common/ListSkeletons'
import { ResourceListItem } from './ResourceListItem'
import { metaStr, metaIcon } from './metaFieldUtils'
import { isCrossSpaceScopedItem } from '@components/context-space/resourceScope'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import { SIDEBAR_LIST_PANEL } from '@components/layout/sidebarUi'
import {
  buildSpaceItemChatContextDragPayload,
  writeChatContextDragPayload,
} from '../../hooks/chatContextDragPayload'
import { setResourceDragPreview } from '../../hooks/resourceDragPreview'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'

export interface ResourceListSectionConfig {
  appId: string
  icon: LucideIcon
  /** i18n key（context 命名空间）：新建按钮文案，不设置则不显示新建按钮 */
  createLabelKey?: string
  /** i18n key（context 命名空间）：空状态文案 */
  emptyLabelKey: string
  /** i18n key（context 命名空间）：App 未启用时文案 */
  unavailableLabelKey: string
  /** i18n key（context 命名空间）：无标题资源 fallback 文案 */
  untitledLabelKey: string
  /** Home Section tab 的 i18n key */
  tabLabelKey: string
  /** 宫格卡片渐变色 CSS class（bg-gradient-to-br 后缀） */
  gridGradient?: string
  /** 宫格卡片 emoji 图标 */
  gridEmoji?: string
}

export function createResourceListSection(config: ResourceListSectionConfig): HomeSectionHandler {
  const Section: React.FC<HomeSectionProps> = ({
    spaceId,
    tabScopeKey,
    onCreateResource,
    onSearchNavigate,
    viewMode = 'list',
  }) => {
    const { t } = useTranslation('context')
    const isEnabled = useSpaceAppEnabled(spaceId, config.appId)
    const { creatingAppIds } = useSpaceContextState()
    const isCreating = creatingAppIds.has(config.appId)
    const { items, isLoading, error, scope } = useResourcesByType(spaceId, config.appId)

    const displayItems = useMemo(
      () =>
        items.map((item) => ({
          ...item,
          title: item.title || t(config.untitledLabelKey),
        })),
      [items, t],
    )

    const handleClick = useCallback(
      (item: (typeof displayItems)[number]) => {
        if (onSearchNavigate) {
          void onSearchNavigate(item)
          return
        }

        const targetSpaceId = item.space_id || spaceId
        const tabKey = `${config.appId}:${item.resource_id}` as const
        const meta: Record<string, unknown> = {
          ...(item.metadata ?? {}),
          spaceId: targetSpaceId,
        }
        const dispatched = contextRegistry.dispatchSelect(
          { type: config.appId, id: item.resource_id, tabKey, title: item.title, meta },
          { spaceId: targetSpaceId, closeBrowserView: () => {} },
        )
        if (!dispatched) {
          openResourceTabGuarded(
            tabScopeKey ?? resolveForegroundTabScopeKey(spaceId),
            {
              type: config.appId,
              id: item.resource_id,
              title: item.title,
              meta,
            },
            targetSpaceId,
          )
        }
      },
      [onSearchNavigate, spaceId, tabScopeKey],
    )

    const handleResourceWsEvent = useUnifiedResources(s => s.handleWsEvent)
    const [pinMenu, setPinMenu] = useState<{
      open: boolean
      pos: { x: number; y: number }
      item: (typeof displayItems)[number] | null
    }>({ open: false, pos: { x: 0, y: 0 }, item: null })

    const handleContextMenu = useCallback((e: React.MouseEvent, item: (typeof displayItems)[number]) => {
      e.preventDefault()
      setPinMenu({ open: true, pos: { x: e.clientX, y: e.clientY }, item })
    }, [])

    const handleDragStart = useCallback((event: React.DragEvent, item: (typeof displayItems)[number]) => {
      writeChatContextDragPayload(
        event.dataTransfer,
        buildSpaceItemChatContextDragPayload(item, contextRegistry),
      )
      setResourceDragPreview(event.dataTransfer, {
        label: item.title || t(config.untitledLabelKey),
        icon: metaIcon(item.metadata) || config.gridEmoji || contextRegistry.getDisplayEmoji(item.item_type),
      })
      event.dataTransfer.effectAllowed = 'copy'
    }, [t])

    const handleTogglePin = useCallback(async () => {
      const item = pinMenu.item
      if (!item) return
      try {
        const updated = await SpaceApiService.pinContextItem(item.id, !item.is_pinned)
        handleResourceWsEvent({
          type: 'resource_updated',
          resource_type: updated.item_type,
          resource_id: updated.resource_id,
          title: updated.title,
          space_id: updated.space_id ?? item.space_id ?? '',
          organization_id: updated.organization_id ?? item.organization_id,
          metadata: updated.metadata,
          preview: updated.preview,
          is_pinned: updated.is_pinned,
          pinned_at: updated.pinned_at,
        })
      } catch (err) {
        console.error('[ResourceListSection] pin/unpin failed:', err)
        toast.error(t('errorToast.pinFailed'))
      }
    }, [handleResourceWsEvent, pinMenu.item, t])

    if (!isEnabled) {
      return (
        <div className="px-2.5 py-4 text-center text-body text-muted-foreground">
          {t(config.unavailableLabelKey)}
        </div>
      )
    }

    const Icon = config.icon
    const gradient = config.gridGradient ?? getTypeGradient(config.appId)
    const emoji = config.gridEmoji

    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col gap-2">
        {config.createLabelKey && (
          <div className="flex items-center justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1.5 px-2 text-body"
              disabled={isCreating}
              aria-busy={isCreating || undefined}
              onClick={() => onCreateResource(config.appId)}
            >
              {isCreating
                ? <Loader2 className="h-3 w-3 animate-spin" />
                : <Plus className="h-3 w-3" />}
              {t(config.createLabelKey)}
            </Button>
          </div>
        )}
        {error && displayItems.length === 0 ? (
          <div className="px-2.5 py-4 text-center text-body text-destructive">{error}</div>
        ) : isLoading && displayItems.length === 0 ? (
          <ResourceCollectionSkeleton
            mode={viewMode}
            count={viewMode === 'grid' ? 6 : 5}
            minCardWidth={MIN_CARD_WIDTH_WIDE}
          />
        ) : displayItems.length > 0 ? (
          viewMode === 'list' ? (
            <ScrollArea className={cn(SIDEBAR_LIST_PANEL, 'h-full w-full [&>[data-radix-scroll-area-viewport]>div]:!block')}>
              <div className="flex min-h-full min-w-0 w-full flex-col gap-0.5">
                {displayItems.map((item) => {
                  const isFromOtherSpace = isCrossSpaceScopedItem(scope, spaceId, item.space_id)
                  return (
                    <div
                      key={item.id}
                      draggable
                      onDragStart={event => handleDragStart(event, item)}
                    >
                      <ResourceListItem
                        item={item}
                        snippet={item.preview?.trim().slice(0, LIST_ITEM_SNIPPET_MAX_CHARS) || null}
                        showPinIcon
                        trailingBadge={isFromOtherSpace ? (
                          <span className={cn('shrink-0', 'inline-flex', 'items-center', 'gap-0.5', 'rounded-full', 'bg-muted/60', 'px-1.5', 'py-0.5', 'font-normal', CANVAS_TEXT_META)}>
                            ↗ {item.space_name || ''}
                          </span>
                        ) : undefined}
                        onClick={() => handleClick(item)}
                        onContextMenu={(e) => handleContextMenu(e, item)}
                      />
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: resourceGridTemplateColumns() }}>
              {displayItems.map((item) => {
                const isFromOtherSpace = isCrossSpaceScopedItem(scope, spaceId, item.space_id)
                const thumb =
                  metaStr(item.metadata, 'thumbnail') ||
                  metaStr(item.metadata, 'thumbnail_url') ||
                  metaStr(item.metadata, 'cover_image') ||
                  ''
                const rawPreview = item.preview?.trim() || null
                const cover = !thumb ? buildCoverContent(config.appId, item.metadata, rawPreview) : null
                const textPreview = !thumb && !cover ? (rawPreview || null) : null
                return (
                  <div
                    key={item.id}
                    draggable
                    onDragStart={event => handleDragStart(event, item)}
                  >
                    <HomeGridCard
                      gradient={gradient}
                      thumbnailUrl={thumb || null}
                      coverContent={cover}
                      previewText={textPreview}
                      icon={metaIcon(item.metadata) || emoji || <Icon className="h-7 w-7 text-muted-foreground/40" />}
                      typeLabel={!thumb && !cover && !textPreview ? t(config.tabLabelKey) : null}
                      title={item.title}
                      subtitle={
                        <GridCardMetaRow
                          time={formatRelativeTime(item.updated_at, t)}
                          trailing={isFromOtherSpace ? (
                            <ResourceGridSpaceBadge spaceName={item.space_name || ''} />
                          ) : undefined}
                        />
                      }
                      onClick={() => handleClick(item)}
                      onContextMenu={(e) => handleContextMenu(e, item)}
                      isPinned={item.is_pinned}
                    />
                  </div>
                )
              })}
            </div>
          )
        ) : (
          <div className="px-2.5 py-4 text-center text-body text-muted-foreground">
            {t(config.emptyLabelKey)}
          </div>
        )}

        <ContextMenu
          open={pinMenu.open}
          onClose={() => setPinMenu(prev => ({ ...prev, open: false }))}
          anchorPosition={pinMenu.pos}
          className="w-40"
        >
          <ContextMenuItem
            icon={pinMenu.item?.is_pinned
              ? <PinOff className="h-4 w-4" />
              : <Pin className="h-4 w-4" />}
            label={pinMenu.item?.is_pinned ? t('home.unpin', '取消置顶') : t('home.pin', '置顶')}
            onClick={handleTogglePin}
          />
        </ContextMenu>
      </div>
    )
  }

  Section.displayName = `${config.appId}Section`

  return {
    appId: config.appId,
    labelKey: config.tabLabelKey,
    Component: Section,
    // 资源列表型 Section 在独立 apphome 标签页中应展示完整 ContextHome 容器
    // （工具栏 / 视图切换 / 置顶面板等），保留旧版"资源型 App"的全功能体验。
    renderInsideContextHome: true,
  }
}
