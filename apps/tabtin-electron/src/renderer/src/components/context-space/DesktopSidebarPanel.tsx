import React, { useCallback, useMemo, useState } from 'react'
import { ChevronRight, Columns2, Minimize2, PinOff, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { toast, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { cn } from '@utils/cn'
import { useSpaceContextActions, useSpaceContextState } from './SpaceContextAreaContext'
import { useSpaceApps } from '@stores/useSpaceApps'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useCanvasLayoutStore, type CanvasLayoutGroup, type CanvasPane, type CanvasTabKey } from '@stores/useCanvasLayoutStore'
import { MAX_PANES_PER_GROUP } from '@stores/canvasLayout/helpers'
import { useUnifiedResources } from '@/stores/useUnifiedResources'
import type { SpaceContextItem } from '@/services/spaceApi'
import { contextRegistry } from './registry'
import type { ContextItem } from './registry/types'
import { useInlineEdit } from './hooks/useInlineEdit'
import { useDelayedSingleClick } from './hooks/useDelayedSingleClick'
import { renameResourceWithFeedback } from './ResourceContextMenu'
import { flattenLayout } from '@hooks/useContextTabsLogic'
import { DRAG_TYPE_TAB_META, DRAG_TYPE_TAB_REORDER } from '@/utils/split-coordinator'
import {
  SIDEBAR_ICON,
  SIDEBAR_ICON_ACTIVE,
  SIDEBAR_ICON_INACTIVE,
  SIDEBAR_ICON_STROKE,
  SIDEBAR_META,
  SIDEBAR_ROW_LABEL_ACTIVE,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_ROW_LIST,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_SECTION_LABEL,
} from '@components/layout/sidebarUi'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import {
  DESKTOP_APPS_HOME_ID,
  DESKTOP_RAIL_EXCLUDED_APP_IDS,
  useDesktopAppEntries,
  usePinnedDesktopAppIds,
  type DesktopAppEntry,
} from './desktopAppsModel'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { activateDesktopAppEntry } from './desktopAppActivation'
import { metaStr } from './registry/homeSections/metaFieldUtils'

const DESKTOP_HOME_TYPE = 'desktop_home'
const DRAG_TYPE_SIDEBAR_PANE = 'application/tabtin-sidebar-pane'

type DesktopSidebarSlot =
  | { kind: 'tab'; item: ContextItem }
  | { kind: 'group'; group: CanvasLayoutGroup }

interface SidebarPaneDragPayload {
  groupId: string
  paneId: string
  tabKey: string
}

interface DesktopSidebarPanelProps {
  activeAppHomeId?: string | null
  onOpenAppHome: (appId: string) => void
  onSelectOpenTab: (item: ContextItem) => void
}

function isClosable(item: ContextItem): boolean {
  const handler = contextRegistry.getHandler(item.type)
  const closable = handler?.closable
  if (typeof closable === 'function') return closable(item)
  if (typeof closable === 'boolean') return closable
  return true
}

function isCanvasTabKey(tabKey: string): tabKey is CanvasTabKey {
  return tabKey.includes(':')
}

function orderedPanesForGroup(group: CanvasLayoutGroup): CanvasPane[] {
  const paneById = new Map(group.panes.map(pane => [pane.id, pane]))
  const orderedPaneIds = group.layout
    ? flattenLayout(group.layout)
    : group.panes.map(pane => pane.id)
  return orderedPaneIds
    .map(paneId => paneById.get(paneId))
    .filter((pane): pane is CanvasPane => Boolean(pane))
}

function makeDragPayload(item: ContextItem): unknown {
  return contextRegistry.getDragPayload(item) ?? {
    type: item.type,
    id: item.id,
    title: item.title,
  }
}

function isSpaceBoundDirectoryHome(item: ContextItem): boolean {
  return item.type === 'apphome'
    && item.meta?.appId === 'orchestration'
    && typeof item.meta?.targetSpaceId === 'string'
    && Boolean(item.meta.targetSpaceId)
}

// 标签归属的应用 id：apphome 用 meta.appId（否则用自身 id），其余按 type → handler.appId
// 派生（与旧 DesktopPanel 同口径）。用于把「标签」区按应用分组（每个应用管自己的标签）。
function getAppIdForItem(item: ContextItem): string {
  if (item.type === 'apphome') {
    if (isSpaceBoundDirectoryHome(item)) {
      return 'tabfolder'
    }
    const metaAppId = item.meta?.appId
    return typeof metaAppId === 'string' ? metaAppId : item.id
  }
  const handler = contextRegistry.getHandler(item.type)
  return handler?.appId ?? item.type
}

/**
 * 普通 apphome（文档/表格主页）已由置顶/应用行代表，不在「标签」区重复。
 * 例外：
 * - panel 类应用（Skill / Marketplace…）打开后只有 apphome 这一条，滤掉标签区会空；
 * - Space 绑定目录起始页不是普通应用入口，必须留在标签区。
 *
 * 自动化例外的例外：虽是 panel，但置顶行已是列表入口，且标签区要放各任务详情；
 * 再列 apphome 会变成「自动化 → 自动化 → 详情」叠名。
 */
function shouldListAppHomeInOpenTabs(item: ContextItem): boolean {
  if (item.type !== 'apphome') return true
  if (isSpaceBoundDirectoryHome(item)) return true
  const appId = typeof item.meta?.appId === 'string' ? item.meta.appId : item.id
  if (appId === 'tabtracker') return false
  const handler = contextRegistry.getHandlerByAppId(appId)
  return handler?.appEntryMode === 'panel'
}

/**
 * 自动化列表页（无 taskId）与置顶「自动化」入口重复，不进侧栏「标签」区；
 * 详情页（有 taskId / eventId）才列在「自动化」分组下。
 */
function shouldListTrackerTabInOpenTabs(item: ContextItem): boolean {
  if (item.type !== 'tabtracker') return true
  return Boolean(metaStr(item.meta, 'taskId') || metaStr(item.meta, 'eventId'))
}

/** 左侧「标签」区支持双击内联重命名的资源型 tab（浏览器/终端等排除）。 */
const RENAMABLE_OPEN_TAB_TYPES = new Set([
  'tabdoc',
  'tabdata',
  'tabslide',
  'tabtracker',
])

function canRenameOpenTab(item: ContextItem): boolean {
  return RENAMABLE_OPEN_TAB_TYPES.has(item.type) && Boolean(item.id) && !item.id.startsWith('local:')
}

function resolveOpenTabRenameTarget(
  tab: ContextItem,
  spaceId: string,
  resources: SpaceContextItem[],
): SpaceContextItem | null {
  if (!canRenameOpenTab(tab)) return null
  const found = resources.find((resource) => {
    if (resource.resource_id !== tab.id) return false
    return contextRegistry.normalizeBackendType(resource.item_type) === tab.type
      || resource.item_type === tab.type
  })
  if (found) return found
  // 资源列表尚未同步时，直接用 resource_id=tab.id 走各 App 更新接口（tabdoc/tabdata 等）
  return {
    id: tab.id,
    item_type: tab.type,
    title: tab.title || '',
    preview: '',
    resource_id: tab.id,
    space_id: spaceId,
    metadata: tab.meta ?? {},
    is_archived: false,
    is_pinned: false,
    pinned_at: null,
    collection_id: null,
    updated_at: null,
    created_at: null,
  }
}

const COLLAPSED_APPS_STORAGE_KEY = 'tabtin:desktop-sidebar:collapsed-tab-apps'

function loadCollapsedApps(): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_APPS_STORAGE_KEY)
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set()
  } catch {
    return new Set()
  }
}

