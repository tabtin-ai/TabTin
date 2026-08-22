/**
 * CloudResourcesHome — 云盘管理起始页
 *
 * 专为云资源（表格/文档/演示/视频/记忆/文件）设计的管理页面。
 * 与通用 ContextHome 不同：只展示云文档类型的创建入口 + 文件夹创建管理。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Plus, FolderPlus, LayoutList, LayoutGrid, Loader2,
  Link, Link2, Folder, ListChecks, FolderInput, FolderUp, FileInput, Trash2, X, Search,
} from 'lucide-react'
import {
  Button,
  ConfirmDialog,
  Input,
  ScrollArea,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  toast,
} from '@components/ui'
import { useTranslation } from 'react-i18next'

import {
  useSharedContextItems,
  isForeignSharedItem,
  openForeignSharedItem,
  getSharedByName,
} from '../../hooks/useSharedContextItems'
import { CloudDocsListLoadError } from '@components/layout/cloud-docs/CloudDocsListLoadError'

import {
  useUnifiedResources,
  EMPTY_RESOURCES,
  getResourceCacheKey,
  healUnsyncedContextItems,
  isUnsyncedContextItemId,
} from '@/stores/useUnifiedResources'
import {
  useCollections,
  useCollectionsByOrganization,
  useFolderBreadcrumb,
  getCollectionChildrenSorted,
  flattenCollections,
} from '@/stores/useCollections'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useLocalContextItems } from '../../hooks/useLocalContextItems'
import { useRemoveFolderConfirm } from '../../hooks/useRemoveFolderConfirm'
import { useResourceContextMenu, ResourceContextMenuOverlay } from '../../ResourceContextMenu'
import { useOptionalSpaceContextActions } from '../../SpaceContextAreaContext'
import { contextRegistry } from '../index'
import { isUserVisibleTabdataResourceItem } from '../../resourceScope'

import { HomeGridCard, getTypeGradient } from './HomeGridCard'
import type { HomeViewMode } from './HomeGridCard'
import { ResourceGridCard } from './ResourceGridCard'
import { ResourceTableList } from './ResourceTableList'
import { isBatchDeletableResource, isBatchMovableResource } from './resourceBatchDelete'
import { ResourceCollectionSkeleton } from '@components/common/ListSkeletons'
import type { SpaceCollection } from '@/services/spaceApi'
import type { SpaceContextItem } from '@/services/spaceApi'
import type { HomeSectionHandler, HomeSectionProps } from '../types'
import { cn } from '@utils/cn'
import { CANVAS_TEXT_META } from '@components/layout/canvasUi'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { useInlineEdit } from '../../hooks/useInlineEdit'
import {
  COLLECTION_FOLDER_MIME,
  COLLECTION_ITEM_MIME,
  buildCollectionDragItem,
  dataTransferHasType,
  isMovableContextItemId,
  useCollectionDnD,
  type CollectionDragItem,
} from '../../hooks/useCollectionDnD'
import {
  getResourceDragBlockReason,
  logResourceDragBlocked,
} from '../../hooks/resourceDragDiagnostics'
import { createLogger } from '@/utils/logger'
import { useCollectionFolderMenu } from '../../hooks/useCollectionFolderMenu'
import { ContextPageHeader } from '../../ContextPageHeader'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { ContextPageToolbar } from '../../ContextPageToolbar'
import { ContextPageToolbarIconButton } from '../../ContextPageToolbarIconButton'
import { ContextPageToolbarImportButton } from '../../ContextPageToolbarImportButton'
import { ContextListPanelBreadcrumb } from '../../ContextListPanelBreadcrumb'
import { CollectionMovePickerOverlay } from '../../CollectionMovePickerOverlay'
import {
  buildSpaceItemChatContextDragPayload,
  writeChatContextDragPayload,
} from '../../hooks/chatContextDragPayload'
import { setResourceDragPreview } from '../../hooks/resourceDragPreview'
import { createCloudResourceInFolder } from './createCloudResourceInFolder'
import { resolveCloudResourceEmoji } from './resolveCloudResourceIcon'
import type { CreateResourceHandler, CreateResourceOptions } from '../../hooks/useCreateHandlers'
import {
  CONTEXT_PAGE_SHELL_FILL,
  CONTEXT_PAGE_TOOLBAR_BTN,
  RESOURCE_GRID_MIN_CARD_WIDTH,
  resourceGridTemplateColumns,
} from '../../constants'
import { filterFoldersBySearch, filterResourcesBySearch, selectResourceSearchScope } from '../../resourceListSearch'
import { CLOUD_FILE_RESOURCE_TYPES } from '../../cloudResourceTypes'
import {
  SIDEBAR_EMBEDDED_CONTROL_INSET,
  SIDEBAR_ICON,
  SIDEBAR_ICON_STROKE,
  SIDEBAR_LIST_PANEL,
  SIDEBAR_LIST_PANEL_HEADER,
  SIDEBAR_LIST_PANEL_SCROLL,
  SIDEBAR_ROW,
  SIDEBAR_ROW_FULL_WIDTH,
  SIDEBAR_SCROLLBAR_TYPE,
} from '@components/layout/sidebarUi'
import { SpaceApiService } from '@/services/spaceApi'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { useResourceFileImport } from '../../useResourceFileImport'
import { CLOUD_DOCS_SHOW_DRIVE, TABSLIDE_UI_ENABLED } from '@/utils/featureFlags'
import { isCloudDocsScopeKey } from '@components/layout/cloudDocsDomain'
import type { CloudDocsBrowseView } from '@components/layout/cloudDocsOpenTabs'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  forceRefreshOrganizationCollections,
  shouldForceCloudFolderRefreshOnActivate,
} from './cloudFolderRefresh'
import { selectCloudResourcesDisplayItems } from './selectCloudResourcesDisplayItems'
import { resolveCloudDriveBrowseFolderId } from './cloudDriveFolderState'
import { FeishuImportDialog } from '../../feishu/FeishuImportDialog'
import { moveSharedResourcePlacement } from '@/services/sharedResourcesApi'
import { useEffectiveFeature } from '@/hooks/useEffectiveFeature'
// ：TabSlide App UI 隐藏期间，云盘不列出 / 不筛选 / 不快捷创建 tabslide 资源。
// ：云盘不再列出 / 筛选 / 快捷创建 tabmemo（碎片），碎片笔记走独立入口。
// ：云盘不列出本机 tabfolder（执行根如「默认 Space」）；本机目录走 TabFolder / 画布入口。
const CLOUD_RESOURCE_TYPES = new Set([
  'tabdata',
  'tabdoc',
  ...(TABSLIDE_UI_ENABLED ? ['tabslide'] : []),
  ...CLOUD_FILE_RESOURCE_TYPES,
])

/**
 * 云文档一级域：文档 + 表格 + 普通文件；文件夹组织走 SpaceCollection，不含本机 tabfolder。
 * ：云文档支持普通文件，'file' 为前端归一化类型，'tabfiles' 为后端 item_type，两者都显式列出以防御未归一化的原始类型误判。
 * ：常量仍含 file/tabfiles（能力保留）；实际过滤见 getActiveCloudDocsDomainTypes()。
 */
const CLOUD_DOCS_DOMAIN_TYPES = new Set(['tabdata', 'tabdoc', 'file', 'tabfiles'])

/** 「文件」类型筛选：只认普通云文件，不含本机 tabfolder（云盘 / 云文档域一致，）。 */
const CLOUD_DOCS_FILE_TYPES = new Set(['file', 'tabfiles'])

/** ：开关关闭时侧栏/域列表不展示普通文件（分享面另走 shared 路径）。 */
function getActiveCloudDocsDomainTypes(): Set<string> {
  if (CLOUD_DOCS_SHOW_DRIVE) return CLOUD_DOCS_DOMAIN_TYPES
  return new Set(['tabdata', 'tabdoc'])
}

export type CloudResourcesPresentation = 'default' | 'cloud-docs-domain'
export type CloudResourcesLayout = 'canvas' | 'sidebar'

export type CloudResourcesHomeProps = HomeSectionProps & {
  presentation?: CloudResourcesPresentation
  layout?: CloudResourcesLayout
  /** 云文档侧栏浏览分段（全部 / 最近 / 分享给我） */
  browseView?: CloudDocsBrowseView
}

const IconButtonTooltip: React.FC<{
  content: React.ReactNode
  children: React.ReactElement
}> = ({ content, children }) => (
  <TooltipProvider delayDuration={200}>
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom">{content}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
)

type CloudTypeFilter = 'all' | 'tabdata' | 'tabdoc' | 'tabslide' | 'tabfiles'

/** 云盘（default）呈现：始终含普通文件筛选；不含「视频」分段。 */
const TYPE_FILTER_BUTTONS: CloudTypeFilter[] = [
  'all', 'tabdata', 'tabdoc',
  ...(TABSLIDE_UI_ENABLED ? ['tabslide' as const] : []),
  'tabfiles',
]

