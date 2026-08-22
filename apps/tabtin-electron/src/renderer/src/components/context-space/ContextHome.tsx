import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  CONTEXT_PAGE_HEADER_GAP,
  CONTEXT_PAGE_SHELL_FILL,
  CONTEXT_PAGE_TOOLBAR_BTN,
  MIN_CARD_WIDTH_DEFAULT,
  resourceGridTemplateColumns,
} from './constants'
import {
  Pin,
  Settings,
  LayoutList, LayoutGrid,
  Globe,
  Plus,
  Link,
  FileInput,
} from 'lucide-react'
import {
  Button,
  ScrollArea,
  toast,
} from '@components/ui'
import { filterFoldersBySearch, filterResourcesBySearch } from './resourceListSearch'
import { ContextPageToolbar } from './ContextPageToolbar'
import { ContextPageToolbarImportButton } from './ContextPageToolbarImportButton'

import { useTranslation } from 'react-i18next'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useUnifiedResources, EMPTY_RESOURCES, getResourceCacheKey } from '@/stores/useUnifiedResources'
import {
  useCollectionsBySpace,
  useCollections,
  useFolderBreadcrumb,
  findCollectionPathInTree,
  getCollectionChildrenSorted,
  flattenCollections,
} from '@/stores/useCollections'
import type { SpaceCollection, SpaceContextItem } from '@/services/spaceApi'

import type { HomeViewMode } from './registry/homeSections/HomeGridCard'
import { HomeGridCard, getTypeGradient } from './registry/homeSections/HomeGridCard'
import { ResourceGridCard } from './registry/homeSections/ResourceGridCard'
import { ResourceTableList } from './registry/homeSections/ResourceTableList'
import { ResourceBatchDeleteActions } from './registry/homeSections/ResourceBatchDeleteActions'
import { useResourceBatchDelete } from './registry/homeSections/useResourceBatchDelete'
import { cn } from '@utils/cn'
import {
  CANVAS_TEXT_EYEBROW,
  CANVAS_TEXT_META,
} from '@components/layout/canvasUi'
import { ResourceCollectionSkeleton } from '@components/common/ListSkeletons'
import { useSpaceViewPrefsStore, type ResourceScope } from '@stores/useSpaceViewPrefsStore'
import { useLocalContextItems } from './hooks/useLocalContextItems'
import {
  useSharedContextItems,
  isForeignSharedItem,
  openForeignSharedItem,
  getSharedByName,
} from './hooks/useSharedContextItems'
import { useRemoveFolderConfirm } from './hooks/useRemoveFolderConfirm'
import { useCollectionFolderMenu } from './hooks/useCollectionFolderMenu'
import {
  COLLECTION_FOLDER_MIME,
  COLLECTION_ITEM_MIME,
  buildCollectionDragItem,
  dataTransferHasType,
  isMovableContextItemId,
  useCollectionDnD,
  type CollectionDragItem,
} from './hooks/useCollectionDnD'
import {
  getResourceDragBlockReason,
  logResourceDragBlocked,
} from './hooks/resourceDragDiagnostics'
import {
  buildSpaceItemChatContextDragPayload,
  writeChatContextDragPayload,
} from './hooks/chatContextDragPayload'
import { setResourceDragPreview } from './hooks/resourceDragPreview'
import { createLogger } from '@/utils/logger'
import { useResourceContextMenu, ResourceContextMenuOverlay } from './ResourceContextMenu'
import { useSpaceContextState, useSpaceContextActions } from './SpaceContextAreaContext'
import { QuickActionsPopover } from './QuickActionsPopover'
import { ContextPageHeader } from './ContextPageHeader'
import { resolveAppIconPresentation, SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { ContextListPanelBreadcrumb } from './ContextListPanelBreadcrumb'
import { TabDocCapabilityBanner } from './tabdoc/TabDocCapabilityBanner'
import { TabDataCapabilityBanner } from './tabdata/TabDataCapabilityBanner'
import { contextRegistry } from './registry'
import { createCloudResourceInFolder } from './registry/homeSections/createCloudResourceInFolder'
import { resolveCloudResourceEmoji } from './registry/homeSections/resolveCloudResourceIcon'
import { resolveAppHomeTabModel } from './registry/resolveUtils'
import {
  getEffectiveScopeForTypeFilter,
  isCrossSpaceScopedItem,
  isUserVisibleTabdataResourceItem,
  reloadResourceBucketsForScope,
  supportsOrganizationScopeForTypeFilter,
} from './resourceScope'
import { isCloudFileResourceType } from './cloudResourceTypes'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import {
  SIDEBAR_LIST_PANEL,
  SIDEBAR_LIST_PANEL_HEADER,
  SIDEBAR_LIST_PANEL_SCROLL,
} from '@components/layout/sidebarUi'
import {
  RESOURCE_IMPORT_ACCEPT_BY_APP_ID,
  type ImportableResourceAppId,
} from './resourceFileImportRouting'
import { useResourceFileImport } from './useResourceFileImport'

const VIEW_MODE_STORAGE_KEY = 'tabtin:home:viewMode'
const log = createLogger('ContextHome')

function loadViewMode(): HomeViewMode {
  try {
    const v = localStorage.getItem(VIEW_MODE_STORAGE_KEY)
    return v === 'grid' ? 'grid' : 'list'
  } catch { return 'list' }
}

function saveViewMode(mode: HomeViewMode) {
  try { localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode) } catch { /* noop */ }
}

export type HomeResourceTypeFilter =
  | 'all'
  | 'tabdata'
  | 'tabdoc'
  | 'tabslide'
  | 'tabfiles'
  | 'tabsite'

const TYPE_FILTER_BUTTONS: HomeResourceTypeFilter[] = [
  'all', 'tabdata', 'tabdoc', 'tabslide', 'tabfiles',
]

