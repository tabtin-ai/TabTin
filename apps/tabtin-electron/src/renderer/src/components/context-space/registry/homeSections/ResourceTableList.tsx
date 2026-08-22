/**
 * ResourceTableList — 飞书式资源多列表格（列表模式）
 *
 * 列：标题(图标+标题) / 位置(合集名,根目录回退) / 所有者(头像+名字) /
 *     最近更新时间 / 创建时间 / 最近访问。
 *
 * 所有者读 item.owner（资源 SSOT），不回退 created_by。
 *
 * 排序走前端：列表已全量加载，点击列头在本地对当前数组升/降序，箭头指示；
 * 置顶项恒排最前，不参与列排序。文件夹行恒在资源行之上。
 *
 * 设计取向：轻量组件，不接 TabData DataGrid；复用设计 token + formatRelativeTime。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { Pin, ChevronRight, ArrowUp, ArrowDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { contextRegistry } from '../instance'
import { formatRelativeTime } from '@/utils/formatRelativeTime'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import {
  SIDEBAR_ICON,
  SIDEBAR_ICON_SM,
  SIDEBAR_META_END,
  SIDEBAR_ROW,
  SIDEBAR_ROW_BODY,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_ROW_INACTIVE,
  SIDEBAR_ROW_ACTIVE,
} from '@components/layout/sidebarUi'
import { MemberAvatar } from '@components/shared/MemberAvatar'
import { isForeignSharedItem, getSharedLocation } from '../../hooks/useSharedContextItems'
import { isMovableContextItemId } from '../../hooks/useCollectionDnD'
import {
  getResourceDragBlockReason,
  logResourceDragBlocked,
} from '../../hooks/resourceDragDiagnostics'
import { setResourceDragPreview } from '../../hooks/resourceDragPreview'
import { useInlineEdit } from '../../hooks/useInlineEdit'
import { useDelayedSingleClick } from '../../hooks/useDelayedSingleClick'
import type { SpaceCollection, SpaceContextItem } from '@/services/spaceApi'
import type { TFunction } from 'i18next'
import { resolveNavigableResourceId } from '../../hooks/useResourceInit'
import { buildCloudDocsResourceTabKey } from '@components/layout/cloudDocsOpenTabs'
import { resolveCloudResourceEmoji } from './resolveCloudResourceIcon'

type SortKey = 'title' | 'location' | 'owner' | 'updated' | 'created' | 'visited'
type SortDir = 'asc' | 'desc'

export interface ResourceTableListProps {
  /** table = 主画布多列表格；sidebar = 窄栏紧凑列表（无列头） */
  variant?: 'table' | 'sidebar'
  /**
   * 侧栏行尾元信息：location=合集/分享位置（默认）；visited=最近打开时间（云文档「最近」）。
   * 仅 sidebar variant 生效。
   */
  sidebarTrailing?: 'location' | 'visited'
  /** 侧栏模式：当前画布激活的资源 tabKey（仅强高亮这一项，已打开列表见 Dock） */
  activeResourceTabKey?: string | null
  /** 当前文件夹下的子文件夹（恒排在资源行之上） */
  folders: SpaceCollection[]
  /** 当前可见资源（已按置顶优先 + updated_at 倒序传入） */
  items: SpaceContextItem[]
  /** 扁平化后的全部合集，用于解析「位置」列 */
  collectionsFlat: SpaceCollection[]
  folderItemCount?: (folder: SpaceCollection) => number
  /** 根目录显示名（item 无合集时回退） */
  rootFolderLabel: string
  onItemClick: (item: SpaceContextItem) => void
  onItemContextMenu: (e: React.MouseEvent, item: SpaceContextItem) => void
  onItemRename?: (item: SpaceContextItem, title: string) => Promise<void>
  onItemDragStart: (e: React.DragEvent, item: SpaceContextItem) => void
  /**
   * 资源行拖拽结束（可选）。云盘 / ContextHome 用它清理 activeDragItemRef 等拖拽态，
   * 避免取消拖拽/落在非目标后残留状态被下次 drop 误用；
   * 不传即不绑定 onDragEnd。
   */
  onItemDragEnd?: (e: React.DragEvent, item: SpaceContextItem) => void
  /** 云盘分享投影使用 placement 移动接口，允许拖拽到当前组织文件夹。 */
  allowForeignSharedDrag?: boolean
  isDeletingItem: (id: string) => boolean
  onFolderClick: (id: string) => void
  onFolderContextMenu: (e: React.MouseEvent, coll: SpaceCollection) => void
  onFolderDragStart: (e: React.DragEvent, coll: SpaceCollection) => void
  onFolderDragEnd: (e: React.DragEvent) => void
  onFolderDragOver: (e: React.DragEvent, coll: SpaceCollection) => void
  onFolderDrop: (e: React.DragEvent, coll: SpaceCollection) => void
  draggingFolderId: string | null
  /**
   * 拖拽离开文件夹行（可选）。云盘 / ContextHome 用它清除「把资源拖进文件夹」的高亮；
   * 不传即不绑定 onDragLeave。
   */
  onFolderDragLeave?: (e: React.DragEvent, coll: SpaceCollection) => void
  /**
   * 文件夹行是否处于 drop 高亮态（可选）。云盘 / ContextHome 据此为目标文件夹加 ring 高亮，
   * 覆盖「资源拖入文件夹」与「文件夹重排」两种悬停；不传即无高亮。
   */
  isFolderDropActive?: (coll: SpaceCollection) => boolean
  /** 批量模式：资源行前展示选择框，行点击切换选中，不打开资源。 */
  selectionMode?: boolean
  selectedItemIds?: ReadonlySet<string>
  onItemSelectionToggle?: (item: SpaceContextItem) => void
  isItemSelectable?: (item: SpaceContextItem) => boolean
}