const TYPE_FILTER_LABELS: Record<CloudTypeFilter, string> = {
  all: 'home.assetBrowser.typeFilterAll',
  tabdata: 'home.assetBrowser.typeFilterTable',
  tabdoc: 'home.assetBrowser.typeFilterDocument',
  tabslide: 'home.assetBrowser.typeFilterSlide',
  tabfiles: 'home.assetBrowser.typeFilterFiles',
}

/** 云盘新建菜单：不含视频、不含碎片 */
const CLOUD_QUICK_ACTION_TYPES = new Set([
  'tabdata', 'tabdoc',
  ...(TABSLIDE_UI_ENABLED ? ['tabslide'] : []),
])

/** DropdownMenu hover：打开略延迟避免路过误触，关闭保留缓冲避免移入内容时闪退 */
const CREATE_MENU_OPEN_DELAY_MS = 180
const CREATE_MENU_CLOSE_DELAY_MS = 220

const log = createLogger('CloudResourcesDnD')

const EMPTY_CREATE_HANDLERS: Record<string, CreateResourceHandler> = {}

const VIEW_MODE_KEY = 'tabtin:cloudResources:viewMode'

function loadViewMode(): HomeViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'grid' ? 'grid' : 'list'
  } catch { return 'list' }
}

function saveViewMode(mode: HomeViewMode) {
  try { localStorage.setItem(VIEW_MODE_KEY, mode) } catch { /* noop */ }
}

function matchesCloudTypeFilter(
  itemType: string | null | undefined,
  filter: CloudTypeFilter,
  presentation: CloudResourcesPresentation = 'default',
): boolean {
  if (filter === 'all') return true
  const t = contextRegistry.normalizeBackendType(itemType ?? '')
  if (filter === 'tabfiles') {
    if (!CLOUD_DOCS_SHOW_DRIVE && presentation === 'cloud-docs-domain') return false
    // 云盘 / 云文档「文件」筛选均不含本机 tabfolder。
    return presentation === 'cloud-docs-domain'
      ? CLOUD_DOCS_FILE_TYPES.has(t)
      : CLOUD_FILE_RESOURCE_TYPES.has(t)
  }
  return t === filter
}

function isCloudResource(
  itemType: string | null | undefined,
  presentation: CloudResourcesPresentation = 'default',
): boolean {
  const t = contextRegistry.normalizeBackendType(itemType ?? '')
  if (presentation === 'cloud-docs-domain') {
    return getActiveCloudDocsDomainTypes().has(t)
  }
  return CLOUD_RESOURCE_TYPES.has(t)
}

// ---------------------------------------------------------------------------