const TYPE_FILTER_LABEL_KEYS: Record<HomeResourceTypeFilter, string> = {
  all: 'home.assetBrowser.typeFilterAll',
  tabdata: 'home.assetBrowser.typeFilterTable',
  tabdoc: 'home.assetBrowser.typeFilterDocument',
  tabslide: 'home.assetBrowser.typeFilterSlide',
  tabfiles: 'home.assetBrowser.typeFilterFiles',
  tabsite: 'home.assetBrowser.sites',
}

const APP_HOME_SUBTITLE_KEYS: Record<string, { key: string; defaultValue: string }> = {
  tabdata: {
    key: 'home.appHomeSubtitle.tabdata',
    defaultValue: '管理这个工作空间里的表格和结构化数据',
  },
  tabdoc: {
    key: 'home.appHomeSubtitle.tabdoc',
    defaultValue: '管理这个工作空间里的文档、草稿和协作内容',
  },
  tabslide: {
    key: 'home.appHomeSubtitle.tabslide',
    defaultValue: '管理这个工作空间里的演示文稿',
  },
  tabfiles: {
    key: 'home.appHomeSubtitle.tabfiles',
    defaultValue: '管理这个工作空间里的文件资源',
  },
  tabsite: {
    key: 'home.appHomeSubtitle.tabsite',
    defaultValue: '管理这个工作空间里的站点项目',
  },
}

type ResourceActionAppId = 'tabdata' | 'tabdoc' | 'tabslide'

function toResourceActionAppId(filter: HomeResourceTypeFilter): ResourceActionAppId | null {
  return filter === 'tabdata' || filter === 'tabdoc' || filter === 'tabslide'
    ? filter
    : null
}

function toImportableResourceAppId(appId: ResourceActionAppId | null): ImportableResourceAppId | null {
  return appId === 'tabdata' || appId === 'tabdoc' || appId === 'tabslide' ? appId : null
}

function matchesTypeFilter(
  item: { item_type?: string | null },
  filter: HomeResourceTypeFilter,
): boolean {
  if (filter === 'all') return true
  const t = contextRegistry.normalizeBackendType(item.item_type ?? '')
  if (filter === 'tabfiles') return isCloudFileResourceType(t)
  return t === filter
}

function mapLegacyForcedAssetTab(tab: string | null | undefined): HomeResourceTypeFilter | null {
  if (!tab) return null
  const m: Record<string, HomeResourceTypeFilter> = {
    all: 'all',
    collections: 'all',
    tabdata: 'tabdata',
    tabdoc: 'tabdoc',
    tabslide: 'tabslide',
    tabfolder: 'tabfiles',
    tabfiles: 'tabfiles',
    tabsite: 'tabsite',
  }
  return m[tab] ?? null
}

interface ContextHomeProps {
  hideToolbar?: boolean
  mode?: 'full' | 'recent'
  forcedAssetTab?: string | null
  forcedTypeFilter?: HomeResourceTypeFilter | null
  hideAssetSwitcher?: boolean
  currentFolderId?: string | null
  onNavigateFolder?: (folderId: string | null) => void
}