/** 列宽模板：标题自适应（最小 180px），其余固定区间；外层 min-w 保证窄宽不挤压 */
const GRID_TEMPLATE =
  'minmax(180px,1fr) minmax(100px,152px) minmax(104px,148px) minmax(96px,124px) minmax(96px,124px) minmax(96px,124px)'
const TABLE_MIN_WIDTH = 780
const SELECTION_GRID_TEMPLATE = `40px ${GRID_TEMPLATE}`
const SELECTION_TABLE_MIN_WIDTH = 820

const HEADER_CELL =
  'flex items-center gap-1 px-2 py-1.5 CANVAS_TEXT_META font-medium select-none'
const HEADER_CELL_SORTABLE =
  'cursor-pointer rounded-interactive transition-colors hover:text-foreground'
const BODY_CELL = 'flex items-center px-2 py-2 min-w-0 overflow-hidden'

function resolveLocation(
  item: SpaceContextItem,
  collectionsFlat: SpaceCollection[],
  rootFolderLabel: string,
  t: TFunction,
): string {
  // 分享来源与资源位置是两个维度；所有者列已承载分享者，位置只展示权限安全的原目录。
  if (isForeignSharedItem(item)) {
    const location = getSharedLocation(item)
    if (location?.kind === 'root') return rootFolderLabel
    if (location?.kind === 'folder') {
      const names = location.path.map(segment => segment.name.trim()).filter(Boolean)
      if (names.length > 0) return names.join(' / ')
    }
    if (location?.kind === 'restricted') {
      return t('home.table.restrictedLocation', { defaultValue: '受限目录' })
    }
    return t('home.table.unavailableLocation', { defaultValue: '位置不可用' })
  }
  if (item.collection_id) {
    const coll = collectionsFlat.find(c => c.id === item.collection_id)
    if (coll) return coll.name
  }
  return rootFolderLabel
}

/** 资源真实所有者；缺失返回 null，不回退 created_by */
function resolveItemOwner(item: SpaceContextItem): SpaceContextItem['owner'] {
  return item.owner ?? null
}