export const DesktopSidebarPanel: React.FC<DesktopSidebarPanelProps> = ({
  activeAppHomeId = null,
  onOpenAppHome,
  onSelectOpenTab,
}) => {
  const { t } = useTranslation('context')
  const {
    visibleItems,
    tabLookupItems,
    canvasGroups,
    activeTabKey,
    tabScopeKey,
    spaceId,
  } = useSpaceContextState()
  const {
    createHandlers,
    onCloseItem,
    onRestoreGroup,
  } = useSpaceContextActions()
  const createGroup = useCanvasLayoutStore(state => state.createGroup)
  const assignPaneContent = useCanvasLayoutStore(state => state.assignPaneContent)
  const splitPaneWithContent = useCanvasLayoutStore(state => state.splitPaneWithContent)
  const closePane = useCanvasLayoutStore(state => state.closePane)
  const setActivePane = useCanvasLayoutStore(state => state.setActivePane)
  const setActiveKey = useSpaceContextTabsStore(state => state.setActiveKey)
  const handleResourceWsEvent = useUnifiedResources(state => state.handleWsEvent)
  const renameEdit = useInlineEdit()
  const titleClick = useDelayedSingleClick()
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set())
  const spaceApps = useSpaceApps(state => state.appsBySpace[spaceId])
  const appEntries = useDesktopAppEntries(t, spaceApps)
  const { pinnedAppIds, unpinApp } = usePinnedDesktopAppIds()

  const commitOpenTabRename = useCallback(async (title: string, tabKey?: string) => {
    if (!tabKey) return
    const tab = tabLookupItems.find(item => item.tabKey === tabKey)
      ?? visibleItems.find(item => item.tabKey === tabKey)
    if (!tab) return
    const target = resolveOpenTabRenameTarget(
      tab,
      spaceId,
      useUnifiedResources.getState().getResources(spaceId),
    )
    if (!target) return
    await renameResourceWithFeedback({
      item: target,
      title,
      emitResourceUpdated: handleResourceWsEvent,
      t,
      logLabel: 'DesktopSidebarPanel',
    })
  }, [handleResourceWsEvent, spaceId, t, tabLookupItems, visibleItems])

  const desktopHomeItem = useMemo(
    () => visibleItems.find(item => item.type === DESKTOP_HOME_TYPE) ?? null,
    [visibleItems],
  )

  const tabKeyToItem = useMemo(() => {
    const map = new Map<string, ContextItem>()
    for (const item of tabLookupItems) {
      map.set(item.tabKey, item)
    }
    return map
  }, [tabLookupItems])

  const groupByTabKey = useMemo(() => {
    const map = new Map<string, CanvasLayoutGroup>()
    for (const group of canvasGroups) {
      for (const pane of group.panes) {
        const tabKey = pane.content?.tabKey
        if (tabKey) map.set(tabKey, group)
      }
    }
    return map
  }, [canvasGroups])

  const slots = useMemo<DesktopSidebarSlot[]>(() => {
    const result: DesktopSidebarSlot[] = []
    const emittedGroupIds = new Set<string>()
    for (const item of tabLookupItems) {
      // 桌面虚拟占位不进标签区；普通 apphome 由置顶/应用行代表，也不重复列。
      // panel 类 apphome / Space 绑定目录起始页例外，见 shouldListAppHomeInOpenTabs。
      // 自动化列表页与置顶入口重复，只保留详情页，见 shouldListTrackerTabInOpenTabs。
      if (item.type === DESKTOP_HOME_TYPE) continue
      if (item.type === 'apphome' && !shouldListAppHomeInOpenTabs(item)) continue
      if (item.type === 'tabtracker' && !shouldListTrackerTabInOpenTabs(item)) continue
      const group = groupByTabKey.get(item.tabKey)
      if (group) {
        if (!emittedGroupIds.has(group.id)) {
          result.push({ kind: 'group', group })
          emittedGroupIds.add(group.id)
        }
        continue
      }
      result.push({ kind: 'tab', item })
    }
    for (const group of canvasGroups) {
      if (!emittedGroupIds.has(group.id)) {
        result.push({ kind: 'group', group })
      }
    }
    return result
  }, [canvasGroups, groupByTabKey, tabLookupItems])

  // 按应用把 slots 分组：单标签取自身 app，canvas group 取其 anchor pane 的 app。
  // 保持出现顺序（= tabLookupItems 顺序），每个应用一个可折叠分组。
  const appTabGroups = useMemo(() => {
    const byApp = new Map<string, DesktopSidebarSlot[]>()
    const order: string[] = []
    const repItemByApp = new Map<string, ContextItem>()
    for (const slot of slots) {
      let appId: string
      let repItem: ContextItem | undefined
      if (slot.kind === 'tab') {
        appId = getAppIdForItem(slot.item)
        repItem = slot.item
      } else {
        const anchorKey =
          slot.group.anchorTabKey ??
          slot.group.panes.find(pane => pane.content?.tabKey)?.content?.tabKey ??
          null
        const anchorItem = anchorKey ? tabKeyToItem.get(anchorKey) : undefined
        appId = anchorItem ? getAppIdForItem(anchorItem) : 'other'
        repItem = anchorItem
      }
      if (!byApp.has(appId)) {
        byApp.set(appId, [])
        order.push(appId)
        if (repItem) repItemByApp.set(appId, repItem)
      }
      byApp.get(appId)!.push(slot)
    }
    return order.map(appId => ({ appId, slots: byApp.get(appId)!, repItem: repItemByApp.get(appId) }))
  }, [slots, tabKeyToItem])

  const [collapsedApps, setCollapsedApps] = useState<Set<string>>(loadCollapsedApps)
  const toggleAppCollapsed = useCallback((appId: string) => {
    setCollapsedApps(prev => {
      const next = new Set(prev)
      if (next.has(appId)) next.delete(appId)
      else next.add(appId)
      try {
        localStorage.setItem(COLLAPSED_APPS_STORAGE_KEY, JSON.stringify([...next]))
      } catch { /* ignore */ }
      return next
    })
  }, [])

  const toggleGroupExpanded = useCallback((groupId: string) => {
    setExpandedGroupIds(prev => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  const selectPane = useCallback((group: CanvasLayoutGroup, pane: CanvasPane) => {
    const tabKey = pane.content?.tabKey
    setActivePane(tabScopeKey, group.id, pane.id)
    if (tabKey) {
      setActiveKey(tabScopeKey, tabKey)
    }
  }, [setActiveKey, setActivePane, tabScopeKey])

  const extractDraggedTabKey = useCallback((event: React.DragEvent): string | null => {
    const tabKey =
      event.dataTransfer.getData(DRAG_TYPE_TAB_REORDER) ||
      event.dataTransfer.getData('text/plain')
    return tabKey || null
  }, [])

  const startTabDrag = useCallback((event: React.DragEvent<HTMLElement>, item: ContextItem) => {
    event.dataTransfer.setData('text/plain', item.tabKey)
    event.dataTransfer.setData(DRAG_TYPE_TAB_REORDER, item.tabKey)
    event.dataTransfer.setData(DRAG_TYPE_TAB_META, JSON.stringify(makeDragPayload(item)))
    event.dataTransfer.effectAllowed = 'copyMove'
  }, [])

  const startPaneDrag = useCallback((event: React.DragEvent<HTMLElement>, group: CanvasLayoutGroup, pane: CanvasPane) => {
    const tabKey = pane.content?.tabKey
    if (!tabKey) {
      event.preventDefault()
      return
    }
    const payload: SidebarPaneDragPayload = { groupId: group.id, paneId: pane.id, tabKey }
    event.dataTransfer.setData(DRAG_TYPE_SIDEBAR_PANE, JSON.stringify(payload))
    event.dataTransfer.effectAllowed = 'move'
  }, [])

  const mergeTabIntoGroup = useCallback((group: CanvasLayoutGroup, draggedTabKey: string) => {
    if (!isCanvasTabKey(draggedTabKey)) return
    if (group.panes.some(pane => pane.content?.tabKey === draggedTabKey)) return
    const content = { tabKey: draggedTabKey }
    const emptyPane = group.panes.find(pane => !pane.content)
    if (emptyPane) {
      assignPaneContent(tabScopeKey, group.id, emptyPane.id, content)
      setActiveKey(tabScopeKey, draggedTabKey)
      return
    }
    if (group.panes.length >= MAX_PANES_PER_GROUP) {
      toast({
        title: t('desktop.sidebar.groupFullTitle', { defaultValue: '这个标签组已满' }),
        description: t('desktop.sidebar.groupFullDesc', { defaultValue: '一个标签组最多支持 3 个 pane。' }),
      })
      return
    }
    const targetPaneId = group.activePaneId || group.panes[0]?.id
    if (!targetPaneId) return
    splitPaneWithContent(tabScopeKey, group.id, targetPaneId, 'horizontal', 'right', content)
    setActiveKey(tabScopeKey, draggedTabKey)
  }, [assignPaneContent, setActiveKey, splitPaneWithContent, tabScopeKey, t])

  const handleDropOnTab = useCallback((event: React.DragEvent<HTMLElement>, target: ContextItem) => {
    const draggedTabKey = extractDraggedTabKey(event)
    if (!draggedTabKey || draggedTabKey === target.tabKey) return
    if (!isCanvasTabKey(draggedTabKey) || !isCanvasTabKey(target.tabKey)) return
    const draggedItem = tabKeyToItem.get(draggedTabKey)
    if (!draggedItem) return
    event.preventDefault()
    event.stopPropagation()

    const existingTargetGroup = groupByTabKey.get(target.tabKey)
    if (existingTargetGroup) {
      mergeTabIntoGroup(existingTargetGroup, draggedTabKey)
      return
    }

    if (groupByTabKey.has(draggedTabKey)) return
    const group = createGroup(tabScopeKey, target.tabKey, { tabKey: target.tabKey }, 'horizontal', 'right')
    const emptyPane = group.panes.find(pane => !pane.content)
    if (emptyPane) {
      assignPaneContent(tabScopeKey, group.id, emptyPane.id, { tabKey: draggedTabKey })
      setActiveKey(tabScopeKey, draggedTabKey)
      setExpandedGroupIds(prev => new Set(prev).add(group.id))
    }
  }, [assignPaneContent, createGroup, extractDraggedTabKey, groupByTabKey, mergeTabIntoGroup, setActiveKey, tabKeyToItem, tabScopeKey])

  const handleDropOnGroup = useCallback((event: React.DragEvent<HTMLElement>, group: CanvasLayoutGroup) => {
    const draggedTabKey = extractDraggedTabKey(event)
    if (!draggedTabKey || !tabKeyToItem.has(draggedTabKey)) return
    event.preventDefault()
    event.stopPropagation()
    mergeTabIntoGroup(group, draggedTabKey)
    setExpandedGroupIds(prev => new Set(prev).add(group.id))
  }, [extractDraggedTabKey, mergeTabIntoGroup, tabKeyToItem])

  const handleDropPaneToList = useCallback((event: React.DragEvent<HTMLElement>) => {
    const raw = event.dataTransfer.getData(DRAG_TYPE_SIDEBAR_PANE)
    if (!raw) return
    event.preventDefault()
    event.stopPropagation()
    try {
      const payload = JSON.parse(raw) as Partial<SidebarPaneDragPayload>
      if (!payload.groupId || !payload.paneId || !payload.tabKey) return
      closePane(tabScopeKey, payload.groupId, payload.paneId)
      setActiveKey(tabScopeKey, payload.tabKey)
    } catch (error) {
      console.warn('[DesktopSidebarPanel] Failed to parse sidebar pane drag payload:', error)
    }
  }, [closePane, setActiveKey, tabScopeKey])

  const handleOpenDesktopHome = useCallback(() => {
    if (desktopHomeItem) {
      onSelectOpenTab(desktopHomeItem)
    }
  }, [desktopHomeItem, onSelectOpenTab])

  const appEntryById = useMemo(() => new Map(appEntries.map(entry => [entry.id, entry])), [appEntries])

  const activateApp = useCallback(
    (entry: DesktopAppEntry) => activateDesktopAppEntry(entry, { createHandlers, onOpenAppHome }),
    [createHandlers, onOpenAppHome],
  )

  const pinnedEntries = useMemo(
    () => pinnedAppIds
      .filter(id => !DESKTOP_RAIL_EXCLUDED_APP_IDS.has(id))
      .map(id => appEntryById.get(id))
      .filter((entry): entry is DesktopAppEntry => Boolean(entry)),
    [appEntryById, pinnedAppIds],
  )

  const systemHomeEntry = {
    id: 'home',
    label: t('desktop.sidebar.home', { defaultValue: '主页' }),
    icon: <SidebarTypeEmoji appIdOrType="desktop_home" />,
    active: activeTabKey === desktopHomeItem?.tabKey,
    onClick: handleOpenDesktopHome,
  }

  const renderAppIcon = (appId: string, active: boolean) => (
    <SidebarTypeEmoji appIdOrType={appId} active={active} />
  )

  // 保留供标签区分组头等仍走 Lucide 回退的场景；置顶应用行改走 emoji。
  const appIconClass = (active: boolean) => cn(
    'shrink-0',
    active ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
  )

  // 「标签」区里每个应用分组头的图标 + 名称：优先取应用目录（appEntries），
  // 目录里没有则回退到 i18n 应用名 + 代表标签的图标。
  const resolveAppMeta = (appId: string, repItem?: ContextItem): { label: string; icon: React.ReactNode } => {
    const entry = appEntryById.get(appId)
    // tabfiles 不在「更多」目录展示，但其打开标签仍属于统一的「文件」应用。
    // 不可用首个文件名充当分组名，否则侧栏会出现「文件名 → 文件列表」的伪层级。
    if (appId === 'tabfiles') {
      return {
        label: t('appName.tabfiles', { defaultValue: '文件' }),
        icon: entry?.icon
          ?? (repItem
            ? contextRegistry.getTabIcon(repItem)
            : <SidebarTypeEmoji appIdOrType="tabfiles" />),
      }
    }
    if (entry) return { label: entry.label, icon: entry.icon }
    if (appId === DESKTOP_APPS_HOME_ID) {
      return {
        label: t('desktop.sidebar.moreApps', { defaultValue: '更多' }),
        icon: <SidebarTypeEmoji appIdOrType={DESKTOP_APPS_HOME_ID} />,
      }
    }
    // 非目录应用：回退到代表标签的名称/图标（比裸 appId 可读）。
    const label = repItem ? contextRegistry.getTabLabel(repItem) : t(`appName.${appId}`, { defaultValue: appId })
    const icon = repItem ? contextRegistry.getTabIcon(repItem) : <SidebarTypeEmoji appIdOrType={appId} />
    return { label, icon }
  }

  return (
    <div className="scrollbar-hover flex h-full w-full flex-col overflow-hidden py-1">
      <div className="shrink-0 max-h-[45%] min-h-0 overflow-y-auto pb-1">
        <div className={cn(SIDEBAR_SECTION_HEADER, 'mx-1.5')}>
          <span className={SIDEBAR_SECTION_LABEL}>
            {t('desktop.sidebar.pinned', { defaultValue: '置顶' })}
          </span>
        </div>
        <div className={cn('shrink-0', SIDEBAR_ROW_LIST)}>
          <SidebarMenuItem
            key={systemHomeEntry.id}
            as="button"
            active={systemHomeEntry.active}
            fullWidth
            onClick={systemHomeEntry.onClick}
            leading={
              <span className="shrink-0">
                {renderAppIcon(systemHomeEntry.id === 'home' ? 'desktop_home' : systemHomeEntry.id, systemHomeEntry.active)}
              </span>
            }
            label={systemHomeEntry.label}
          />
          {pinnedEntries.map(entry => {
            const active = activeAppHomeId === entry.id
            return (
              <SidebarMenuItem
                key={entry.id}
                as="div"
                role="button"
                tabIndex={0}
                active={active}
                fullWidth
                onClick={() => activateApp(entry)}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    activateApp(entry)
                  }
                }}
                leading={
                  <span className="shrink-0">
                    {renderAppIcon(entry.id, active)}
                  </span>
                }
                label={entry.label}
                trailing={
                  <button
                    type="button"
                    className="shrink-0 h-4 w-4 flex items-center justify-center rounded-interactive opacity-0 group-hover:opacity-100 hover:bg-foreground/[0.03] transition-opacity"
                    aria-label={t('desktop.sidebar.unpinApp', { app: entry.label, defaultValue: '取消置顶 {{app}}' })}
                    title={t('desktop.sidebar.unpinApp', { app: entry.label, defaultValue: '取消置顶 {{app}}' })}
                    onClick={event => {
                      event.stopPropagation()
                      unpinApp(entry.id)
                    }}
                  >
                    <PinOff className="h-2.5 w-2.5" />
                  </button>
                }
              />
            )
          })}
          <SidebarMenuItem
            as="button"
            active={activeAppHomeId === DESKTOP_APPS_HOME_ID}
            fullWidth
            onClick={() => onOpenAppHome(DESKTOP_APPS_HOME_ID)}
            leading={
              <span className="shrink-0">
                {renderAppIcon(DESKTOP_APPS_HOME_ID, activeAppHomeId === DESKTOP_APPS_HOME_ID)}
              </span>
            }
            label={t('desktop.sidebar.moreApps', { defaultValue: '更多' })}
          />
        </div>
      </div>

      <div className={cn('mt-2 flex min-h-0 flex-1 flex-col', SIDEBAR_ROW_LIST)}>
        <div className={cn(SIDEBAR_SECTION_HEADER, 'mx-1.5')}>
          <span className={SIDEBAR_SECTION_LABEL}>
            {t('desktop.sidebar.openTabs', { defaultValue: '标签' })}
          </span>
        </div>
        {slots.length === 0 ? (
          <div className={cn('px-3 py-2 text-caption', SIDEBAR_META)}>
            {t('desktop.sidebar.emptyTabs', { defaultValue: '打开网页、文档或终端后，会显示在这里。' })}
          </div>
        ) : (
          <div
            className={cn('min-h-0 flex-1 overflow-y-auto', SIDEBAR_ROW_LIST)}
            data-testid="desktop-sidebar-open-tabs"
            onDragOver={event => {
              if (Array.from(event.dataTransfer.types).includes(DRAG_TYPE_SIDEBAR_PANE)) {
                event.preventDefault()
              }
            }}
            onDrop={handleDropPaneToList}
          >
            {appTabGroups.map(({ appId, slots: appSlots, repItem }) => {
              const appMeta = resolveAppMeta(appId, repItem)
              const appCollapsed = collapsedApps.has(appId)
              // 该应用下只有一个标签时不套组头，避免「Skill → Skills」这种空壳层级。
              // 自动化例外：详情名与应用名不同，单条也要保留「自动化」上级。
              const flattenSingle = appSlots.length === 1 && appId !== 'tabtracker'

              const slotNodes = appSlots.map(slot => {
              if (slot.kind === 'group') {
                const group = slot.group
                const panes = orderedPanesForGroup(group)
                const activePaneId = group.activePaneId || panes[0]?.id
                const activePane = panes.find(pane => pane.id === activePaneId) ?? panes[0] ?? null
                const activePaneTabKey = activePane?.content?.tabKey ?? group.anchorTabKey
                const label = activePaneTabKey
                  ? (tabKeyToItem.get(activePaneTabKey)
                      ? contextRegistry.getTabLabel(tabKeyToItem.get(activePaneTabKey)!)
                      : t('tab.group', { defaultValue: '标签组' }))
                  : t('tab.group', { defaultValue: '标签组' })
                const isGroupActive = panes.some(pane => pane.content?.tabKey === activeTabKey)
                const isExpanded = expandedGroupIds.has(group.id)
                return (
                  <div
                    key={group.id}
                    onDragOver={event => {
                      if (Array.from(event.dataTransfer.types).includes(DRAG_TYPE_TAB_REORDER)) {
                        event.preventDefault()
                      }
                    }}
                    onDrop={event => handleDropOnGroup(event, group)}
                  >
                    <div
                      role="group"
                      aria-label={label}
                      className={cn(
                        'group/tab mx-1.5 mb-1 rounded-interactive border p-1 transition-colors',
                        isGroupActive
                          ? 'border-accent/60 bg-accent/5'
                          : 'border-border/60 bg-foreground/[0.03] hover:bg-foreground/[0.04]',
                      )}
                    >
                      <div className="flex min-w-0 items-center gap-1">
                        <div className="flex min-w-0 flex-1 items-center gap-1">
                          {panes.map(pane => {
                            const tabKey = pane.content?.tabKey ?? null
                            const item = tabKey ? tabKeyToItem.get(tabKey) : null
                            const paneLabel = item
                              ? contextRegistry.getTabLabel(item)
                              : t('desktop.sidebar.emptyPane', { defaultValue: '空 pane' })
                            const paneIcon = item ? contextRegistry.getTabIcon(item) : <Columns2 className={SIDEBAR_ICON} />
                            const isPaneActive = tabKey === activeTabKey
                            return (
                              <button
                                key={pane.id}
                                type="button"
                                className={cn(
                                  'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-interactive px-2 text-left text-body transition-colors',
                                  isPaneActive
                                    ? 'bg-background/80 text-foreground shadow-sm'
                                    : 'text-muted-foreground/80 hover:bg-background/60 hover:text-foreground',
                                )}
                                title={paneLabel}
                                draggable={Boolean(tabKey)}
                                onDragStart={event => startPaneDrag(event, group, pane)}
                                onClick={() => selectPane(group, pane)}
                              >
                                <span className={cn(
                                  SIDEBAR_ICON,
                                  'shrink-0 flex items-center justify-center',
                                  isPaneActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
                                )}>
                                  {paneIcon}
                                </span>
                                <span className={cn('min-w-0 truncate', isPaneActive && SIDEBAR_ROW_LABEL_ACTIVE)}>
                                  {paneLabel}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                        <div className="flex shrink-0 items-center gap-0.5">
                          <button
                            type="button"
                            className="h-6 w-6 flex items-center justify-center rounded-interactive text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03]"
                            aria-label={isExpanded
                              ? t('desktop.sidebar.collapseGroup', { defaultValue: '收起标签组' })
                              : t('desktop.sidebar.expandGroup', { defaultValue: '展开标签组' })}
                            onClick={event => {
                              event.stopPropagation()
                              toggleGroupExpanded(group.id)
                            }}
                          >
                            <ChevronRight className={cn('h-3 w-3 transition-transform', isExpanded && 'rotate-90')} />
                          </button>
                          <button
                            type="button"
                            className="h-6 w-6 flex items-center justify-center rounded-interactive opacity-0 group-hover/tab:opacity-100 text-muted-foreground/60 hover:text-foreground hover:bg-foreground/[0.03] transition-opacity"
                            aria-label={t('tab.menu.splitGroup', { defaultValue: '拆回独立标签' })}
                            onClick={event => {
                              event.stopPropagation()
                              onRestoreGroup(group)
                            }}
                          >
                            <Minimize2 className="h-3 w-3" />
                          </button>
                        </div>
                      </div>
                    </div>
                    {isExpanded && (
                      <div className="ml-5">
                        {panes.map(pane => {
                          const tabKey = pane.content?.tabKey ?? null
                          const item = tabKey ? tabKeyToItem.get(tabKey) : null
                          const paneLabel = item
                            ? contextRegistry.getTabLabel(item)
                            : t('desktop.sidebar.emptyPane', { defaultValue: '空 pane' })
                          const paneIcon = item ? contextRegistry.getTabIcon(item) : null
                          const isPaneActive = tabKey === activeTabKey
                          return (
                            <SidebarMenuItem
                              key={pane.id}
                              as="div"
                              role="button"
                              tabIndex={0}
                              active={isPaneActive}
                              draggable={Boolean(tabKey)}
                              className="group/pane cursor-pointer"
                              onDragStart={event => startPaneDrag(event, group, pane)}
                              onClick={() => selectPane(group, pane)}
                              onKeyDown={event => {
                                if (event.key === 'Enter' || event.key === ' ') {
                                  event.preventDefault()
                                  selectPane(group, pane)
                                }
                              }}
                            >
                              <span className={cn(
                                SIDEBAR_ICON,
                                'shrink-0 flex items-center justify-center',
                                isPaneActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
                              )}>
                                {paneIcon}
                              </span>
                              <span className={cn(
                                SIDEBAR_ROW_LABEL_GROW,
                                isPaneActive && SIDEBAR_ROW_LABEL_ACTIVE,
                              )} title={paneLabel}>
                                {paneLabel}
                              </span>
                              {tabKey && (
                                <button
                                  type="button"
                                  className="shrink-0 h-4 w-4 flex items-center justify-center rounded-interactive opacity-0 group-hover/pane:opacity-100 hover:bg-foreground/[0.03] transition-opacity"
                                  aria-label={t('desktop.sidebar.detachPane', { defaultValue: '移出标签组' })}
                                  onClick={event => {
                                    event.stopPropagation()
                                    closePane(tabScopeKey, group.id, pane.id)
                                    setActiveKey(tabScopeKey, tabKey)
                                  }}
                                >
                                  <Minimize2 className="h-2.5 w-2.5" />
                                </button>
                              )}
                            </SidebarMenuItem>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              }

              const tab = slot.item
              const isActive = tab.tabKey === activeTabKey
              const label = contextRegistry.getTabLabel(tab)
              const icon = contextRegistry.getTabIcon(tab)
              const closable = isClosable(tab)
              const canRename = canRenameOpenTab(tab)
              const isRenaming = canRename && renameEdit.state?.id === tab.tabKey
              return (
                <TooltipProvider key={tab.tabKey} delayDuration={500}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <SidebarMenuItem
                        as="div"
                        role="button"
                        tabIndex={0}
                        active={isActive}
                        draggable={!isRenaming}
                        className="group/tab cursor-pointer"
                        onDragStart={event => startTabDrag(event, tab)}
                        onDragOver={event => {
                          if (Array.from(event.dataTransfer.types).includes(DRAG_TYPE_TAB_REORDER)) {
                            event.preventDefault()
                          }
                        }}
                        onDrop={event => handleDropOnTab(event, tab)}
                        onClick={() => {
                          if (isRenaming) return
                          if (!canRename) {
                            onSelectOpenTab(tab)
                            return
                          }
                          titleClick.schedule(() => onSelectOpenTab(tab))
                        }}
                        onDoubleClick={canRename ? event => {
                          event.preventDefault()
                          event.stopPropagation()
                          titleClick.cancel()
                          renameEdit.start(label, tab.tabKey)
                        } : undefined}
                        onMouseDown={canRename ? event => {
                          if (event.detail > 1) event.preventDefault()
                        } : undefined}
                        onKeyDown={e => {
                          if (isRenaming) return
                          if (e.key === 'Enter') onSelectOpenTab(tab)
                          if (canRename && e.key === 'F2') {
                            e.preventDefault()
                            renameEdit.start(label, tab.tabKey)
                          }
                        }}
                      >
                        <span className={cn(
                          SIDEBAR_ICON,
                          'shrink-0 flex items-center justify-center',
                          isActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
                        )}>
                          {icon}
                        </span>
                        {isRenaming ? (
                          <input
                            className="h-6 min-w-0 flex-1 rounded-sm border border-border/60 bg-background px-1 text-body text-foreground outline-none focus:border-primary focus:ring-0"
                            aria-label={t('home.rename', { defaultValue: '重命名' })}
                            {...renameEdit.getInputProps(commitOpenTabRename)}
                            onDoubleClick={event => event.stopPropagation()}
                          />
                        ) : (
                          <span className={cn(SIDEBAR_ROW_LABEL_GROW, canRename && 'select-none')} title={label}>
                            {label}
                          </span>
                        )}
                        {closable && !isRenaming && (
                          <button
                            type="button"
                            className="shrink-0 h-4 w-4 flex items-center justify-center rounded-interactive opacity-0 group-hover/tab:opacity-100 hover:bg-foreground/[0.03] transition-opacity"
                            aria-label={t('desktop.sidebar.closeTab', { defaultValue: '关闭标签' })}
                            onClick={event => {
                              event.stopPropagation()
                              onCloseItem(tab)
                            }}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        )}
                      </SidebarMenuItem>
                    </TooltipTrigger>
                    {!isRenaming && <TooltipContent side="right">{label}</TooltipContent>}
                  </Tooltip>
                </TooltipProvider>
              )
              })

              if (flattenSingle) {
                return (
                  <div key={`app:${appId}`}>
                    {slotNodes}
                  </div>
                )
              }

              return (
                <div key={`app:${appId}`}>
                  {/* 应用分组头：同应用下有多个标签时才展示，可折叠。
                   * 不在这里加 mb-*：单标签扁平行没有外边距，分组壳若再加 mb-1
                   * 会在「自动化」与下一条 Marketplace/Skills 之间多出一截空隙。
                   * 行距统一由外层 SIDEBAR_ROW_LIST（space-y-0.5）承担。 */}
                  <SidebarMenuItem
                    as="div"
                    role="button"
                    tabIndex={0}
                    className="cursor-pointer"
                    aria-expanded={!appCollapsed}
                    onClick={() => toggleAppCollapsed(appId)}
                    onKeyDown={event => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        toggleAppCollapsed(appId)
                      }
                    }}
                  >
                    <span className={cn(SIDEBAR_ICON, SIDEBAR_ICON_INACTIVE, 'shrink-0 flex items-center justify-center')}>
                      {appMeta.icon}
                    </span>
                    <span className={SIDEBAR_ROW_LABEL_GROW} title={appMeta.label}>
                      {appMeta.label}
                    </span>
                    <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform', !appCollapsed && 'rotate-90')} />
                  </SidebarMenuItem>
                  {!appCollapsed && (
                    <div className="pl-4">
                      {slotNodes}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

DesktopSidebarPanel.displayName = 'DesktopSidebarPanel'