export const ContextHome: React.FC<ContextHomeProps> = ({
  hideToolbar = false,
  mode = 'full',
  forcedAssetTab = null,
  forcedTypeFilter = null,
  hideAssetSwitcher = false,
  currentFolderId: controlledFolderId,
  onNavigateFolder,
}) => {
  const { spaceId, tabScopeKey } = useSpaceContextState()
  const {
    createHandlers,
    onOpenSpaceSettings,
    onSearchNavigate,
  } = useSpaceContextActions()

  const { t } = useTranslation('context')
  const currentSpace = useSpaceStore(state => state.spaces.find(item => item.id === spaceId) ?? null)
  const selectedOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)

  const { collections, isLoading: collectionsLoading } = useCollectionsBySpace(spaceId)
  const collectionsFlat = useMemo(() => flattenCollections(collections), [collections])

  const folderBrowseControlled = typeof onNavigateFolder === 'function'
  const [internalBrowseFolderId, setInternalBrowseFolderId] = useState<string | null>(null)
  const browseFolderId = folderBrowseControlled ? (controlledFolderId ?? null) : internalBrowseFolderId

  const navigateBrowseFolder = useCallback((id: string | null) => {
    if (folderBrowseControlled) {
      onNavigateFolder(id)
    } else {
      setInternalBrowseFolderId(id)
    }
  }, [folderBrowseControlled, onNavigateFolder])

  useEffect(() => {
    if (folderBrowseControlled) return
    setInternalBrowseFolderId(null)
  }, [spaceId, folderBrowseControlled])

  useEffect(() => {
    if (mode === 'recent' || !browseFolderId || collectionsLoading) return
    const path = findCollectionPathInTree(collections, browseFolderId)
    if (path.length === 0) {
      navigateBrowseFolder(null)
    }
  }, [browseFolderId, collections, collectionsLoading, mode, navigateBrowseFolder])

  const effectiveBrowseFolderId = mode === 'recent' ? null : browseFolderId

  const rootFolderLabel = t('home.assetBrowser.rootFolder')
  const folderBreadcrumb = useFolderBreadcrumb(effectiveBrowseFolderId, collections, rootFolderLabel)

  const [activeTypeFilter, setActiveTypeFilter] = useState<HomeResourceTypeFilter>('all')
  const lockedTypeFilter: HomeResourceTypeFilter | null = hideAssetSwitcher
    ? (forcedTypeFilter ?? mapLegacyForcedAssetTab(forcedAssetTab) ?? 'all')
    : null
  const effectiveTypeFilter = lockedTypeFilter ?? activeTypeFilter

  useEffect(() => {
    if (lockedTypeFilter) return
    if (!TYPE_FILTER_BUTTONS.includes(activeTypeFilter)) {
      setActiveTypeFilter('all')
    }
  }, [activeTypeFilter, lockedTypeFilter])

  const [viewMode, setViewMode] = useState<HomeViewMode>(loadViewMode)
  const [searchQuery, setSearchQuery] = useState('')
  const toggleViewMode = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'list' ? 'grid' : 'list'
      saveViewMode(next)
      return next
    })
  }, [])

  const resourceScope = useSpaceViewPrefsStore(s => s.getPrefs(spaceId).resourceScope)
  const setResourceScope = useSpaceViewPrefsStore(s => s.setResourceScope)
  const toggleResourceScope = useCallback(() => {
    const next: ResourceScope = resourceScope === 'space' ? 'organization' : 'space'
    setResourceScope(spaceId, next)
  }, [spaceId, resourceScope, setResourceScope])

  const effectiveTypeFilterForData = mode === 'recent' ? 'all' : effectiveTypeFilter
  // TabData / TabDoc 应用页对齐云盘：固定组织级视图，不再提供「仅当前 Workspace」切换。
  const lockOrganizationScopeAppHome =
    hideAssetSwitcher
    && (forcedAssetTab === 'tabdata' || forcedAssetTab === 'tabdoc')
  const supportsResourceScope =
    !lockOrganizationScopeAppHome
    && supportsOrganizationScopeForTypeFilter(effectiveTypeFilterForData, mode)
  const effectiveResourceScope: ResourceScope = lockOrganizationScopeAppHome
    ? 'organization'
    : getEffectiveScopeForTypeFilter(
      resourceScope,
      effectiveTypeFilterForData,
      mode,
    )

  const loadResources = useUnifiedResources(s => s.load)
  useEffect(() => {
    if (effectiveResourceScope === 'organization') {
      void loadResources(spaceId, true, 'organization')
    }
  }, [effectiveResourceScope, spaceId, loadResources])

  const refreshResourceBuckets = useCallback((_resourceType: string) => {
    setTimeout(() => {
      void reloadResourceBucketsForScope(
        useUnifiedResources.getState().load,
        spaceId,
        effectiveResourceScope,
      )
    }, 300)
  }, [effectiveResourceScope, spaceId])

  const organizationCacheKey = getResourceCacheKey(spaceId, 'organization') ?? `${spaceId}:organization`
  const hasOrganizationBucket = useUnifiedResources(s => Object.prototype.hasOwnProperty.call(s.resourcesBySpaceId, organizationCacheKey))
  const spaceResources = useUnifiedResources(s => s.resourcesBySpaceId[spaceId] ?? EMPTY_RESOURCES)
  const organizationResources = useUnifiedResources(s => s.resourcesBySpaceId[organizationCacheKey] ?? EMPTY_RESOURCES)
  const resources = effectiveResourceScope === 'organization'
    ? organizationResources
    : spaceResources
  const isResourcesLoading = useUnifiedResources(s =>
    effectiveResourceScope === 'organization'
      ? Boolean(s.loadingBySpaceId[organizationCacheKey])
      : Boolean(s.loadingBySpaceId[spaceId])
  ) || (effectiveResourceScope === 'organization' && !hasOrganizationBucket)
  const localItems = useLocalContextItems(spaceId)

  const allItems = useMemo(() => {
    const cloudItems = resources.filter(r => {
      if (r.is_archived) return false
      if (!isUserVisibleTabdataResourceItem(r)) return false
      return true
    })

    return [...cloudItems, ...localItems]
      .sort((a, b) => {
        const aPinned = a.is_pinned ? 1 : 0
        const bPinned = b.is_pinned ? 1 : 0
        if (aPinned !== bPinned) return bPinned - aPinned
        if (aPinned && bPinned) {
          const pa = a.pinned_at ? new Date(a.pinned_at).getTime() : 0
          const pb = b.pinned_at ? new Date(b.pinned_at).getTime() : 0
          return pb - pa
        }
        const dateA = a.updated_at ? new Date(a.updated_at).getTime() : 0
        const dateB = b.updated_at ? new Date(b.updated_at).getTime() : 0
        return dateB - dateA
      })
  }, [resources, localItems])

  const pinnedItems = useMemo(() => allItems.filter(i => i.is_pinned), [allItems])

  const childFolders = useMemo(
    () => getCollectionChildrenSorted(collections, effectiveBrowseFolderId),
    [collections, effectiveBrowseFolderId],
  )
  // Collection 是云盘组织容器，不属于 tabdata/tabdoc 等类型资源。
  // TabData/TabDoc apphome（forcedAssetTab）会锁定类型筛选；若不隐藏文件夹会串台。
  const visibleChildFolders = useMemo(
    () => (
      mode === 'recent' || effectiveTypeFilterForData !== 'all'
        ? []
        : childFolders
    ),
    [mode, effectiveTypeFilterForData, childFolders],
  )

  // ── 「分享给我」并入「全部」：原位置由权限裁剪元数据承载，分享者独立保留 ──
  const [sharedOnly, setSharedOnly] = useState(false)
  const { items: sharedItems } = useSharedContextItems(spaceId, mode === 'full')
  // ：「分享给我」筛选用完整 sharedItems；合并到「全部」时再按 resource_id 去重，
  // 避免组织列表泄漏时把真实分享项滤空。
  const sharedExtraItems = useMemo(() => {
    if (mode !== 'full') return []
    return sharedItems
  }, [sharedItems, mode])

  const displayResourceItems = useMemo(() => {
    if (mode === 'recent') {
      return allItems.filter(i => matchesTypeFilter(i, 'all'))
    }
    // 筛选视图：只看分享给我（忽略文件夹层级，分享项不在本 Space 合集内）
    if (sharedOnly) {
      return sharedExtraItems.filter(i => matchesTypeFilter(i, effectiveTypeFilterForData))
    }
    // 类型筛选（含 TabData/TabDoc apphome）：扁平列出该类型全部资源，
    // 不按 Collection 层级；文件夹行已在 visibleChildFolders 隐藏。
    if (effectiveTypeFilterForData !== 'all') {
      const typed = allItems.filter(i => matchesTypeFilter(i, effectiveTypeFilterForData))
      const ownIds = new Set(typed.map(i => i.resource_id).filter(Boolean))
      const sharedTyped = sharedExtraItems.filter(
        i => matchesTypeFilter(i, effectiveTypeFilterForData) && !ownIds.has(i.resource_id),
      )
      return [...typed, ...sharedTyped]
    }
    const inFolder = allItems.filter(item => {
      const cid = item.collection_id ?? null
      if (effectiveBrowseFolderId === null) return cid === null
      return cid === effectiveBrowseFolderId
    })
    // 分享项仅在根目录与本 Space 资源合并展示；已在 ACL 列表出现的不再重复插入
    if (effectiveBrowseFolderId !== null) {
      return inFolder.filter(i => matchesTypeFilter(i, effectiveTypeFilterForData))
    }
    const ownIds = new Set(inFolder.map(i => i.resource_id).filter(Boolean))
    const sharedAtRoot = sharedExtraItems.filter(i => !ownIds.has(i.resource_id))
    return [...inFolder, ...sharedAtRoot].filter(i => matchesTypeFilter(i, effectiveTypeFilterForData))
  }, [allItems, sharedExtraItems, sharedOnly, mode, effectiveBrowseFolderId, effectiveTypeFilterForData])

  const filteredDisplayResourceItems = useMemo(
    () => filterResourcesBySearch(displayResourceItems, searchQuery),
    [displayResourceItems, searchQuery],
  )
  const filteredVisibleChildFolders = useMemo(
    () => filterFoldersBySearch(visibleChildFolders, searchQuery),
    [visibleChildFolders, searchQuery],
  )
  const filteredPinnedItems = useMemo(
    () => filterResourcesBySearch(pinnedItems, searchQuery),
    [pinnedItems, searchQuery],
  )

  // 资源行点击：分享并入项走外部资源打开，其余走普通 Space 导航。
  // 透传当前 tabScopeKey，避免云文档域打开落到 desktop 桶导致「点了没反应」。
  const handleResourceItemClick = useCallback((item: SpaceContextItem) => {
    if (isForeignSharedItem(item)) {
      openForeignSharedItem(spaceId, item, { tabScopeKey: tabScopeKey ?? undefined })
      return
    }
    onSearchNavigate?.(item)
  }, [spaceId, tabScopeKey, onSearchNavigate])

  const contextMenu = useResourceContextMenu(spaceId)
  const folderConfirm = useRemoveFolderConfirm(spaceId)
  const {
    openFolderMenu,
    draggingFolderId,
    isFolderDragActive,
    handleFolderDragStart,
    handleFolderDragEnd,
    handleFolderDragOver,
    handleFolderDragOverParent,
    handleFolderDrop,
    handleFolderDropToParent,
    renderCollectionFolderMenuLayer,
  } = useCollectionFolderMenu({
    spaceId,
    collections,
    currentBrowseFolderId: effectiveBrowseFolderId,
    onBrowseFolderChange: navigateBrowseFolder,
  })

  // ── Resource → folder DnD（对齐 CloudResourcesHome / ）──
  // Windows/Chromium：dragStart 禁止同步 setState，只用 ref 做 MIME 兜底。
  const { moveItems } = useCollections.getState()
  const activeDragItemRef = useRef<CollectionDragItem | null>(null)
  const {
    dragOverTarget,
    handleDragOver,
    handleDragLeave,
    handleDropOnCollection,
    handleDropOnUncategorized,
  } = useCollectionDnD({
    spaceId,
    moveItems,
    t,
    activeDragItemRef,
    allowOrganizationCrossSpaceMove: effectiveResourceScope === 'organization',
  })

  const clearActiveDragItem = useCallback(() => {
    activeDragItemRef.current = null
  }, [])

  useEffect(() => clearActiveDragItem, [clearActiveDragItem])

  const handleResourceDragStart = useCallback((event: React.DragEvent, item: SpaceContextItem) => {
    const dragItem = buildCollectionDragItem(item, {
      isCrossSpace: Boolean(item.space_id && item.space_id !== spaceId),
    })
    if (!dragItem) {
      event.preventDefault()
      log.warn('dragStart blocked: empty or local context item id', {
        spaceId,
        resource_id: item.resource_id,
        collection_id: item.collection_id ?? null,
      })
      toast.warning(t('home.assetBrowser.itemStillSyncing', {
        defaultValue: '资源仍在同步，请稍后再试',
      }))
      void useUnifiedResources.getState().load(spaceId, true, effectiveResourceScope)
      return
    }
    activeDragItemRef.current = dragItem
    event.dataTransfer.setData(COLLECTION_ITEM_MIME, JSON.stringify(dragItem))
    writeChatContextDragPayload(
      event.dataTransfer,
      buildSpaceItemChatContextDragPayload(item, contextRegistry),
    )
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
    event.dataTransfer.effectAllowed = 'copyMove'
    log.info('dragStart', {
      spaceId,
      itemId: dragItem.id,
      resource_id: item.resource_id,
      collection_id: item.collection_id ?? null,
      item_space_id: item.space_id,
      is_cross_space: Boolean(dragItem.is_cross_space),
      scope: effectiveResourceScope,
    })
  }, [effectiveResourceScope, spaceId, t])

  const handleResourceDragEnd = clearActiveDragItem

  const handleResourceDropTarget = useCallback((event: React.DragEvent, collectionId: string | null) => {
    if (collectionId === null) {
      void handleDropOnUncategorized(event)
    } else {
      void handleDropOnCollection(event, collectionId)
    }
    clearActiveDragItem()
  }, [clearActiveDragItem, handleDropOnCollection, handleDropOnUncategorized])

  const handleBreadcrumbDragOver = useCallback((id: string | null, event: React.DragEvent) => {
    event.stopPropagation()
    if (isFolderDragActive() || dataTransferHasType(event.dataTransfer, COLLECTION_FOLDER_MIME)) {
      if (handleFolderDragOverParent(event, id)) {
        handleDragOver(event, `crumb:${id ?? 'root'}`, { force: true })
      }
      return
    }
    handleDragOver(event, `crumb:${id ?? 'root'}`)
  }, [handleDragOver, handleFolderDragOverParent, isFolderDragActive])

  const handleBreadcrumbDrop = useCallback((id: string | null, event: React.DragEvent) => {
    event.stopPropagation()
    if (isFolderDragActive() || dataTransferHasType(event.dataTransfer, COLLECTION_FOLDER_MIME)) {
      handleFolderDropToParent(event, id)
      return
    }
    handleResourceDropTarget(event, id)
  }, [handleFolderDropToParent, handleResourceDropTarget, isFolderDragActive])

  const manageLinkLabel = t('home.appsAndTools.manageLink')

  const assetPageHeaderModel = hideToolbar && hideAssetSwitcher && forcedAssetTab
    ? resolveAppHomeTabModel(forcedAssetTab)
    : null
  const assetPageHeaderSubtitle = assetPageHeaderModel
    ? APP_HOME_SUBTITLE_KEYS[assetPageHeaderModel.appId]
    : null

  const scopeToolbar = (
    <>
      {supportsResourceScope && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn(
            'flex h-7 items-center gap-1 rounded-interactive px-2',
            CANVAS_TEXT_META,
            effectiveResourceScope === 'space'
              ? 'bg-foreground/[0.045] text-warning dark:bg-foreground/[0.06]'
              : 'text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]',
          )}
          onClick={toggleResourceScope}
          title={effectiveResourceScope === 'organization'
            ? t('home.assetBrowser.scopeSpaceTooltip', { defaultValue: t('home.assetBrowser.scopeSpace') })
            : t('home.assetBrowser.scopeOrganizationTooltip')}
        >
          <Globe className="h-3 w-3" />
          {effectiveResourceScope === 'space' && (
            <span>{t('home.assetBrowser.scopeSpace')}</span>
          )}
        </Button>
      )}
    </>
  )

  const sharedFilterLabel = t('home.source.shared', { defaultValue: '分享给我' })
  const sharedFilterButton = mode === 'full' ? (
    <Button
      type="button"
      variant={sharedOnly ? 'secondary' : 'ghost'}
      size="sm"
      className={cn(
        'h-7 w-7 p-0',
        sharedOnly
          ? 'bg-foreground/[0.06] text-primary-text hover:bg-foreground/[0.08] hover:text-primary-text dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.1]'
          : 'text-muted-foreground/60 hover:text-foreground',
      )}
      onClick={() => setSharedOnly(v => !v)}
      aria-label={sharedFilterLabel}
      aria-pressed={sharedOnly}
      title={sharedFilterLabel}
    >
      <Link className="h-3.5 w-3.5" />
    </Button>
  ) : null

  const viewToolbar = (
    <>
      {!sharedOnly && scopeToolbar}
      {sharedFilterButton}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
        onClick={toggleViewMode}
        title={viewMode === 'list'
          ? t('home.assetBrowser.gridView')
          : t('home.assetBrowser.listView')}
      >
        {viewMode === 'list' ? <LayoutGrid className="h-3.5 w-3.5" /> : <LayoutList className="h-3.5 w-3.5" />}
      </Button>
    </>
  )

  const renderFolderGridCard = (coll: SpaceCollection) => {
    const isDragOver = dragOverTarget === `coll:${coll.id}`
    const isDragging = draggingFolderId === coll.id
    return (
      <div
        key={coll.id}
        draggable
        onDragStart={event => handleFolderDragStart(event, coll)}
        onDragEnd={handleFolderDragEnd}
        onDragOver={event => {
          event.stopPropagation()
          handleFolderDragOver(event, coll)
          handleDragOver(event, `coll:${coll.id}`)
        }}
        onDragLeave={event => { event.stopPropagation(); handleDragLeave() }}
        onDrop={event => {
          event.stopPropagation()
          if (isFolderDragActive() || dataTransferHasType(event.dataTransfer, COLLECTION_FOLDER_MIME)) {
            void handleFolderDrop(event, coll)
            return
          }
          handleResourceDropTarget(event, coll.id)
        }}
        className={cn('rounded-[12px]', isDragOver && 'ring-1 ring-primary/30', isDragging && 'opacity-40')}
      >
        <HomeGridCard
          gradient={getTypeGradient('tabfolder')}
          icon={coll.icon || '📁'}
          title={coll.name}
          isPinned={Boolean(coll.is_pinned)}
          subtitle={
            <span className="text-muted-foreground/80">
              {t('collectionsView.itemCount', { count: coll.item_count ?? 0 })}
            </span>
          }
          onClick={() => navigateBrowseFolder(coll.id)}
          onContextMenu={(event) => openFolderMenu(event, coll)}
        />
      </div>
    )
  }

  const listIsEmpty = filteredVisibleChildFolders.length === 0 && filteredDisplayResourceItems.length === 0
  const hasActiveSearch = Boolean(searchQuery.trim())
  const showMainSkeleton = isResourcesLoading && allItems.length === 0

  const actionAppId = toResourceActionAppId(effectiveTypeFilter)
  const importableAppId = toImportableResourceAppId(actionAppId)
  const importFileInputRef = useRef<HTMLInputElement>(null)
  const { importFile, importingAppId } = useResourceFileImport({
    spaceId,
    organizationId: currentSpace?.organization_id || selectedOrganizationId,
    collectionId: effectiveBrowseFolderId,
    tabScopeKey,
    onImported: refreshResourceBuckets,
  })

  const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    const appId = importableAppId
    if (file && appId) await importFile(file, appId)
    event.target.value = ''
  }, [importFile, importableAppId])

  const resourceActions = actionAppId ? (
    <>
      <Button
        type="button"
        size="sm"
        className={CONTEXT_PAGE_TOOLBAR_BTN}
        onClick={() => createCloudResourceInFolder(createHandlers, actionAppId, effectiveBrowseFolderId)}
      >
        <Plus className="h-3.5 w-3.5" />
        {t('home.assetBrowser.createAction', { defaultValue: '新建' })}
      </Button>
      {importableAppId && (
        <>
          <input
            ref={importFileInputRef}
            type="file"
            accept={RESOURCE_IMPORT_ACCEPT_BY_APP_ID[importableAppId]}
            className="hidden"
            onChange={(event) => void handleImportFile(event)}
          />
          <ContextPageToolbarImportButton
            label={t('home.assetBrowser.importAction', { defaultValue: '导入' })}
            loading={importingAppId !== null}
            icon={FileInput}
            onClick={() => importFileInputRef.current?.click()}
          />
        </>
      )}
    </>
  ) : null

  const floatingCapabilityBanner = mode !== 'full' ? null
    : effectiveTypeFilter === 'tabdoc' ? <TabDocCapabilityBanner spaceId={spaceId} />
      : effectiveTypeFilter === 'tabdata' ? <TabDataCapabilityBanner spaceId={spaceId} />
        : null

  const listPanelBreadcrumb = mode !== 'full' ? null : sharedOnly ? (
    // 筛选视图忽略文件夹层级，展示「分享给我」标识而非文件夹面包屑
    <span className="truncate rounded px-0.5 py-0.5 text-body font-medium text-foreground">
      {sharedFilterLabel}
    </span>
  ) : effectiveTypeFilterForData !== 'all' ? (
    // 类型筛选扁平列表，不展示 Collection 面包屑
    null
  ) : (
    <ContextListPanelBreadcrumb
      items={folderBreadcrumb.map(seg => ({ id: seg.id, label: seg.name }))}
      onSelect={navigateBrowseFolder}
      onItemDragOver={handleBreadcrumbDragOver}
      onItemDragLeave={event => { event.stopPropagation(); handleDragLeave() }}
      onItemDrop={handleBreadcrumbDrop}
      isItemDropActive={id => dragOverTarget === `crumb:${id ?? 'root'}`}
    />
  )

  // 应用主列表（文档 / 多维表等 apphome）对齐「应用」总览页间距；
  // Space 驾驶舱（hideToolbar=false）保持紧凑 px-3 py-3。
  const isAppHomePage = hideToolbar && hideAssetSwitcher && Boolean(forcedAssetTab)
  const supportsAppHomeBatchDelete = Boolean(
    isAppHomePage
    && !sharedOnly
    && (actionAppId === 'tabdata' || actionAppId === 'tabdoc'),
  )
  const appHomeBatchDelete = useResourceBatchDelete({
    items: filteredDisplayResourceItems,
    spaceId,
    resetKey: [
      actionAppId,
      effectiveBrowseFolderId ?? 'root',
      effectiveResourceScope,
      sharedOnly ? 'shared' : 'owned',
    ].join(':'),
    organizationId: currentSpace?.organization_id || selectedOrganizationId,
    enabled: supportsAppHomeBatchDelete,
  })
  const appHomeActions = (
    <>
      {!appHomeBatchDelete.selectionMode && resourceActions}
      {supportsAppHomeBatchDelete && (
        <ResourceBatchDeleteActions controller={appHomeBatchDelete} />
      )}
    </>
  )

  return (
    <div className="relative h-full w-full">
      <div className="h-full w-full overflow-hidden">
        <div
          className={cn(
            'flex h-full min-h-0 min-w-0 w-full flex-col',
            isAppHomePage ? CONTEXT_PAGE_SHELL_FILL : 'px-3 py-3',
          )}
        >
          <div
            className={cn(
              'flex h-full min-h-0 w-full flex-1 flex-col min-w-0',
              isAppHomePage ? 'gap-0' : 'gap-3',
            )}
          >

          {!hideToolbar && <div className="flex items-center justify-between min-w-0">
            <span className="text-body font-medium text-foreground truncate min-w-0 flex-1 mr-2">
              {currentSpace?.name || t('home.untitledSpace')}
            </span>
            <div className="flex items-center gap-1.5 shrink-0">
              <QuickActionsPopover spaceId={spaceId} createHandlers={createHandlers} />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                onClick={onOpenSpaceSettings}
                title={manageLinkLabel}
              >
                <Settings className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>}

          {assetPageHeaderModel && (
            <ContextPageHeader
              icon={(
                <SidebarTypeEmoji
                  appIdOrType={assetPageHeaderModel.appId}
                  className="h-10 w-10 text-title leading-none"
                />
              )}
              iconSurface={resolveAppIconPresentation(assetPageHeaderModel.appId) === 'selfContained' ? 'none' : 'muted'}
              title={assetPageHeaderModel.title}
              description={assetPageHeaderSubtitle
                ? t(assetPageHeaderSubtitle.key, { defaultValue: assetPageHeaderSubtitle.defaultValue })
                : undefined}
            />
          )}

          {isAppHomePage && (
            <ContextPageToolbar
              actions={appHomeActions}
              searchPlaceholder={t('home.assetBrowser.searchPlaceholder', {
                name: assetPageHeaderModel?.title ?? t('home.assetBrowser.all'),
                defaultValue: '搜索{{name}}…',
              })}
              searchValue={searchQuery}
              onSearchChange={setSearchQuery}
              trailing={viewToolbar}
            />
          )}

          {!sharedOnly
            && !appHomeBatchDelete.selectionMode
            && effectiveBrowseFolderId === null
            && filteredPinnedItems.length > 0 && (
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5 px-0.5">
                <Pin className="h-3.5 w-3.5 text-primary-text" />
                <h3 className="text-body font-medium text-muted-foreground">
                  {t('home.pinnedResources')}
                </h3>
              </div>
              <div className="grid gap-3" style={{ gridTemplateColumns: resourceGridTemplateColumns() }}>
                {filteredPinnedItems.map(item => {
                  const isPinnedFromOther = isCrossSpaceScopedItem(effectiveResourceScope, spaceId, item.space_id)
                  const isDeleting = contextMenu.isDeletingItem(item.id)
                  const canDrag = !isDeleting && isMovableContextItemId(item.id)
                  const dragBlockReason = canDrag
                    ? null
                    : getResourceDragBlockReason(item, { deleting: isDeleting })
                  return (
                    <div
                      key={item.id || item.resource_id}
                      draggable={canDrag}
                      onPointerDown={dragBlockReason
                        ? () => logResourceDragBlocked(item, dragBlockReason, { surface: 'ContextHome.pinned' })
                        : undefined}
                      onDragStart={canDrag ? event => handleResourceDragStart(event, item) : undefined}
                      onDragEnd={canDrag ? handleResourceDragEnd : undefined}
                    >
                      <ResourceGridCard
                        item={item}
                        onClick={() => onSearchNavigate?.(item)}
                        onContextMenu={(e) => contextMenu.handleContextMenu(e, item)}
                        spaceName={isPinnedFromOther ? (item.space_name || null) : undefined}
                        isBusy={isDeleting}
                        busyLabel={t('home.deleting', { defaultValue: 'Deleting...' })}
                      />
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col">
            {mode === 'full' && (
              <div className="flex flex-col gap-2 py-0.5 min-w-0 w-full">
                {!hideAssetSwitcher && (
                  <>
                    <div className="flex flex-wrap items-center gap-1 min-w-0 w-full">
                      {TYPE_FILTER_BUTTONS.map(fid => (
                        <Button
                          key={fid}
                          type="button"
                          variant={effectiveTypeFilter === fid ? 'secondary' : 'ghost'}
                          size="sm"
                          className={cn('h-7 px-2', CANVAS_TEXT_META)}
                          onClick={() => setActiveTypeFilter(fid)}
                        >
                          {t(TYPE_FILTER_LABEL_KEYS[fid])}
                        </Button>
                      ))}
                      <div className="flex-1 min-w-2" />
                      {viewToolbar}
                    </div>
                  </>
                )}
              </div>
            )}

            {mode === 'recent' && (
              <div className="flex items-center gap-1 py-0.5 min-w-0 w-full">
                <span className={cn(CANVAS_TEXT_EYEBROW, 'px-1.5 py-1 uppercase tracking-wider')}>
                  {t('home.assetBrowser.all')}
                </span>
                <div className="flex-1" />
                {viewToolbar}
              </div>
            )}

            {mode === 'full' && hideAssetSwitcher && !isAppHomePage && (
              <div
                className={cn(
                  'flex min-w-0 w-full items-center justify-end gap-1.5',
                  'pt-1',
                )}
              >
                {viewToolbar}
              </div>
            )}

            <div
              className={cn(
                'flex min-h-0 flex-1 flex-col min-w-0 w-full',
                isAppHomePage
                  ? (mode === 'full' && hideAssetSwitcher ? 'pt-2' : CONTEXT_PAGE_HEADER_GAP)
                  : 'pt-2',
              )}
            >
              {showMainSkeleton ? (
                <div className="min-h-0 flex-1 px-1 pt-1">
                  <ResourceCollectionSkeleton
                    mode={viewMode}
                    count={viewMode === 'grid' ? 6 : 7}
                    minCardWidth={MIN_CARD_WIDTH_DEFAULT}
                    variant="flat"
                  />
                </div>
              ) : listIsEmpty ? (
                <div className={cn(SIDEBAR_LIST_PANEL, 'flex h-full w-full flex-col')}>
                  {mode === 'full' && (
                    <div className={SIDEBAR_LIST_PANEL_HEADER}>
                      {listPanelBreadcrumb}
                    </div>
                  )}
                  <ScrollArea className={cn(SIDEBAR_LIST_PANEL_SCROLL, '[&>[data-radix-scroll-area-viewport]>div]:!block')}>
                    <div className="flex min-h-full min-w-0 w-full flex-col gap-0.5">
                      <div className="px-2.5 py-3 text-center text-body text-muted-foreground">
                        {hasActiveSearch
                          ? t('home.assetBrowser.searchNoResults', { defaultValue: '没有匹配的结果' })
                          : sharedOnly
                            ? t('home.source.sharedEmpty', { defaultValue: '还没有人把文档、表格或文件分享给你' })
                            : t('home.assetBrowser.allEmpty')}
                      </div>
                    </div>
                  </ScrollArea>
                  </div>
              ) : viewMode === 'list' ? (
                <div className={cn(SIDEBAR_LIST_PANEL, 'flex h-full w-full flex-col')}>
                  {mode === 'full' && (
                    <div className={SIDEBAR_LIST_PANEL_HEADER}>
                      {listPanelBreadcrumb}
                    </div>
                  )}
                  <ScrollArea className={cn(SIDEBAR_LIST_PANEL_SCROLL, '[&>[data-radix-scroll-area-viewport]>div]:!block')}>
                    <ResourceTableList
                      // 文档/多维表应用页需要带表头的完整列表（所有者、最近更新时间）
                      variant={isAppHomePage ? 'table' : 'sidebar'}
                      folders={sharedOnly ? [] : filteredVisibleChildFolders}
                      items={filteredDisplayResourceItems}
                      collectionsFlat={collectionsFlat}
                      rootFolderLabel={rootFolderLabel}
                      onItemClick={handleResourceItemClick}
                      onItemContextMenu={(e, item) => {
                        if (isForeignSharedItem(item)) return
                        contextMenu.handleContextMenu(e, item)
                      }}
                      onItemRename={contextMenu.handleRenameItem}
                      onItemDragStart={(e, item) => handleResourceDragStart(e, item)}
                      onItemDragEnd={handleResourceDragEnd}
                      isDeletingItem={(id) => (
                        contextMenu.isDeletingItem(id) || appHomeBatchDelete.isBusyId(id)
                      )}
                      selectionMode={appHomeBatchDelete.selectionMode}
                      selectedItemIds={appHomeBatchDelete.selectedIds}
                      onItemSelectionToggle={appHomeBatchDelete.toggleSelection}
                      isItemSelectable={appHomeBatchDelete.isSelectable}
                      onFolderClick={navigateBrowseFolder}
                      onFolderContextMenu={openFolderMenu}
                      onFolderDragStart={handleFolderDragStart}
                      onFolderDragEnd={handleFolderDragEnd}
                      onFolderDragOver={(event, coll) => {
                        event.stopPropagation()
                        handleFolderDragOver(event, coll)
                        handleDragOver(event, `coll:${coll.id}`)
                      }}
                      onFolderDragLeave={(event) => {
                        event.stopPropagation()
                        handleDragLeave()
                      }}
                      onFolderDrop={(event, coll) => {
                        event.stopPropagation()
                        if (
                          isFolderDragActive() ||
                          dataTransferHasType(event.dataTransfer, COLLECTION_FOLDER_MIME)
                        ) {
                          void handleFolderDrop(event, coll)
                          return
                        }
                        handleResourceDropTarget(event, coll.id)
                      }}
                      isFolderDropActive={(coll) => dragOverTarget === `coll:${coll.id}`}
                      draggingFolderId={draggingFolderId}
                    />
                  </ScrollArea>
                </div>
              ) : (
                <div className={cn(SIDEBAR_LIST_PANEL, 'flex h-full w-full flex-col')}>
                  {mode === 'full' && (
                    <div className={SIDEBAR_LIST_PANEL_HEADER}>
                      {listPanelBreadcrumb}
                    </div>
                  )}
                  <ScrollArea className={cn(SIDEBAR_LIST_PANEL_SCROLL, '[&>[data-radix-scroll-area-viewport]>div]:!block')}>
                    <div className="grid gap-3" style={{ gridTemplateColumns: resourceGridTemplateColumns() }}>
                      {!sharedOnly && filteredVisibleChildFolders.map(renderFolderGridCard)}
                      {filteredDisplayResourceItems.map(item => {
                        const foreignShared = isForeignSharedItem(item)
                        const isFromOther = !foreignShared
                          && isCrossSpaceScopedItem(effectiveResourceScope, spaceId, item.space_id)
                        const batchBusy = appHomeBatchDelete.isBusy(item)
                        const isDeleting = contextMenu.isDeletingItem(item.id) || batchBusy
                        const selectable = appHomeBatchDelete.isSelectable(item)
                        const selected = appHomeBatchDelete.isSelected(item)
                        const canDrag = !isDeleting
                          && !foreignShared
                          && !appHomeBatchDelete.selectionMode
                          && isMovableContextItemId(item.id)
                        const dragBlockReason = canDrag
                          ? null
                          : getResourceDragBlockReason(item, {
                            foreignShared,
                            deleting: isDeleting,
                            batchMode: appHomeBatchDelete.selectionMode,
                          })
                        const sharedName = foreignShared ? getSharedByName(item) : ''
                        return (
                          <div
                            key={item.id || item.resource_id}
                            className={cn(
                              'relative',
                              appHomeBatchDelete.selectionMode && !selectable && 'opacity-60',
                            )}
                            draggable={canDrag}
                            onPointerDown={dragBlockReason
                              ? () => logResourceDragBlocked(item, dragBlockReason, { surface: 'ContextHome.grid' })
                              : undefined}
                            onDragStart={canDrag ? event => handleResourceDragStart(event, item) : undefined}
                            onDragEnd={canDrag ? handleResourceDragEnd : undefined}
                          >
                            {appHomeBatchDelete.selectionMode && (
                              <input
                                type="checkbox"
                                className="absolute left-2 top-2 z-floating h-4 w-4 rounded border-border bg-background text-primary shadow-sm focus:ring-primary/30"
                                aria-label={t('home.assetBrowser.selectResource', {
                                  title: item.title || item.resource_id,
                                  defaultValue: '选择 {{title}}',
                                })}
                                checked={selected}
                                disabled={!selectable || batchBusy}
                                onChange={() => appHomeBatchDelete.toggleSelection(item)}
                              />
                            )}
                            <ResourceGridCard
                              item={item}
                              onClick={appHomeBatchDelete.selectionMode
                                ? (selectable ? () => appHomeBatchDelete.toggleSelection(item) : undefined)
                                : () => handleResourceItemClick(item)}
                              onContextMenu={appHomeBatchDelete.selectionMode || foreignShared
                                ? undefined
                                : (e) => contextMenu.handleContextMenu(e, item)}
                              className={cn(selected && 'ring-2 ring-primary/45')}
                              spaceName={foreignShared
                                ? (sharedName
                                  ? t('home.table.sharedByLocation', { name: sharedName, defaultValue: '由 {{name}} 分享' })
                                  : t('home.table.sharedByLocationUnknown', { defaultValue: '他人分享' }))
                                : (isFromOther ? (item.space_name || null) : undefined)}
                              isBusy={isDeleting}
                              busyLabel={t('home.deleting', { defaultValue: 'Deleting...' })}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </ScrollArea>
                </div>
              )}
            </div>

          </div>

        </div>
      </div>
      </div>

      <ResourceContextMenuOverlay
        spaceId={spaceId}
        menuState={contextMenu.menuState}
        onClose={contextMenu.closeMenu}
        onTogglePin={contextMenu.handleTogglePin}
        onMoveToCollection={contextMenu.handleMoveToCollection}
        onRename={contextMenu.handleRename}
        onArchive={contextMenu.handleArchive}
        folderConfirm={folderConfirm}
      />

      {renderCollectionFolderMenuLayer()}

      {floatingCapabilityBanner}
    </div>
  )
}