function timeValue(value: string | null | undefined): number {
  if (!value) return 0
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? 0 : ms
}

const SIDEBAR_ROW_INTERACTIVE =
  'cursor-pointer hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]'

export const ResourceTableList: React.FC<ResourceTableListProps> = ({
  variant = 'table',
  sidebarTrailing = 'location',
  activeResourceTabKey = null,
  folders,
  items,
  collectionsFlat,
  folderItemCount,
  rootFolderLabel,
  onItemClick,
  onItemContextMenu,
  onItemRename,
  onItemDragStart,
  onItemDragEnd,
  allowForeignSharedDrag = false,
  isDeletingItem,
  onFolderClick,
  onFolderContextMenu,
  onFolderDragStart,
  onFolderDragEnd,
  onFolderDragOver,
  onFolderDrop,
  draggingFolderId,
  onFolderDragLeave,
  isFolderDropActive,
  selectionMode = false,
  selectedItemIds,
  onItemSelectionToggle,
  isItemSelectable,
}) => {
  const { t } = useTranslation('context')

  // sortKey === null：保持传入顺序（置顶优先 + updated_at 倒序），不回归既有行为
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const renameEdit = useInlineEdit()
  const titleClick = useDelayedSingleClick()

  const commitRename = useCallback(async (title: string, itemId?: string) => {
    if (!itemId || !onItemRename) return
    const item = items.find(candidate => candidate.id === itemId)
    if (item) await onItemRename(item, title)
  }, [items, onItemRename])

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(prev => (prev === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      // 时间类列默认倒序（最近在前），文本类列默认升序
      setSortDir(key === 'created' || key === 'visited' || key === 'updated' ? 'desc' : 'asc')
    }
  }

  const sortedItems = useMemo(() => {
    if (sortKey === null) return items
    const dir = sortDir === 'asc' ? 1 : -1
    const withLocation = (item: SpaceContextItem) =>
      resolveLocation(item, collectionsFlat, rootFolderLabel, t)
    // 时间列：空值（0）恒沉底，不随升降序翻转，对齐飞书直觉。
    const compareTime = (av: number, bv: number) => {
      if (av === 0 && bv === 0) return 0
      if (av === 0) return 1
      if (bv === 0) return -1
      return (av - bv) * dir
    }
    return [...items].sort((a, b) => {
      const aPinned = a.is_pinned ? 1 : 0
      const bPinned = b.is_pinned ? 1 : 0
      if (aPinned !== bPinned) return bPinned - aPinned
      switch (sortKey) {
        case 'title':
          return (a.title || a.resource_id || '').localeCompare(b.title || b.resource_id || '', 'zh-Hans-CN') * dir
        case 'location':
          return withLocation(a).localeCompare(withLocation(b), 'zh-Hans-CN') * dir
        case 'owner':
          return (resolveItemOwner(a)?.display_name || '').localeCompare(
            resolveItemOwner(b)?.display_name || '',
            'zh-Hans-CN',
          ) * dir
        case 'updated':
          return compareTime(timeValue(a.updated_at), timeValue(b.updated_at))
        case 'created':
          return compareTime(timeValue(a.created_at), timeValue(b.created_at))
        case 'visited':
          return compareTime(timeValue(a.last_visited_at), timeValue(b.last_visited_at))
        default:
          return 0
      }
    })
  }, [items, sortKey, sortDir, collectionsFlat, rootFolderLabel, t])

  const renderSortIcon = (key: SortKey) => {
    if (sortKey !== key) return null
    return sortDir === 'asc'
      ? <ArrowUp className="h-3 w-3 shrink-0" />
      : <ArrowDown className="h-3 w-3 shrink-0" />
  }

  const columns: { key: SortKey; labelKey: string; defaultValue: string; align?: string }[] = [
    { key: 'title', labelKey: 'home.table.colTitle', defaultValue: '标题' },
    { key: 'location', labelKey: 'home.table.colLocation', defaultValue: '位置' },
    { key: 'owner', labelKey: 'home.table.colOwner', defaultValue: '所有者' },
    { key: 'updated', labelKey: 'home.table.colUpdated', defaultValue: '最近更新时间' },
    { key: 'created', labelKey: 'home.table.colCreated', defaultValue: '创建时间' },
    { key: 'visited', labelKey: 'home.table.colVisited', defaultValue: '最近访问' },
  ]
  const gridTemplateColumns = selectionMode ? SELECTION_GRID_TEMPLATE : GRID_TEMPLATE
  const minWidth = selectionMode ? SELECTION_TABLE_MIN_WIDTH : TABLE_MIN_WIDTH
  const isSidebarVariant = variant === 'sidebar'
  const handleResourceRowDragStart = useCallback((
    event: React.DragEvent,
    item: SpaceContextItem,
  ) => {
    const resolvedType = contextRegistry.normalizeBackendType(item.item_type)
    setResourceDragPreview(event.dataTransfer, {
      label: item.title || item.resource_id,
      icon: resolveCloudResourceEmoji(
        resolvedType,
        item.metadata,
        type => contextRegistry.getDisplayEmoji(type),
        item.title || item.resource_id,
      ),
    })
    onItemDragStart(event, item)
  }, [onItemDragStart])
  const handleFolderRowDragStart = useCallback((
    event: React.DragEvent,
    folder: SpaceCollection,
  ) => {
    setResourceDragPreview(event.dataTransfer, {
      label: folder.name,
      icon: folder.icon || '📁',
    })
    onFolderDragStart(event, folder)
  }, [onFolderDragStart])

  if (isSidebarVariant) {
    return (
      <div className="flex w-full min-w-0 flex-col gap-0.5">
        {folders.map(coll => {
          const isDragging = draggingFolderId === coll.id
          const isDropActive = isFolderDropActive?.(coll) ?? false
          return (
            <div
              key={`folder-${coll.id}`}
              role="button"
              tabIndex={0}
              draggable
              className={cn(
                SIDEBAR_ROW,
                SIDEBAR_ROW_FULL_WIDTH,
                SIDEBAR_ROW_INACTIVE,
                SIDEBAR_ROW_INTERACTIVE,
                isDropActive && 'bg-foreground/[0.06] ring-1 ring-primary/30 dark:bg-foreground/[0.08]',
                isDragging && 'opacity-40',
              )}
              onClick={() => onFolderClick(coll.id)}
              onContextMenu={e => onFolderContextMenu(e, coll)}
              onDragStart={e => handleFolderRowDragStart(e, coll)}
              onDragEnd={onFolderDragEnd}
              onDragOver={e => onFolderDragOver(e, coll)}
              onDragLeave={onFolderDragLeave ? e => onFolderDragLeave(e, coll) : undefined}
              onDrop={e => onFolderDrop(e, coll)}
            >
              <span className={cn(SIDEBAR_ICON, 'flex items-center justify-center text-body leading-none')}>
                {coll.icon || '📁'}
              </span>
              <div className={cn(SIDEBAR_ROW_BODY, 'flex min-w-0 items-center gap-1')}>
                <span className="truncate font-medium text-foreground/85">{coll.name}</span>
                {coll.is_pinned && <Pin className="h-3 w-3 shrink-0 text-primary-text" />}
                <ChevronRight className={cn(SIDEBAR_ICON_SM, 'text-muted-foreground/50')} />
              </div>
              <span className={SIDEBAR_META_END}>
                {t('collectionsView.itemCount', { count: folderItemCount?.(coll) ?? coll.item_count ?? 0 })}
              </span>
            </div>
          )
        })}

        {sortedItems.map(item => {
          const resolvedType = contextRegistry.normalizeBackendType(item.item_type)
          const emoji = resolveCloudResourceEmoji(
            resolvedType,
            item.metadata,
            type => contextRegistry.getDisplayEmoji(type),
            item.title || item.resource_id,
          )
          const isDeleting = isDeletingItem(item.id)
          const location = resolveLocation(item, collectionsFlat, rootFolderLabel, t)
          const visitedLabel = formatRelativeTime(item.last_visited_at, t)
          const metaLabel = sidebarTrailing === 'visited'
            ? (visitedLabel || '—')
            : location
          const metaTitle = sidebarTrailing === 'visited'
            ? (item.last_visited_at ?? undefined)
            : location
          const foreignShared = isForeignSharedItem(item)
          const selectable = selectionMode && !isDeleting && (isItemSelectable?.(item) ?? true)
          const selected = Boolean(selectedItemIds?.has(item.id))
          const canDrag = !isDeleting && (!foreignShared || allowForeignSharedDrag) && !selectionMode && isMovableContextItemId(item.id)
          const dragBlockReason = canDrag
            ? null
            : getResourceDragBlockReason(item, {
              foreignShared,
              deleting: isDeleting,
              batchMode: Boolean(selectionMode),
            })
          const canRename = Boolean(
            onItemRename
            && item.id
            && !item.id.startsWith('local:')
            && !isDeleting
            && !foreignShared
            && !selectionMode,
          )
          const isRenaming = canRename && renameEdit.state?.id === item.id
          const title = item.title || item.resource_id
          const pathInvalid = item.item_type === 'tabfolder' && item.metadata?.pathInvalid
          const resourceTabKey = buildCloudDocsResourceTabKey({
            itemType: resolvedType,
            resourceId: resolveNavigableResourceId(item, resolvedType),
          })
          const isCanvasActive = Boolean(resourceTabKey && activeResourceTabKey === resourceTabKey)
          const handleRowClick = () => {
            if (selectionMode) {
              if (selectable) onItemSelectionToggle?.(item)
              return
            }
            onItemClick(item)
          }
          const handleBlockedPointerDown = dragBlockReason
            ? () => logResourceDragBlocked(item, dragBlockReason, { surface: 'ResourceTableList.sidebar' })
            : undefined
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={isDeleting ? -1 : 0}
              draggable={canDrag}
              aria-busy={isDeleting}
              aria-selected={selectionMode ? selected : undefined}
              className={cn(
                SIDEBAR_ROW,
                SIDEBAR_ROW_FULL_WIDTH,
                !isCanvasActive && SIDEBAR_ROW_INACTIVE,
                isCanvasActive && SIDEBAR_ROW_ACTIVE,
                selected && 'bg-primary/5 dark:bg-primary/10',
                isDeleting || (selectionMode && !selectable)
                  ? 'cursor-not-allowed opacity-60'
                  : SIDEBAR_ROW_INTERACTIVE,
              )}
              onClick={isDeleting ? undefined : handleRowClick}
              onContextMenu={isDeleting || selectionMode ? undefined : e => onItemContextMenu(e, item)}
              onPointerDown={handleBlockedPointerDown}
              onDragStart={canDrag ? e => handleResourceRowDragStart(e, item) : undefined}
              onDragEnd={canDrag && onItemDragEnd ? e => onItemDragEnd(e, item) : undefined}
            >
              {selectionMode && (
                <input
                  type="checkbox"
                  className="h-4 w-4 shrink-0 rounded border-border text-primary focus:ring-primary/30"
                  aria-label={`选择 ${title}`}
                  checked={selected}
                  disabled={!selectable}
                  onClick={event => event.stopPropagation()}
                  onChange={event => {
                    event.stopPropagation()
                    if (selectable) onItemSelectionToggle?.(item)
                  }}
                />
              )}
              <span className={cn(SIDEBAR_ICON, 'flex items-center justify-center text-body leading-none')}>
                {isDeleting ? (
                  <span className="block h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground/80 animate-spin" />
                ) : emoji}
              </span>
              <div className={SIDEBAR_ROW_BODY}>
                <div className="flex min-w-0 items-center gap-1 overflow-hidden">
                  {item.is_pinned && <Pin className="h-3 w-3 shrink-0 text-primary-text" />}
                  {isRenaming ? (
                    <input
                      className="h-auto min-w-0 flex-1 rounded-sm border border-border/60 bg-background px-1 py-0.5 text-body text-foreground outline-none focus:border-primary focus:ring-0"
                      aria-label={t('home.rename', { defaultValue: '重命名' })}
                      {...renameEdit.getInputProps(commitRename)}
                      onDoubleClick={event => event.stopPropagation()}
                    />
                  ) : (
                    <span
                      className={cn('truncate text-foreground/85', canRename && 'select-none')}
                      title={title}
                      onMouseDown={canRename ? event => {
                        if (event.detail > 1) event.preventDefault()
                      } : undefined}
                      onClick={canRename ? event => {
                        event.stopPropagation()
                        titleClick.schedule(() => onItemClick(item))
                      } : undefined}
                      onDoubleClick={canRename ? event => {
                        event.preventDefault()
                        event.stopPropagation()
                        titleClick.cancel()
                        renameEdit.start(title, item.id)
                      } : undefined}
                    >
                      {title}
                    </span>
                  )}
                  {pathInvalid && (
                    <span className={cn('shrink-0 rounded-full bg-foreground/[0.04] px-1.5 py-0.5', CANVAS_TEXT_META)}>
                      {t('folder.status.pathInvalid', { defaultValue: '已失效' })}
                    </span>
                  )}
                </div>
              </div>
              <span className={SIDEBAR_META_END} title={metaTitle}>
                {metaLabel}
              </span>
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="w-full" style={{ minWidth }}>
        {/* 列头（sticky） */}
        <div
          className="sticky top-0 z-sticky grid items-center border-b border-foreground/[0.06] bg-white dark:bg-black dark:border-foreground/[0.08]"
          style={{ gridTemplateColumns }}
        >
          {selectionMode && <div className={HEADER_CELL} aria-hidden="true" />}
          {columns.map(col => (
            <button
              key={col.key}
              type="button"
              className={cn(HEADER_CELL, HEADER_CELL_SORTABLE)}
              onClick={() => toggleSort(col.key)}
              aria-sort={sortKey === col.key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
            >
              <span className="truncate">{t(col.labelKey, { defaultValue: col.defaultValue })}</span>
              {renderSortIcon(col.key)}
            </button>
          ))}
        </div>

        {/* 文件夹行（恒在资源之上，不参与列排序） */}
        {folders.map(coll => {
          const isDragging = draggingFolderId === coll.id
          const isDropActive = isFolderDropActive?.(coll) ?? false
          return (
            <div
              key={`folder-${coll.id}`}
              role="button"
              tabIndex={0}
              draggable
              className={cn(
                'grid items-center border-b border-foreground/[0.03] text-body text-foreground/80 cursor-pointer transition-colors',
                'hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05] dark:border-foreground/[0.04]',
                isDropActive && 'bg-foreground/[0.06] ring-1 ring-primary/30 dark:bg-foreground/[0.08]',
                isDragging && 'opacity-40',
              )}
              style={{ gridTemplateColumns }}
              onClick={() => onFolderClick(coll.id)}
              onContextMenu={e => onFolderContextMenu(e, coll)}
              onDragStart={e => handleFolderRowDragStart(e, coll)}
              onDragEnd={onFolderDragEnd}
              onDragOver={e => onFolderDragOver(e, coll)}
              onDragLeave={onFolderDragLeave ? e => onFolderDragLeave(e, coll) : undefined}
              onDrop={e => onFolderDrop(e, coll)}
            >
              {selectionMode && <div className={BODY_CELL} aria-hidden="true" />}
              <div className={cn(BODY_CELL, 'gap-1.5')}>
                <span className="flex h-[1em] w-[1em] shrink-0 items-center justify-center text-body leading-none">
                  {coll.icon || '📁'}
                </span>
                <span className="truncate font-medium">{coll.name}</span>
                {coll.is_pinned && <Pin className="h-3 w-3 shrink-0 text-primary-text" />}
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/60" />
              </div>
              <div className={cn(BODY_CELL, 'CANVAS_TEXT_META')}>
                <span className="truncate">
                {t('collectionsView.itemCount', { count: folderItemCount?.(coll) ?? coll.item_count ?? 0 })}
                </span>
              </div>
              <div className={BODY_CELL} />
              <div className={BODY_CELL} />
              <div className={BODY_CELL} />
              <div className={BODY_CELL} />
            </div>
          )
        })}

        {/* 资源行 */}
        {sortedItems.map(item => {
          const resolvedType = contextRegistry.normalizeBackendType(item.item_type)
          const emoji = resolveCloudResourceEmoji(
            resolvedType,
            item.metadata,
            type => contextRegistry.getDisplayEmoji(type),
            item.title || item.resource_id,
          )
          const isDeleting = isDeletingItem(item.id)
          const location = resolveLocation(item, collectionsFlat, rootFolderLabel, t)
          const owner = resolveItemOwner(item)
          const pathInvalid = item.item_type === 'tabfolder' && item.metadata?.pathInvalid
          // 分享并入项不属于当前 Space，禁止拖入文件夹 / 拖出
          const foreignShared = isForeignSharedItem(item)
          const selectable = selectionMode && !isDeleting && (isItemSelectable?.(item) ?? true)
          const selected = Boolean(selectedItemIds?.has(item.id))
          const canDrag = !isDeleting && (!foreignShared || allowForeignSharedDrag) && !selectionMode && isMovableContextItemId(item.id)
          const dragBlockReason = canDrag
            ? null
            : getResourceDragBlockReason(item, {
              foreignShared,
              deleting: isDeleting,
              batchMode: Boolean(selectionMode),
            })
          const canRename = Boolean(
            onItemRename
            && item.id
            && !item.id.startsWith('local:')
            && !isDeleting
            && !foreignShared
            && !selectionMode,
          )
          const isRenaming = canRename && renameEdit.state?.id === item.id
          const title = item.title || item.resource_id
          const handleRowClick = () => {
            if (selectionMode) {
              if (selectable) onItemSelectionToggle?.(item)
              return
            }
            onItemClick(item)
          }
          const handleBlockedPointerDown = dragBlockReason
            ? () => logResourceDragBlocked(item, dragBlockReason, { surface: 'ResourceTableList.table' })
            : undefined
          return (
            <div
              key={item.id}
              role="button"
              tabIndex={isDeleting ? -1 : 0}
              draggable={canDrag}
              aria-busy={isDeleting}
              aria-selected={selectionMode ? selected : undefined}
              className={cn(
                'grid items-center border-b border-foreground/[0.03] text-body text-foreground/80 transition-colors dark:border-foreground/[0.04]',
                selected && 'bg-primary/5 dark:bg-primary/10',
                isDeleting || (selectionMode && !selectable)
                  ? 'cursor-not-allowed opacity-60'
                  : 'cursor-pointer hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]',
              )}
              style={{ gridTemplateColumns }}
              onClick={isDeleting ? undefined : handleRowClick}
              onContextMenu={isDeleting || selectionMode ? undefined : e => onItemContextMenu(e, item)}
              onPointerDown={handleBlockedPointerDown}
              onDragStart={canDrag ? e => handleResourceRowDragStart(e, item) : undefined}
              onDragEnd={canDrag && onItemDragEnd ? e => onItemDragEnd(e, item) : undefined}
            >
              {selectionMode && (
                <div className={cn(BODY_CELL, 'justify-center')}>
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border text-primary focus:ring-primary/30"
                    aria-label={`选择 ${title}`}
                    checked={selected}
                    disabled={!selectable}
                    onClick={event => event.stopPropagation()}
                    onChange={event => {
                      event.stopPropagation()
                      if (selectable) onItemSelectionToggle?.(item)
                    }}
                  />
                </div>
              )}
              {/* 标题 */}
              <div className={cn(BODY_CELL, 'gap-1.5')}>
                <span className="flex h-[1em] w-[1em] shrink-0 items-center justify-center text-body leading-none">
                  {isDeleting ? (
                    <span className="block h-3.5 w-3.5 rounded-full border-2 border-muted-foreground/25 border-t-muted-foreground/80 animate-spin" />
                  ) : emoji}
                </span>
                {item.is_pinned && <Pin className="h-3 w-3 shrink-0 text-primary-text" />}
                {isRenaming ? (
                  <input
                    className="h-auto min-w-0 flex-1 rounded-sm border border-border/60 bg-background px-1 py-0.5 text-body text-foreground outline-none focus:border-primary focus:ring-0"
                    aria-label={t('home.rename', { defaultValue: '重命名' })}
                    {...renameEdit.getInputProps(commitRename)}
                    onDoubleClick={event => event.stopPropagation()}
                  />
                ) : (
                  <span
                    className={cn('truncate', canRename && 'select-none')}
                    title={title}
                    onMouseDown={canRename ? event => {
                      // 阻止双击默认「选中文本」，否则看起来像没进重命名
                      if (event.detail > 1) event.preventDefault()
                    } : undefined}
                    onClick={canRename ? event => {
                      event.stopPropagation()
                      titleClick.schedule(() => onItemClick(item))
                    } : undefined}
                    onDoubleClick={canRename ? event => {
                      event.preventDefault()
                      event.stopPropagation()
                      titleClick.cancel()
                      renameEdit.start(title, item.id)
                    } : undefined}
                  >
                    {title}
                  </span>
                )}
                {/* 状态徽标贴在标题区，避免占用时间列造成语义错位 */}
                {pathInvalid && (
                  <span className={cn('shrink-0', 'rounded-full', 'bg-foreground/[0.04]', 'px-1.5', 'py-0.5', CANVAS_TEXT_META)}>
                    {t('folder.status.pathInvalid', { defaultValue: '已失效' })}
                  </span>
                )}
              </div>
              {/* 位置 */}
              <div className={cn(BODY_CELL, 'CANVAS_TEXT_META')}>
                <span className="truncate" title={location}>{location}</span>
              </div>
              {/* 所有者 */}
              <div className={cn(BODY_CELL, 'gap-1.5')}>
                {owner ? (
                  <>
                    <MemberAvatar name={owner.display_name} avatarUrl={owner.avatar} size="xs" />
                    <span className={cn('truncate', 'text-foreground/80', CANVAS_TEXT_META)} title={owner.display_name}>{owner.display_name}</span>
                  </>
                ) : (
                  <span className={CANVAS_TEXT_META}>—</span>
                )}
              </div>
              {/* 最近更新时间 */}
              <div className={cn(BODY_CELL, 'CANVAS_TEXT_META tabular-nums')}>
                <span className="truncate" title={item.updated_at ?? undefined}>
                  {formatRelativeTime(item.updated_at, t) || '—'}
                </span>
              </div>
              {/* 创建时间 */}
              <div className={cn(BODY_CELL, 'CANVAS_TEXT_META tabular-nums')}>
                <span className="truncate" title={item.created_at ?? undefined}>
                  {formatRelativeTime(item.created_at, t) || '—'}
                </span>
              </div>
              {/* 最近访问 */}
              <div className={cn(BODY_CELL, 'CANVAS_TEXT_META tabular-nums')}>
                <span className="truncate" title={item.last_visited_at ?? undefined}>
                  {formatRelativeTime(item.last_visited_at, t) || '—'}
                </span>
              </div>
            </div>
          )
        })}
    </div>
  )
}