const CloudResourcesHome: React.FC<CloudResourcesHomeProps> = ({
  spaceId,
  tabScopeKey,
  presentation: presentationProp,
  layout = 'canvas',
  browseView = 'all',
  onCreateResource: onCreateResourceProp,
  onSearchNavigate: onSearchNavigateProp,
}) => {
  const { t } = useTranslation('context')
  const currentUserId = useAuthStore(state => state.user?.id != null ? String(state.user.id) : '')
  const contextActions = useOptionalSpaceContextActions()
  const resolvedPresentation: CloudResourcesPresentation =
    presentationProp
    ?? (isCloudDocsScopeKey(tabScopeKey) ? 'cloud-docs-domain' : 'default')
  const isCloudDocsDomain = resolvedPresentation === 'cloud-docs-domain'
  const isSidebarLayout = layout === 'sidebar'
  const sidebarBrowseView = isSidebarLayout && isCloudDocsDomain ? browseView : 'all'
  const isRecentBrowse = sidebarBrowseView === 'recent'

  const cloudDocsActiveTabKey = useSpaceContextTabsStore(state =>
    tabScopeKey ? (state.activeKeyBySpace[tabScopeKey] ?? null) : null,
  )
  const createHandlersFromContext = contextActions?.createHandlers ?? EMPTY_CREATE_HANDLERS
  const createHandlersFromProp = useMemo(() => {
    if (!onCreateResourceProp) return EMPTY_CREATE_HANDLERS
    const wrap = (appId: string): CreateResourceHandler => (options?: CreateResourceOptions) => {
      onCreateResourceProp(appId, options)
    }
    return {
      tabdoc: wrap('tabdoc'),
      tabdata: wrap('tabdata'),
    } satisfies Record<string, CreateResourceHandler>
  }, [onCreateResourceProp])
  const createHandlers = useMemo(
    () => ({ ...createHandlersFromProp, ...createHandlersFromContext }),
    [createHandlersFromContext, createHandlersFromProp],
  )
  const onSearchNavigate = onSearchNavigateProp ?? contextActions?.onSearchNavigate
  const organizationId = useSpaceStore(
    state => state.spaces.find(space => space.id === spaceId)?.organization_id ?? null,
  )
  const feishuImportEnabled = useEffectiveFeature('feishu_import', organizationId).enabled

  // ── Folder state（仅云盘 default；云文档域走 ContextItem.parent，与 Collection 解耦）──
  // ：云盘固定组织级视图，文件夹只用 Organization Collection。
  // organizationId 未就绪时不回落 Space Collection，避免与 organization 资源桶短暂错位。
  const driveOrganizationId = isCloudDocsDomain ? null : organizationId
  const { collections } = useCollectionsByOrganization(driveOrganizationId)
  const browseFolderId = useSpaceViewPrefsStore(state =>
    driveOrganizationId
      ? state.cloudDriveBrowseFolderIdByOrganization[driveOrganizationId] ?? null
      : null,
  )
  const setCloudDriveBrowseFolderId = useSpaceViewPrefsStore(
    state => state.setCloudDriveBrowseFolderId,
  )
  const setBrowseFolderId = useCallback((folderId: string | null) => {
    if (driveOrganizationId) setCloudDriveBrowseFolderId(driveOrganizationId, folderId)
  }, [driveOrganizationId, setCloudDriveBrowseFolderId])
  const hasLoadedOrganizationCollections = useCollections(state =>
    driveOrganizationId
      ? Object.prototype.hasOwnProperty.call(
        state.collectionsByOrganizationId,
        driveOrganizationId,
      )
      : false,
  )

  const loadOrganizationCollections = useCollections(s => s.loadOrganization)
  useEffect(() => {
    // 云文档列表本身不按 Collection 分组，但共享资源的右键菜单仍需
    // 使用组织级文件夹，否则收件人无法把资源移动到自己的文件夹。
    if (!organizationId) return
    void loadOrganizationCollections(organizationId)
  }, [organizationId, loadOrganizationCollections])

  // ：进入云盘活动页时强制补拉 Organization Collection（绕过非空缓存早退）
  const cloudDriveTabScopeKey = tabScopeKey || spaceId
  const isCloudDriveTabActive = useSpaceContextTabsStore(state => {
    if (isCloudDocsDomain || !cloudDriveTabScopeKey) return false
    return state.activeKeyBySpace[cloudDriveTabScopeKey] === 'apphome:cloud-resources'
  })
  const wasCloudDriveTabActiveRef = useRef(false)
  useEffect(() => {
    if (!driveOrganizationId) {
      wasCloudDriveTabActiveRef.current = isCloudDriveTabActive
      return
    }
    if (shouldForceCloudFolderRefreshOnActivate(
      wasCloudDriveTabActiveRef.current,
      isCloudDriveTabActive,
    )) {
      void forceRefreshOrganizationCollections(driveOrganizationId, 'activate')
    }
    wasCloudDriveTabActiveRef.current = isCloudDriveTabActive
  }, [driveOrganizationId, isCloudDriveTabActive])

  const folderBreadcrumb = useFolderBreadcrumb(
    browseFolderId, collections, t('home.assetBrowser.rootFolder'),
  )
  const childFolders = useMemo(
    () => getCollectionChildrenSorted(collections, browseFolderId),
    [collections, browseFolderId],
  )
  const collectionsFlat = useMemo(() => flattenCollections(collections), [collections])

  useEffect(() => {
    const restoredFolderId = resolveCloudDriveBrowseFolderId(
      browseFolderId,
      collectionsFlat,
      hasLoadedOrganizationCollections,
    )
    if (restoredFolderId === browseFolderId) return
    log.warn('stored cloud drive folder is unavailable; falling back to root', {
      organizationId: driveOrganizationId,
      folderId: browseFolderId,
    })
    setBrowseFolderId(restoredFolderId)
  }, [
    browseFolderId,
    collectionsFlat,
    driveOrganizationId,
    hasLoadedOrganizationCollections,
    setBrowseFolderId,
  ])

  // ── View & filter state ──
  const [viewMode, setViewMode] = useState<HomeViewMode>(loadViewMode)
  const toggleViewMode = useCallback(() => {
    setViewMode(prev => {
      const next = prev === 'list' ? 'grid' : 'list'
      saveViewMode(next)
      return next
    })
  }, [])

  const [activeTypeFilter, setActiveTypeFilter] = useState<CloudTypeFilter>('all')
  const [searchQuery, setSearchQuery] = useState('')

  // ── Resources（云盘固定团队级视图，不再提供「仅当前 Space」切换）──
  const loadResources = useUnifiedResources(s => s.load)
  useEffect(() => {
    void loadResources(spaceId, true, 'organization')
  }, [spaceId, loadResources])

  const organizationCacheKey = getResourceCacheKey(spaceId, 'organization') ?? `${spaceId}:organization`
  const hasOrganizationBucket = useUnifiedResources(
    s => Object.prototype.hasOwnProperty.call(s.resourcesBySpaceId, organizationCacheKey),
  )
  const organizationResources = useUnifiedResources(
    s => s.resourcesBySpaceId[organizationCacheKey] ?? EMPTY_RESOURCES,
  )
  const resources = organizationResources
  const isResourcesLoading = useUnifiedResources(s =>
    Boolean(s.loadingBySpaceId[organizationCacheKey]),
  ) || !hasOrganizationBucket
  const resourcesError = useUnifiedResources(s =>
    s.errorBySpaceId[organizationCacheKey] ?? null,
  )
  const retryResourcesLoad = useCallback(() => {
    void loadResources(spaceId, true, 'organization')
  }, [loadResources, spaceId])
  const refreshAfterImport = useCallback(() => {
    void loadResources(spaceId, true, 'organization')
    // 导入接口完成与资源索引/WS 入列可能存在短暂延迟，补两次轻量刷新，
    // 确保成功提示出现后当前云盘列表最终能看到新资源。
    window.setTimeout(() => void loadResources(spaceId, true, 'organization'), 500)
    window.setTimeout(() => void loadResources(spaceId, true, 'organization'), 1500)
    // ：云文档域不刷新 Space Collection；组织级 Collection 供共享资源菜单使用
    if (!isCloudDocsDomain) {
      void useCollections.getState().load(spaceId, true)
      if (organizationId) void useCollections.getState().loadOrganization(organizationId, true)
    }
  }, [isCloudDocsDomain, loadResources, organizationId, spaceId])
  const importFileInputRef = useRef<HTMLInputElement>(null)
  const importFolderInputRef = useRef<HTMLInputElement>(null)
  const { importFile, importFolder, importingAppId, importingKind } = useResourceFileImport({
    spaceId,
    organizationId: organizationId ?? undefined,
    collectionId: browseFolderId,
    tabScopeKey: tabScopeKey ?? resolveForegroundTabScopeKey(spaceId),
    onImported: refreshAfterImport,
  })
  const isImporting = importingAppId !== null
  const isImportingFile = importingKind === 'file'
  const isImportingFolder = importingKind === 'folder'
  const handleImportFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) await importFile(file)
    event.target.value = ''
  }, [importFile])
  const handleImportFolder = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files
    if (files && files.length > 0) await importFolder(files)
    event.target.value = ''
  }, [importFolder])
  const localItems = useLocalContextItems(spaceId)

  const allCloudItems = useMemo(() => {
    const cloudItems = resources.filter(r => {
      if (r.is_archived) return false
      if (!isUserVisibleTabdataResourceItem(r)) return false
      if (!isCloudResource(r.item_type, resolvedPresentation)) return false
      return true
    })
    return [...cloudItems, ...localItems.filter(l => isCloudResource(l.item_type, resolvedPresentation))]
      .sort((a, b) => {
        const ap = a.is_pinned ? 1 : 0
        const bp = b.is_pinned ? 1 : 0
        if (ap !== bp) return bp - ap
        const da = a.updated_at ? new Date(a.updated_at).getTime() : 0
        const db = b.updated_at ? new Date(b.updated_at).getTime() : 0
        return db - da
      })
  }, [resources, localItems, resolvedPresentation])

  // 空 id 乐观项滞留自愈：等首轮 WS schedule（~650ms）结束后再判，限流 5s，避免 cleanup 打空枪
  const lastUnsyncedHealAtRef = useRef(0)
  useEffect(() => {
    const emptyCount = organizationResources.filter(r => isUnsyncedContextItemId(r.id)).length
    if (emptyCount === 0) return
    const timer = setTimeout(() => {
      const stillEmpty = useUnifiedResources.getState()
        .resourcesBySpaceId[organizationCacheKey]
        ?.filter(r => isUnsyncedContextItemId(r.id)).length ?? 0
      if (stillEmpty === 0) return
      const now = Date.now()
      if (now - lastUnsyncedHealAtRef.current < 5000) return
      lastUnsyncedHealAtRef.current = now
      const buckets = healUnsyncedContextItems(spaceId)
      if (buckets > 0) {
        log.warn('cloud drive empty-id heal triggered from UI', {
          spaceId,
          emptyCount: stillEmpty,
          buckets,
        })
      }
    }, 2800)
    return () => clearTimeout(timer)
  }, [organizationCacheKey, organizationResources, spaceId])

  // ── 「分享给我」独立资源投影：位置列使用权限裁剪后的原目录，宫格徽标保留分享者 ──
  const showSharedPref = useSpaceViewPrefsStore(s => s.getPrefs(spaceId).cloudSharedViewOpen ?? false)
  const setCloudSharedViewOpen = useSpaceViewPrefsStore(s => s.setCloudSharedViewOpen)
  const showShared = isSidebarLayout && isCloudDocsDomain
    ? sidebarBrowseView === 'shared'
    : showSharedPref
  const {
    items: sharedItems,
    dismissedResourceKeys,
    loading: sharedLoading,
    error: sharedError,
    reload: reloadSharedItems,
  } = useSharedContextItems(spaceId)

  // ：分享项始终保留 foreignShared 元数据；「分享给我」筛选直接用 sharedItems，
  // 不再按 allCloudItems.resource_id 盲去重（旧逻辑在组织全量列表泄漏时会把真实分享滤空）。
  const sharedCloudItems = useMemo(() => {
    const validCollectionIds = new Set(collectionsFlat.map(collection => collection.id))
    return sharedItems
      .filter(s => isCloudResource(s.item_type, resolvedPresentation))
      .map(item => {
        // placement 可能指向已删除/不可见的收件人文件夹；不能因此把分享资源从“全部”列表吞掉。
        // 归位到根目录，用户仍可通过“移动到...”重新选择当前可见文件夹。
        if (item.collection_id && !validCollectionIds.has(item.collection_id)) {
          return { ...item, collection_id: null }
        }
        return item
      })
  }, [collectionsFlat, resolvedPresentation, sharedItems])

  const isOwnedCloudDocsItem = useCallback((item: SpaceContextItem) => {
    if (!isCloudDocsDomain) return true
    if (isUnsyncedContextItemId(item.id)) return true
    const ownerId = item.owner_id ?? item.owner?.id ?? item.created_by_id ?? item.created_by?.id
    return Boolean(currentUserId && ownerId && String(ownerId) === currentUserId)
  }, [currentUserId, isCloudDocsDomain])

  // ：云文档域「全部」与单类型筛选同为扁平清单；云盘「全部」仍按 Collection 层级。
  const displayItems = useMemo(() => selectCloudResourcesDisplayItems({
    presentation: resolvedPresentation,
    activeTypeFilter,
    browseFolderId,
    allCloudItems,
    sharedCloudItems,
    hiddenSharedResourceIds: dismissedResourceKeys,
    showShared,
    isRecentBrowse,
    matchesTypeFilter: matchesCloudTypeFilter,
    isForeignSharedItem,
    isOwnedItem: isOwnedCloudDocsItem,
    isCloudResource,
  }), [activeTypeFilter, allCloudItems, browseFolderId, dismissedResourceKeys, isOwnedCloudDocsItem, isRecentBrowse, resolvedPresentation, sharedCloudItems, showShared])

  const hasActiveSearch = Boolean(searchQuery.trim())
  const searchableItems = useMemo(() => {
    const pool = showShared
      ? sharedCloudItems
      : isCloudDocsDomain
        ? allCloudItems.filter(isOwnedCloudDocsItem)
        : [...allCloudItems, ...sharedCloudItems]
    return pool.filter(i => matchesCloudTypeFilter(i.item_type, activeTypeFilter, resolvedPresentation))
  }, [activeTypeFilter, allCloudItems, isCloudDocsDomain, isOwnedCloudDocsItem, resolvedPresentation, sharedCloudItems, showShared])
  const resourceSearchScope = useMemo(
    () => selectResourceSearchScope(displayItems, searchableItems, searchQuery),
    [displayItems, searchableItems, searchQuery],
  )
  // Collection 文件夹只在「全部」视图展示；筛表格/文档/文件时隐藏，避免串台。
  const folderSearchScope = useMemo(
    () => (showShared || isRecentBrowse || activeTypeFilter !== 'all')
      ? []
      : selectResourceSearchScope(childFolders, collectionsFlat, searchQuery),
    [activeTypeFilter, childFolders, collectionsFlat, isRecentBrowse, searchQuery, showShared],
  )
  const filteredDisplayItems = useMemo(
    () => filterResourcesBySearch(resourceSearchScope, searchQuery),
    [resourceSearchScope, searchQuery],
  )
  const filteredChildFolders = useMemo(
    () => filterFoldersBySearch(folderSearchScope, searchQuery),
    [folderSearchScope, searchQuery],
  )

  // ── Batch actions（只处理当前 Space 可操作的资源，分享/本地产物不进入批量选择）──
  const [batchMode, setBatchMode] = useState(false)
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<string>>(() => new Set())
  const [batchBusyIds, setBatchBusyIds] = useState<Set<string>>(() => new Set())
  const [batchMovePicker, setBatchMovePicker] = useState<{
    open: boolean
    pos: { x: number; y: number }
  }>({ open: false, pos: { x: 0, y: 0 } })
  const [batchDeleteConfirmOpen, setBatchDeleteConfirmOpen] = useState(false)

  const isBatchSelectableItem = useCallback((item: SpaceContextItem) => (
    isBatchMovableResource(item) || isBatchDeletableResource(item)
  ), [])

  const selectedBatchItems = useMemo(
    () => allCloudItems.filter(item => selectedBatchIds.has(item.id) && isBatchSelectableItem(item)),
    [allCloudItems, isBatchSelectableItem, selectedBatchIds],
  )
  const selectedBatchCount = selectedBatchItems.length
  const selectedBatchCanMove = selectedBatchCount > 0
    && selectedBatchItems.every(isBatchMovableResource)
  const selectedBatchCanDelete = selectedBatchCount > 0
    && selectedBatchItems.every(isBatchDeletableResource)
  const selectedBatchIdsForList = useMemo(() => new Set(selectedBatchItems.map(item => item.id)), [selectedBatchItems])
  const hasVisibleBatchSelectableItems = useMemo(
    () => filteredDisplayItems.some(item => isBatchSelectableItem(item) && !batchBusyIds.has(item.id)),
    [batchBusyIds, filteredDisplayItems, isBatchSelectableItem],
  )

  useEffect(() => {
    if (!batchMode) setSelectedBatchIds(new Set())
  }, [batchMode])

  useEffect(() => {
    if (!batchMode) return
    setSelectedBatchIds(new Set())
  }, [activeTypeFilter, batchMode, browseFolderId, showShared, spaceId])

  const toggleBatchMode = useCallback(() => {
    setBatchMode(prev => !prev)
    setBatchMovePicker({ open: false, pos: { x: 0, y: 0 } })
    setBatchDeleteConfirmOpen(false)
  }, [])

  const toggleBatchSelection = useCallback((item: SpaceContextItem) => {
    if (!isBatchSelectableItem(item) || batchBusyIds.has(item.id)) return
    setSelectedBatchIds(prev => {
      const next = new Set(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }, [batchBusyIds, isBatchSelectableItem])

  // ── Folder creation ──
  const { createOrganizationCollection } = useCollections.getState()
  const inlineEdit = useInlineEdit()

  const startCreateFolder = useCallback(() => {
    inlineEdit.start('', undefined, { type: 'folder' })
  }, [inlineEdit])

  // ：云盘/云文档新建文件夹只建 Organization Collection；无 organizationId 时拒绝，避免挂回 Space。
  const onCommitFolder = useCallback(async (value: string) => {
    if (!value.trim()) return
    if (!organizationId) {
      toast.error(t('createError.noOrganizationDesc', {
        defaultValue: '当前空间未关联组织，无法创建云端文件夹',
      }))
      return
    }
    await createOrganizationCollection(organizationId, value.trim(), '📁', browseFolderId ?? undefined)
  }, [createOrganizationCollection, browseFolderId, organizationId, t])

  // ── Quick actions (cloud types only) ──
  const cloudQuickActions = useMemo(
    () => contextRegistry.getQuickActions().filter(h => {
      const appId = h.appId ?? (h.type as string)
      if (isCloudDocsDomain) return appId === 'tabdata' || appId === 'tabdoc'
      return CLOUD_QUICK_ACTION_TYPES.has(appId)
    }),
    [isCloudDocsDomain],
  )
  const [createMenuOpen, setCreateMenuOpen] = useState(false)
  const [feishuImportOpen, setFeishuImportOpen] = useState(false)
  const createMenuOpenRef = useRef(false)
  const createMenuHoveringRef = useRef(false)
  const createMenuOpenTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createMenuCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const createFolderStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearCreateMenuTimers = useCallback(() => {
    if (createMenuOpenTimerRef.current != null) {
      clearTimeout(createMenuOpenTimerRef.current)
      createMenuOpenTimerRef.current = null
    }
    if (createMenuCloseTimerRef.current != null) {
      clearTimeout(createMenuCloseTimerRef.current)
      createMenuCloseTimerRef.current = null
    }
  }, [])

  const setCreateMenuOpenSafe = useCallback((open: boolean) => {
    createMenuOpenRef.current = open
    setCreateMenuOpen(open)
  }, [])

  const scheduleOpenCreateMenu = useCallback(() => {
    createMenuHoveringRef.current = true
    // 取消待关闭；已打开则不要反复 setState，避免闪烁
    if (createMenuCloseTimerRef.current != null) {
      clearTimeout(createMenuCloseTimerRef.current)
      createMenuCloseTimerRef.current = null
    }
    if (createMenuOpenRef.current || createMenuOpenTimerRef.current != null) return
    createMenuOpenTimerRef.current = setTimeout(() => {
      createMenuOpenTimerRef.current = null
      if (!createMenuHoveringRef.current) return
      setCreateMenuOpenSafe(true)
    }, CREATE_MENU_OPEN_DELAY_MS)
  }, [setCreateMenuOpenSafe])

  const scheduleCloseCreateMenu = useCallback(() => {
    createMenuHoveringRef.current = false
    if (createMenuOpenTimerRef.current != null) {
      clearTimeout(createMenuOpenTimerRef.current)
      createMenuOpenTimerRef.current = null
    }
    if (createMenuCloseTimerRef.current != null) return
    createMenuCloseTimerRef.current = setTimeout(() => {
      createMenuCloseTimerRef.current = null
      // 仍在 trigger/content 上则不关（modal 层误触 leave 时靠此稳住）
      if (createMenuHoveringRef.current) return
      setCreateMenuOpenSafe(false)
    }, CREATE_MENU_CLOSE_DELAY_MS)
  }, [setCreateMenuOpenSafe])

  const keepCreateMenuOpen = useCallback(() => {
    createMenuHoveringRef.current = true
    if (createMenuCloseTimerRef.current != null) {
      clearTimeout(createMenuCloseTimerRef.current)
      createMenuCloseTimerRef.current = null
    }
    if (!createMenuOpenRef.current) setCreateMenuOpenSafe(true)
  }, [setCreateMenuOpenSafe])

  const openCreateMenuOnClick = useCallback(() => {
    clearCreateMenuTimers()
    createMenuHoveringRef.current = true
    setCreateMenuOpenSafe(true)
  }, [clearCreateMenuTimers, setCreateMenuOpenSafe])

  const startCreateFolderAfterMenuClose = useCallback(() => {
    clearCreateMenuTimers()
    setCreateMenuOpenSafe(false)
    if (createFolderStartTimerRef.current != null) {
      clearTimeout(createFolderStartTimerRef.current)
    }
    // ：Radix 关闭菜单时会完成一轮焦点收尾；若此时同步挂载并聚焦输入框，
    // Electron 下可能立刻收到 blur，空值提交随即清掉编辑态，表现为输入行闪一下消失。
    createFolderStartTimerRef.current = setTimeout(() => {
      createFolderStartTimerRef.current = null
      startCreateFolder()
    }, 0)
  }, [clearCreateMenuTimers, setCreateMenuOpenSafe, startCreateFolder])

  useEffect(() => () => {
    clearCreateMenuTimers()
    if (createFolderStartTimerRef.current != null) {
      clearTimeout(createFolderStartTimerRef.current)
    }
  }, [clearCreateMenuTimers])

  const typeFilterButtons: CloudTypeFilter[] = isCloudDocsDomain
    ? (CLOUD_DOCS_SHOW_DRIVE
        ? ['all', 'tabdata', 'tabdoc', 'tabfiles']
        : ['all', 'tabdata', 'tabdoc'])
    : TYPE_FILTER_BUTTONS

  const pageTitle = isCloudDocsDomain
    ? t('home.cloudDocs', { defaultValue: '云文档' })
    : t('home.cloudDrive', { defaultValue: '云盘' })
  const pageSubtitle = isCloudDocsDomain
    ? t('home.cloudDocsSubtitle', { defaultValue: '集中管理组织内的文档、表格与文件' })
    : t('home.cloudDriveSubtitle', { defaultValue: '集中管理组织内的文档、表格与文件' })
  const newFolderLabel = t('home.assetBrowser.newFolder', { defaultValue: '新建文件夹' })
  const createActionLabel = t('home.assetBrowser.createAction', { defaultValue: '新建' })
  const externalResourcesLabel = t('home.assetBrowser.externalResources', { defaultValue: '外部资源' })
  const feishuLabel = t('home.assetBrowser.feishu', { defaultValue: '飞书' })
  const importFolderLabel = t('home.assetBrowser.importFolderAction', { defaultValue: '上传文件夹' })
  const batchActionLabel = t('home.assetBrowser.batchAction', { defaultValue: '批量操作' })
  const batchCancelLabel = t('home.assetBrowser.batchCancel', { defaultValue: '取消' })
  const batchMoveLabel = t('home.assetBrowser.batchMove', { defaultValue: '移动' })

  const batchDeleteLabel = t('home.assetBrowser.batchDelete', { defaultValue: '删除' })
  const batchSelectedCountLabel = t('home.assetBrowser.batchSelectedCount', {
    count: selectedBatchCount,
    defaultValue: '已选 {{count}} 项',
  })
  const sharedWithMeLabel = t('home.source.shared', { defaultValue: '分享给我' })
  const viewModeToggleLabel = viewMode === 'list'
    ? t('home.assetBrowser.switchToGridView', { defaultValue: '切换到宫格视图' })
    : t('home.assetBrowser.switchToListView', { defaultValue: '切换到列表视图' })

  const cloudToolbarTrailing = (
    <>
      <IconButtonTooltip content={sharedWithMeLabel}>
        <Button
          type="button"
          variant={showShared ? 'secondary' : 'ghost'}
          size="sm"
          className={cn(
            'h-7 w-7 p-0',
            showShared
              ? 'bg-foreground/[0.06] text-primary-text hover:bg-foreground/[0.08] hover:text-primary-text dark:bg-foreground/[0.08] dark:hover:bg-foreground/[0.1]'
              : 'text-muted-foreground/60 hover:text-foreground',
          )}
          onClick={() => setCloudSharedViewOpen(spaceId, !showShared)}
          aria-label={sharedWithMeLabel}
          aria-pressed={showShared}
        >
          <Link className="h-3.5 w-3.5" />
        </Button>
      </IconButtonTooltip>
      <IconButtonTooltip content={viewModeToggleLabel}>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-muted-foreground/60 hover:text-foreground"
          onClick={toggleViewMode}
          aria-label={viewModeToggleLabel}
        >
          {viewMode === 'list' ? <LayoutGrid className="h-3.5 w-3.5" /> : <LayoutList className="h-3.5 w-3.5" />}
        </Button>
      </IconButtonTooltip>
    </>
  )

  // ── Context menu ──
  const contextMenu = useResourceContextMenu(spaceId, {
    organizationId: organizationId ?? undefined,
    onForeignSharedMoved: reloadSharedItems,
    onForeignSharedRemoved: reloadSharedItems,
  })
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
    currentBrowseFolderId: browseFolderId,
    onBrowseFolderChange: setBrowseFolderId,
  })

  // ── Drag & Drop ──
  // Windows/Chromium：dragStart 里同步 setState 会打断原生拖拽；只用 ref 做 MIME 兜底。
  // ：云盘/云文档文件夹树走 Organization Collection，移动也走 org API。
  const moveItemsForCloud = useCallback(async (
    _anchorSpaceId: string,
    itemIds: string[],
    targetCollectionId: string | null,
  ) => {
    if (organizationId) {
      return useCollections.getState().moveItemsOrganization(
        organizationId,
        itemIds,
        targetCollectionId,
      )
    }
    return useCollections.getState().moveItems(_anchorSpaceId, itemIds, targetCollectionId)
  }, [organizationId])
  const handleResourceWsEvent = useUnifiedResources(s => s.handleWsEvent)
  const handleStructuralEvent = useUnifiedResources(s => s.handleStructuralEvent)
  const activeDragItemRef = useRef<CollectionDragItem | null>(null)
  const {
    dragOverTarget,
    handleDragOver,
    handleDragLeave,
    handleDropOnCollection,
    handleDropOnUncategorized,
  } = useCollectionDnD({
    spaceId,
    moveItems: moveItemsForCloud,
    t,
    activeDragItemRef,
    // 云盘固定读 organization bucket：同 workteam 跨 Space 资源可归入当前文件夹树
    allowOrganizationCrossSpaceMove: true,
    moveSharedResource: async (resourceType, resourceId, collectionId) => {
      if (!organizationId) throw new Error('organization unavailable')
      await moveSharedResourcePlacement({ organizationId, resourceType, resourceId, collectionId })
    },
    onSharedResourceMoved: reloadSharedItems,
  })

  const clearActiveDragItem = useCallback(() => {
    activeDragItemRef.current = null
  }, [])

  useEffect(() => clearActiveDragItem, [clearActiveDragItem])

  const handleDragStart = useCallback((e: React.DragEvent, item: SpaceContextItem) => {
    const dragItem = buildCollectionDragItem(item, {
      isCrossSpace: Boolean(item.space_id && item.space_id !== spaceId),
    })
    if (!dragItem) {
      e.preventDefault()
      log.warn('dragStart blocked: empty or local context item id', {
        spaceId,
        resource_id: item.resource_id,
        collection_id: item.collection_id ?? null,
      })
      toast.warning(t('home.assetBrowser.itemStillSyncing', {
        defaultValue: '资源仍在同步，请稍后再试',
      }))
      void useUnifiedResources.getState().load(spaceId, true, 'organization')
      return
    }
    // 必须先写 ref，再 setData；禁止在此处 setState（Windows 会取消拖拽）
    activeDragItemRef.current = dragItem
    e.dataTransfer.setData(
      COLLECTION_ITEM_MIME,
      JSON.stringify(dragItem),
    )
    writeChatContextDragPayload(
      e.dataTransfer,
      buildSpaceItemChatContextDragPayload(item, contextRegistry),
    )
    const resolvedType = contextRegistry.normalizeBackendType(item.item_type)
    setResourceDragPreview(e.dataTransfer, {
      label: item.title || item.resource_id,
      icon: resolveCloudResourceEmoji(
        resolvedType,
        item.metadata,
        type => contextRegistry.getDisplayEmoji(type),
        item.title || item.resource_id,
      ),
    })
    e.dataTransfer.effectAllowed = 'copyMove'
    log.info('dragStart', {
      spaceId,
      itemId: dragItem.id,
      resource_id: item.resource_id,
      collection_id: item.collection_id ?? null,
      item_space_id: item.space_id,
      is_cross_space: Boolean(dragItem.is_cross_space),
    })
  }, [spaceId, t])

  const handleDragEnd = useCallback(() => {
    const hadPayload = Boolean(activeDragItemRef.current)
    clearActiveDragItem()
    log.info('dragEnd', { spaceId, hadPayload })
  }, [clearActiveDragItem, spaceId])

  const handleResourceDropTarget = useCallback((event: React.DragEvent, collectionId: string | null) => {
    if (collectionId === null) {
      void handleDropOnUncategorized(event)
    } else {
      void handleDropOnCollection(event, collectionId)
    }
    clearActiveDragItem()
  }, [clearActiveDragItem, handleDropOnCollection, handleDropOnUncategorized])

  const handleFolderResourceDrop = useCallback((event: React.DragEvent, collectionId: string) => {
    handleResourceDropTarget(event, collectionId)
  }, [handleResourceDropTarget])

  /** 面包屑：文件走 moveItems；文件夹走 parent_id 调整（对齐 ） */
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

  const openBatchMovePicker = useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    setBatchMovePicker({
      open: true,
      pos: { x: rect.left, y: rect.bottom + 6 },
    })
  }, [])

  const handleBatchMoveSelect = useCallback(async (collectionId: string | null) => {
    if (!selectedBatchCanMove) {
      toast.error(t('home.assetBrowser.batchMovePermissionDenied', {
        defaultValue: '选中的资源中有不可移动的项目',
      }))
      setBatchMovePicker({ open: false, pos: { x: 0, y: 0 } })
      return
    }
    const itemIds = selectedBatchItems.map(item => item.id)
    if (itemIds.length === 0) {
      toast.warning(t('home.assetBrowser.itemStillSyncing', {
        defaultValue: '资源仍在同步，请稍后再试',
      }))
      setBatchMovePicker({ open: false, pos: { x: 0, y: 0 } })
      void useUnifiedResources.getState().load(spaceId, true, 'organization')
      void useUnifiedResources.getState().load(spaceId, true, 'space')
      return
    }
    try {
      const updated = await moveItemsForCloud(spaceId, itemIds, collectionId)
      handleStructuralEvent({ type: 'items_moved', space_id: spaceId })
      console.info('[CloudResourcesHome] batch move succeeded', {
        spaceId,
        collectionId,
        requested: itemIds.length,
        updated,
      })
      toast({
        title: t('home.assetBrowser.batchMoveSuccess', {
          count: updated,
          defaultValue: '已移动 {{count}} 项',
        }),
      })
    } catch (err) {
      console.error('[CloudResourcesHome] batch move failed:', err)
      toast.error(t('errorToast.collectionMoveFailed', { defaultValue: 'Failed to move item' }))
    } finally {
      setSelectedBatchIds(new Set())
      setBatchMovePicker({ open: false, pos: { x: 0, y: 0 } })
      setBatchMode(false)
    }
  }, [handleStructuralEvent, moveItemsForCloud, selectedBatchCanMove, selectedBatchItems, spaceId, t])

  const handleBatchDelete = useCallback(async () => {
    const items = selectedBatchItems
    if (items.length === 0) return
    setBatchDeleteConfirmOpen(false)
    if (!selectedBatchCanDelete) {
      toast.error(t('home.assetBrowser.batchDeletePermissionDenied', {
        defaultValue: '选中的资源中有不可删除的项目',
      }))
      return
    }
    setBatchBusyIds(prev => {
      const next = new Set(prev)
      for (const item of items) next.add(item.id)
      return next
    })

    const failedIds = new Set<string>()
    for (const item of items) {
      try {
        // ：TabFiles trash 走 ORGANIZATION.FILE_TRASH，需带 organization_id
        const movedToTrash = await SpaceApiService.trashContextResource({
          ...item,
          organization_id: item.organization_id ?? organizationId,
        })
        if (!movedToTrash) {
          await SpaceApiService.archiveContextItem(item.id)
        }
        handleResourceWsEvent({
          type: movedToTrash ? 'resource_trashed' : 'resource_archived',
          resource_type: item.item_type,
          resource_id: item.resource_id,
          space_id: item.space_id ?? spaceId,
          organization_id: item.organization_id ?? organizationId,
        })
      } catch (err) {
        failedIds.add(item.id)
        const message = err instanceof Error ? err.message : String(err)
        console.error('[CloudResourcesHome] batch delete failed:', item.id, message || err)
      }
    }

    setBatchBusyIds(prev => {
      const next = new Set(prev)
      for (const item of items) next.delete(item.id)
      return next
    })
    setSelectedBatchIds(new Set())
    setBatchMode(false)

    if (failedIds.size > 0) {
      toast.error(t('home.assetBrowser.batchDeleteFailed', {
        count: failedIds.size,
        defaultValue: '{{count}} 项删除失败',
      }))
      return
    }
    toast({
      title: t('home.assetBrowser.batchDeleteSuccess', {
        count: items.length,
        defaultValue: '已删除 {{count}} 项',
      }),
    })
  }, [handleResourceWsEvent, organizationId, selectedBatchCanDelete, selectedBatchItems, spaceId, t])

  const showSkeleton = (isResourcesLoading || (showShared && sharedLoading)) && filteredDisplayItems.length === 0
  // 侧栏「最近 / 分享给我」：空列表 + 对应数据源失败时展示可点「重新加载」
  const listLoadError = (
    (showShared && sharedError)
    || (isRecentBrowse && Boolean(resourcesError))
  ) && filteredDisplayItems.length === 0
  const retryListLoad = useCallback(() => {
    if (showShared) {
      reloadSharedItems()
      return
    }
    if (isRecentBrowse) {
      retryResourcesLoad()
      reloadSharedItems()
    }
  }, [isRecentBrowse, reloadSharedItems, retryResourcesLoad, showShared])
  const listIsEmpty = (showShared || isRecentBrowse ? 0 : filteredChildFolders.length) === 0 && filteredDisplayItems.length === 0
  const isCreatingFolder = inlineEdit.state?.meta?.type === 'folder'

  // 资源行点击：分享并入项走外部资源打开，其余走普通 Space 导航。
  // 必须透传当前 tabScopeKey：云文档域是 cloud-docs:…，不能落到默认 desktop:…。
  const handleItemClick = useCallback((item: SpaceContextItem) => {
    if (isForeignSharedItem(item)) {
      openForeignSharedItem(spaceId, item, { tabScopeKey: tabScopeKey ?? undefined })
      return
    }
    onSearchNavigate?.(item)
  }, [spaceId, tabScopeKey, onSearchNavigate])

  // ── Folder grid/list render ──
  const renderFolderGrid = (coll: SpaceCollection) => {
    const sharedCount = sharedCloudItems.filter(item => item.collection_id === coll.id).length
    const itemCount = (coll.item_count ?? 0) + sharedCount
    const isDragOver = dragOverTarget === `coll:${coll.id}`
    const isDragging = draggingFolderId === coll.id
    return (
      <div
        key={coll.id}
        draggable
        className={cn('rounded-[12px]', isDragOver && 'ring-1 ring-primary/30', isDragging && 'opacity-40')}
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
          handleFolderResourceDrop(event, coll.id)
        }}
      >
        <HomeGridCard
          gradient={getTypeGradient('tabfolder')}
          icon={coll.icon || '📁'}
          title={coll.name}
          isPinned={Boolean(coll.is_pinned)}
          subtitle={
            <span className="text-muted-foreground/80">
              {t('collectionsView.itemCount', { count: itemCount })}
            </span>
          }
          onClick={() => setBrowseFolderId(coll.id)}
          onContextMenu={event => openFolderMenu(event, coll)}
        />
      </div>
    )
  }

  const renderCreateFolderRow = () => (
    <div className={cn(SIDEBAR_ROW, SIDEBAR_ROW_FULL_WIDTH, 'bg-background/60 text-foreground dark:bg-background/10')}>
      <Folder className={cn(SIDEBAR_ICON, 'text-muted-foreground/60')} strokeWidth={SIDEBAR_ICON_STROKE} />
      <Input
        className="h-auto min-w-0 flex-1 border-none bg-transparent p-0 text-body text-foreground outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
        placeholder={t('sidebar.newCollectionPlaceholder', { defaultValue: 'Folder name...' })}
        {...inlineEdit.getInputProps(onCommitFolder, { retainEmptyOnBlur: true })}
      />
    </div>
  )

  if (isSidebarLayout) {
    // ：云文档域新建在「全部」搜索行（SidebarCloudDocsCreateButton）；此处不再重复
    return (
      <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
        <div className={cn('flex shrink-0 items-center pb-2', SIDEBAR_EMBEDDED_CONTROL_INSET)}>
          <div
            className={cn(
              'flex h-8 min-w-0 w-full items-center gap-2 rounded-[12px] bg-foreground/[0.025] px-2.5',
              'transition-colors duration-200 focus-within:bg-foreground/[0.04]',
              'dark:bg-black/10 dark:focus-within:bg-foreground/[0.06]',
            )}
          >
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            <input
              type="search"
              value={searchQuery}
              onChange={event => setSearchQuery(event.target.value)}
              placeholder={t('home.assetBrowser.searchPlaceholder', {
                name: pageTitle,
                defaultValue: '搜索{{name}}…',
              })}
              aria-label={t('home.assetBrowser.searchPlaceholder', {
                name: pageTitle,
                defaultValue: '搜索{{name}}…',
              })}
              className="min-w-0 flex-1 border-0 bg-transparent text-body leading-[22px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            />
          </div>
        </div>
        {/* 必须 flex-col：否则 ScrollArea 的 flex-1/min-h-0 不生效，列表随内容撑高无法滚动 */}
        <div className={cn(SIDEBAR_LIST_PANEL, 'flex min-h-0 flex-1 flex-col')}>
          {!isCloudDocsDomain ? (
            <div className={SIDEBAR_LIST_PANEL_HEADER}>
              <ContextListPanelBreadcrumb
                items={folderBreadcrumb.map(seg => ({ id: seg.id, label: seg.name }))}
                onSelect={setBrowseFolderId}
                onItemDragOver={handleBreadcrumbDragOver}
                onItemDragLeave={event => { event.stopPropagation(); handleDragLeave() }}
                onItemDrop={handleBreadcrumbDrop}
                isItemDropActive={id => dragOverTarget === `crumb:${id ?? 'root'}`}
              />
            </div>
          ) : null}
          <ScrollArea
            className={SIDEBAR_LIST_PANEL_SCROLL}
            scrollBar="vertical"
            type={SIDEBAR_SCROLLBAR_TYPE}
          >
            {showSkeleton ? (
              <ResourceCollectionSkeleton mode="list" count={7} />
            ) : listLoadError ? (
              <CloudDocsListLoadError onRetry={retryListLoad} />
            ) : listIsEmpty ? (
              <div className="px-2.5 py-3 text-center text-body text-muted-foreground">
                {hasActiveSearch
                  ? t('home.assetBrowser.searchNoResults', { defaultValue: '没有匹配的结果' })
                  : isRecentBrowse
                    ? t('home.assetBrowser.recentEmpty')
                    : showShared
                      ? t('home.source.sharedEmpty', { defaultValue: '还没有人把文档、表格或文件分享给你' })
                      : t('home.assetBrowser.allEmpty')}
              </div>
            ) : (
              <ResourceTableList
                variant="sidebar"
                sidebarTrailing={isRecentBrowse ? 'visited' : 'location'}
                folders={showShared || isRecentBrowse ? [] : filteredChildFolders}
                items={filteredDisplayItems}
                collectionsFlat={collectionsFlat}
                rootFolderLabel={t('home.assetBrowser.rootFolder')}
                activeResourceTabKey={cloudDocsActiveTabKey}
                onItemClick={handleItemClick}
                onItemContextMenu={(e, item) => {
                  contextMenu.handleContextMenu(e, item)
                }}
                onItemRename={contextMenu.handleRenameItem}
                onItemDragStart={handleDragStart}
                onItemDragEnd={handleDragEnd}
                allowForeignSharedDrag
                isDeletingItem={(id) => contextMenu.isDeletingItem(id)}
                onFolderClick={setBrowseFolderId}
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
                  handleFolderResourceDrop(event, coll.id)
                }}
                isFolderDropActive={(coll) => dragOverTarget === `coll:${coll.id}`}
                draggingFolderId={draggingFolderId}
              />
            )}
          </ScrollArea>
        </div>
        {renderCollectionFolderMenuLayer()}
      </div>
    )
  }

  return (
    <div className="flex h-full w-full min-w-0 flex-col">
      <div className={CONTEXT_PAGE_SHELL_FILL}>
        {/* ── Toolbar ── */}
        <ContextPageHeader
          icon={<SidebarTypeEmoji appIdOrType="cloud-resources" className="h-10 w-10" />}
          iconSurface="none"
          title={pageTitle}
          description={pageSubtitle}
        />

        <div className="flex min-w-0 flex-col gap-3">
          <ContextPageToolbar
            actions={(
              <>
                {!showShared && (
                  batchMode ? (
                    <>
                      <span className={cn('inline-flex', 'h-7', 'items-center', 'px-1', 'font-medium', CANVAS_TEXT_META)}>
                        {batchSelectedCountLabel}
                      </span>
                      {!isCloudDocsDomain && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={CONTEXT_PAGE_TOOLBAR_BTN}
                          disabled={!selectedBatchCanMove || batchBusyIds.size > 0}
                          onClick={openBatchMovePicker}
                        >
                          <FolderInput className="h-3.5 w-3.5" />
                          {batchMoveLabel}
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={cn(CONTEXT_PAGE_TOOLBAR_BTN, 'text-destructive hover:text-destructive')}
                        disabled={!selectedBatchCanDelete || batchBusyIds.size > 0}
                        onClick={() => setBatchDeleteConfirmOpen(true)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {batchDeleteLabel}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className={CONTEXT_PAGE_TOOLBAR_BTN}
                        onClick={toggleBatchMode}
                      >
                        <X className="h-3.5 w-3.5" />
                        {batchCancelLabel}
                      </Button>
                    </>
                  ) : (
                    <>
                      <DropdownMenu
                        // modal 默认 true 会铺 pointer 拦截层，悬停不动时 leave/enter 死循环闪烁
                        modal={false}
                        open={createMenuOpen}
                        onOpenChange={(open) => {
                          clearCreateMenuTimers()
                          // 点击/Esc 关闭时同步 hover 标记，避免随后误 reopen
                          if (!open) createMenuHoveringRef.current = false
                          setCreateMenuOpenSafe(open)
                        }}
                      >
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            size="sm"
                            className={CONTEXT_PAGE_TOOLBAR_BTN}
                            aria-haspopup="menu"
                            aria-expanded={createMenuOpen}
                            onClick={openCreateMenuOnClick}
                            onPointerEnter={scheduleOpenCreateMenu}
                            onPointerLeave={scheduleCloseCreateMenu}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {createActionLabel}
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          className="w-[200px]"
                          sideOffset={4}
                          onPointerEnter={keepCreateMenuOpen}
                          onPointerLeave={scheduleCloseCreateMenu}
                          onCloseAutoFocus={(event) => event.preventDefault()}
                        >
                          {cloudQuickActions.map(handler => {
                            const appId = handler.appId ?? (handler.type as string)
                            return (
                              <DropdownMenuItem
                                key={appId}
                                className="gap-2"
                                onSelect={() => {
                                  createCloudResourceInFolder(createHandlers, appId, browseFolderId)
                                }}
                              >
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                                  {handler.quickAction.icon}
                                </span>
                                <span className="text-body text-foreground/80">
                                  {t(handler.quickAction.shortLabelKey ?? handler.quickAction.labelKey)}
                                </span>
                              </DropdownMenuItem>
                            )
                          })}
                          {!isCloudDocsDomain ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="gap-2"
                                onSelect={() => {
                                  startCreateFolderAfterMenuClose()
                                }}
                              >
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                                  <FolderPlus className="h-3.5 w-3.5" />
                                </span>
                                <span className="text-body text-foreground/80">
                                  {newFolderLabel}
                                </span>
                              </DropdownMenuItem>
                            </>
                          ) : null}
                          {feishuImportEnabled ? (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuLabel className="text-caption text-muted-foreground/60">
                                {externalResourcesLabel}
                              </DropdownMenuLabel>
                              <DropdownMenuItem
                                className="gap-2"
                                onSelect={() => {
                                  setCreateMenuOpenSafe(false)
                                  setFeishuImportOpen(true)
                                }}
                              >
                                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:h-3.5 [&_svg]:w-3.5">
                                  <Link2 className="h-3.5 w-3.5" />
                                </span>
                                <span className="text-body text-foreground/80">
                                  {feishuLabel}
                                </span>
                              </DropdownMenuItem>
                            </>
                          ) : null}
                        </DropdownMenuContent>
                      </DropdownMenu>
                      {/* 云盘（default）始终开放上传；云文档域仍随 CLOUD_DOCS_SHOW_DRIVE */}
                      {(!isCloudDocsDomain || CLOUD_DOCS_SHOW_DRIVE) ? (
                        <>
                          <input
                            ref={importFileInputRef}
                            type="file"
                            className="hidden"
                            onChange={(event) => void handleImportFile(event)}
                          />
                          <input
                            ref={(element) => {
                              importFolderInputRef.current = element
                              if (element) {
                                element.setAttribute('webkitdirectory', '')
                                element.setAttribute('directory', '')
                              }
                            }}
                            type="file"
                            className="hidden"
                            multiple
                            onChange={(event) => void handleImportFolder(event)}
                          />
                          <ContextPageToolbarImportButton
                            label={t('home.assetBrowser.importAction', { defaultValue: '导入' })}
                            loading={isImportingFile}
                            disabled={isImporting}
                            icon={FileInput}
                            onClick={() => importFileInputRef.current?.click()}
                          />
                          <ContextPageToolbarIconButton
                            label={importFolderLabel}
                            disabled={isImporting}
                            onClick={() => importFolderInputRef.current?.click()}
                          >
                            {isImportingFolder
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <FolderUp className="h-3.5 w-3.5" />}
                          </ContextPageToolbarIconButton>
                        </>
                      ) : null}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className={CONTEXT_PAGE_TOOLBAR_BTN}
                        disabled={!hasVisibleBatchSelectableItems}
                        onClick={toggleBatchMode}
                      >
                        <ListChecks className="h-3.5 w-3.5" />
                        {batchActionLabel}
                      </Button>
                    </>
                  )
                )}
              </>
            )}
            searchPlaceholder={t('home.assetBrowser.searchPlaceholder', {
              name: pageTitle,
              defaultValue: '搜索{{name}}…',
            })}
            searchValue={searchQuery}
            onSearchChange={setSearchQuery}
            trailing={cloudToolbarTrailing}
          />

          {/* ── Type filter ── */}
          <div className="flex flex-col gap-2 py-0.5 min-w-0 w-full">
            <div className="flex flex-wrap items-center gap-1 min-w-0 w-full">
              {typeFilterButtons.map(fid => (
                <Button
                  key={fid}
                  type="button"
                  variant={activeTypeFilter === fid ? 'secondary' : 'ghost'}
                  size="sm"
                  className={cn('h-7', 'px-2', CANVAS_TEXT_META)}
                  onClick={() => setActiveTypeFilter(fid)}
                >
                  {t(TYPE_FILTER_LABELS[fid])}
                </Button>
              ))}
            </div>
            {!isCloudDocsDomain ? (
            <p className={cn('px-0.5', CANVAS_TEXT_META)}>
              {t('home.assetBrowser.dragToAgentHint', {
                defaultValue: '可将表格、文档或文件拖入对话；云盘文件夹除外',
              })}
            </p>
            ) : (
            <p className={cn('px-0.5', CANVAS_TEXT_META)}>
              {t('home.assetBrowser.dragToAgentHintCloudDocs', {
                defaultValue: '可将表格、文档或文件拖入对话；文件夹除外',
              })}
            </p>
            )}
          </div>
        </div>

        <div className="mt-2 flex min-h-0 flex-1 w-full flex-col">
        <div className={cn(SIDEBAR_LIST_PANEL, 'flex h-full w-full flex-col')}>
          <div className={SIDEBAR_LIST_PANEL_HEADER}>
            {showShared ? (
              <div className="inline-flex max-w-full min-w-0 items-center gap-x-1 gap-y-0.5 text-body">
                <span className="truncate rounded px-0.5 py-0.5 font-medium text-foreground">
                  {t('home.source.shared', { defaultValue: '分享给我' })}
                </span>
              </div>
            ) : (
              <ContextListPanelBreadcrumb
                items={folderBreadcrumb.map(seg => ({ id: seg.id, label: seg.name }))}
                onSelect={setBrowseFolderId}
                onItemDragOver={handleBreadcrumbDragOver}
                onItemDragLeave={event => { event.stopPropagation(); handleDragLeave() }}
                onItemDrop={handleBreadcrumbDrop}
                isItemDropActive={id => dragOverTarget === `crumb:${id ?? 'root'}`}
              />
            )}
          </div>
          <ScrollArea className={cn(SIDEBAR_LIST_PANEL_SCROLL, '[&>[data-radix-scroll-area-viewport]>div]:!block')}>
            <div className="flex min-h-full min-w-0 w-full flex-col">
            {/* ── Content ── */}
            <div className="flex min-h-0 flex-1 flex-col min-w-0 w-full">
            {showSkeleton ? (
              <ResourceCollectionSkeleton
                mode={viewMode}
                count={viewMode === 'grid' ? 6 : 7}
                minCardWidth={RESOURCE_GRID_MIN_CARD_WIDTH}
              />
            ) : listLoadError ? (
              <CloudDocsListLoadError onRetry={retryListLoad} />
            ) : listIsEmpty && !isCreatingFolder ? (
              <div className="px-2.5 py-3 text-center text-body text-muted-foreground">
                {hasActiveSearch
                  ? t('home.assetBrowser.searchNoResults', { defaultValue: '没有匹配的结果' })
                  : showShared
                    ? t('home.source.sharedEmpty', { defaultValue: '还没有人把文档、表格或文件分享给你' })
                    : t('home.assetBrowser.allEmpty')}
              </div>
            ) : viewMode === 'list' ? (
              <div className="flex min-h-0 flex-1 flex-col min-w-0 w-full">
                {!showShared && isCreatingFolder && (
                  <div className="mb-0.5 flex min-w-0 w-full">
                    {renderCreateFolderRow()}
                  </div>
                )}
                <ResourceTableList
                  folders={showShared ? [] : filteredChildFolders}
                  items={filteredDisplayItems}
                  collectionsFlat={collectionsFlat}
                  folderItemCount={coll => (coll.item_count ?? 0) + sharedCloudItems.filter(item => item.collection_id === coll.id).length}
                  rootFolderLabel={t('home.assetBrowser.rootFolder')}
                  onItemClick={handleItemClick}
                  onItemContextMenu={(e, item) => {
                    contextMenu.handleContextMenu(e, item)
                  }}
                  onItemRename={contextMenu.handleRenameItem}
                  onItemDragStart={handleDragStart}
                  onItemDragEnd={handleDragEnd}
                  allowForeignSharedDrag
                  isDeletingItem={(id) => contextMenu.isDeletingItem(id) || batchBusyIds.has(id)}
                  selectionMode={batchMode}
                  selectedItemIds={selectedBatchIdsForList}
                  onItemSelectionToggle={toggleBatchSelection}
                  isItemSelectable={isBatchSelectableItem}
                  onFolderClick={setBrowseFolderId}
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
                    handleFolderResourceDrop(event, coll.id)
                  }}
                  isFolderDropActive={(coll) => dragOverTarget === `coll:${coll.id}`}
                  draggingFolderId={draggingFolderId}
                />
              </div>
            ) : (
              <>
                {!showShared && isCreatingFolder && (
                  <div className="mb-1 flex min-w-0 w-full">
                    {renderCreateFolderRow()}
                  </div>
                )}
                <div
                  className="grid gap-3"
                  style={{ gridTemplateColumns: resourceGridTemplateColumns() }}
                >
                  {!showShared && filteredChildFolders.map(renderFolderGrid)}
                  {filteredDisplayItems.map(item => {
                    const foreignShared = isForeignSharedItem(item)
                    const isDeleting = contextMenu.isDeletingItem(item.id) || batchBusyIds.has(item.id)
                    const selectable = batchMode && isBatchSelectableItem(item) && !isDeleting
                    const selected = selectedBatchIdsForList.has(item.id)
                    const canDrag = !isDeleting && !batchMode && isMovableContextItemId(item.id)
                    const dragBlockReason = canDrag
                      ? null
                      : getResourceDragBlockReason(item, {
                        foreignShared,
                        deleting: isDeleting,
                        batchMode,
                      })
                    const sharedName = foreignShared ? getSharedByName(item) : ''
                    const title = item.title || item.resource_id
                    return (
                      <div
                        key={item.id}
                        draggable={canDrag}
                        className={cn(
                          'relative',
                          canDrag && 'cursor-grab active:cursor-grabbing',
                          batchMode && !selectable && 'opacity-60',
                        )}
                        onPointerDown={dragBlockReason
                          ? () => logResourceDragBlocked(item, dragBlockReason, { surface: 'CloudResourcesHome.grid' })
                          : undefined}
                        onDragStart={canDrag ? e => handleDragStart(e, item) : undefined}
                        onDragEnd={canDrag ? handleDragEnd : undefined}
                      >
                        {batchMode && (
                          <input
                            type="checkbox"
                            className="absolute left-2 top-2 z-floating h-4 w-4 rounded border-border bg-background text-primary shadow-sm focus:ring-primary/30"
                            aria-label={`选择 ${title}`}
                            checked={selected}
                            disabled={!selectable}
                            onClick={event => event.stopPropagation()}
                            onChange={event => {
                              event.stopPropagation()
                              if (selectable) toggleBatchSelection(item)
                            }}
                          />
                        )}
                        <ResourceGridCard
                          item={item}
                          onClick={batchMode
                            ? (selectable ? () => toggleBatchSelection(item) : undefined)
                            : () => handleItemClick(item)}
                          onContextMenu={batchMode
                            ? undefined
                            : (e) => contextMenu.handleContextMenu(e, item)}
                          className={cn(
                            canDrag && 'cursor-grab active:cursor-grabbing',
                            batchMode && selectable && 'cursor-pointer',
                            selected && 'ring-2 ring-primary/45',
                          )}
                          spaceName={foreignShared
                            ? (sharedName
                              ? t('home.table.sharedByLocation', { name: sharedName, defaultValue: '由 {{name}} 分享' })
                              : t('home.table.sharedByLocationUnknown', { defaultValue: '他人分享' }))
                            : undefined}
                          isBusy={isDeleting}
                          busyLabel={t('home.deleting', { defaultValue: 'Deleting...' })}
                        />
                      </div>
                    )
                  })}
                </div>
              </>
            )}
            </div>

          </div>
          </ScrollArea>
        </div>
        </div>
      </div>

      <ResourceContextMenuOverlay
        spaceId={spaceId}
        organizationId={organizationId}
        menuState={contextMenu.menuState}
        onClose={contextMenu.closeMenu}
        onTogglePin={contextMenu.handleTogglePin}
        onMoveToCollection={contextMenu.handleMoveToCollection}
        onRemoveForeignShared={contextMenu.handleRemoveForeignShared}
        onRename={contextMenu.handleRename}
        onArchive={contextMenu.handleArchive}
        folderConfirm={folderConfirm}
      />
      {!isCloudDocsDomain && (
        <CollectionMovePickerOverlay
          open={batchMovePicker.open}
          anchorPosition={batchMovePicker.pos}
          collections={collections}
          onClose={() => setBatchMovePicker({ open: false, pos: { x: 0, y: 0 } })}
          onSelect={(collectionId) => { void handleBatchMoveSelect(collectionId) }}
          onSelectRoot={() => { void handleBatchMoveSelect(null) }}
        />
      )}
      <ConfirmDialog
        open={batchDeleteConfirmOpen}
        onOpenChange={setBatchDeleteConfirmOpen}
        title={t('home.assetBrowser.batchDeleteConfirmTitle', { defaultValue: '删除选中的资源' })}
        description={t('home.assetBrowser.batchDeleteConfirmDescription', {
          count: selectedBatchCount,
          defaultValue: '这会将选中的 {{count}} 个资源移入回收站。',
        })}
        confirmText={t('home.assetBrowser.batchDeleteConfirm', { defaultValue: '删除' })}
        variant="destructive"
        onConfirm={handleBatchDelete}
      />
      {feishuImportEnabled ? (
        <FeishuImportDialog
          open={feishuImportOpen}
          onOpenChange={setFeishuImportOpen}
          organizationId={organizationId}
          spaceId={spaceId}
          collectionId={browseFolderId}
        />
      ) : null}
      {renderCollectionFolderMenuLayer()}
    </div>
  )
}

export { CloudResourcesHome }

export const cloudResourcesHomeSection: HomeSectionHandler = {
  appId: 'cloud-resources',
  labelKey: 'home.cloudDrive',
  Component: CloudResourcesHome,
  // 与侧边栏「云文档」入口同款图标（DesktopPanel 聚合行），替代 Home 兜底
  tabIcon: <TabTypeEmoji appIdOrType="cloud-resources" />,
}
