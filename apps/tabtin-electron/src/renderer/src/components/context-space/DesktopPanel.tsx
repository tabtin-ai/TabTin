import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Folder, Plus, X } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { useTranslation } from 'react-i18next'
import { useSpaceApps } from '@stores/useSpaceApps'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { contextRegistry } from './registry'
import { homeSectionRegistry } from './registry/homeRegistry'
import { EXECUTION_DEVICE_APP_IDS } from './executionDeviceApps'
import type { ContextItem, ContextItemType } from './registry/types'
import { useSpaceContextActions, useSpaceContextState } from './SpaceContextAreaContext'
import { useLocalContextItems } from './hooks/useLocalContextItems'
import {
  type ExecutionDeviceStatus,
  openTerminalSession,
  pickTerminalFocusTarget,
  useCrossAgentTerminalOverview,
} from './terminalOverviewModel'
import { resolveSpaceExecutionDeviceStatus } from './executionDeviceStatus'
import { ExecutionDeviceStatusTag } from './ExecutionDeviceStatusTag'
import { TerminalOverview } from './TerminalOverview'
import {
  getResourceCacheKey,
  useScopedUnifiedResources,
  useUnifiedResources,
} from '@/stores/useUnifiedResources'
import { cn } from '@utils/cn'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { getEffectiveScopeForResourceType, isUserVisibleTabdataResourceItem } from './resourceScope'
import { resolveProjectExecutionWorkspace } from '@/utils/projectExecutionTarget'
import {
  SIDEBAR_ROW_NESTED,
  SIDEBAR_ROW_LABEL_GROW,
  SIDEBAR_ROW_LABEL_ACTIVE,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_SECTION_HEADER,
  SIDEBAR_COUNT,
  SIDEBAR_META,
  SIDEBAR_CHEVRON,
  SIDEBAR_CHEVRON_TRAILING,
  SIDEBAR_ICON,
  SIDEBAR_ICON_STROKE,
  SIDEBAR_ICON_ACTIVE,
  SIDEBAR_ICON_INACTIVE,
  SIDEBAR_LINK_ACTION,
  SIDEBAR_DIVIDER,
  SIDEBAR_ROW_LIST,
  SIDEBAR_DIVIDER_SPACER,
} from '@components/layout/sidebarUi'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import { SidebarTypeEmoji } from '@components/layout/sidebarTypeEmoji'

const DESKTOP_GROUP_ORDER = ['capabilities', 'cloudResources', 'localResources', 'market', 'extensions', 'other'] as const
const DESKTOP_GROUP_LABELS: Record<string, string> = {
  content: 'desktop.group.cloudResources',
  cloudResources: 'desktop.group.cloudResources',
  local: 'desktop.group.localResources',
  localResources: 'desktop.group.localResources',
  capabilities: 'desktop.group.capabilities',
  market: 'desktop.group.market',
  extensions: 'desktop.group.extensions',
  other: 'desktop.group.other',
}

const AGGREGATE_ENTRY_GROUP: Record<string, string> = {
  'cloud-resources': 'cloudResources',
}

const FALLBACK_APP_GROUPS: Record<string, string> = {
  skill: 'cloudResources',
  tabagenda: 'cloudResources',
  tabtracker: 'cloudResources',
  terminal: 'localResources',
  orchestration: 'capabilities',
  marketplace: 'market',
}

const SPACE_GROUP_ID = 'spaces'

const TABFOLDER_HOME_ID = 'tabfolder'

const DESKTOP_MENU_ROW_BUTTON =
  'flex-1 flex items-center gap-2 min-w-0 text-left'
const DESKTOP_MENU_ROW_LABEL = ''

function normalizeDesktopGroup(group: string | null | undefined): string {
  if (group === 'content') return 'cloudResources'
  if (group === 'local') return 'localResources'
  return group || 'other'
}

const HIDDEN_DESKTOP_APP_IDS = new Set<string>([
  // 目录入口由 renderSpaceGroup 渲染成统一目录聚合器，避免和普通 app row 重复。
  'tabfolder',
  // Orchestration 起始页仍作为不可关闭 tab 存在；侧栏入口改由 Space 树承载。
  'orchestration',
])

// ---------------------------------------------------------------------------
// Expand state persistence
// ---------------------------------------------------------------------------

const EXPAND_STORAGE_KEY = 'tabtin:desktop:expandedApps'

function loadExpandedApps(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPAND_STORAGE_KEY)
    if (!raw) return new Set([TABFOLDER_HOME_ID])
    const expanded = new Set<string>(JSON.parse(raw))
    if (expanded.delete(SPACE_GROUP_ID)) {
      expanded.add(TABFOLDER_HOME_ID)
    }
    return expanded
  } catch { return new Set([TABFOLDER_HOME_ID]) }
}

function saveExpandedApps(s: Set<string>) {
  try { localStorage.setItem(EXPAND_STORAGE_KEY, JSON.stringify([...s])) } catch { /* noop */ }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

function useResourceCountByType(spaceId: string): Map<string, number> {
  const requestedScope = useSpaceViewPrefsStore(s => s.getPrefs(spaceId).resourceScope)
  const { resources: spaceResources } = useScopedUnifiedResources(spaceId, 'space')
  const { resources: organizationResources } = useScopedUnifiedResources(spaceId, 'organization')
  const loadResources = useUnifiedResources(s => s.load)
  const organizationCacheKey = getResourceCacheKey(spaceId, 'organization') ?? `${spaceId}:organization`
  const hasOrganizationBucket = useUnifiedResources(
    s => Object.prototype.hasOwnProperty.call(s.resourcesBySpaceId, organizationCacheKey),
  )
  const localItems = useLocalContextItems(spaceId)

  useEffect(() => {
    if (requestedScope !== 'organization') return
    void loadResources(spaceId, false, 'organization')
  }, [loadResources, requestedScope, spaceId])

  return useMemo(() => {
    const counts = new Map<string, number>()
    const isUserVisibleCloudResource = (
      item: { item_type: string; is_archived?: boolean; metadata?: Record<string, unknown> | null },
    ) => {
      if (item.is_archived) return false
      return isUserVisibleTabdataResourceItem(item)
    }
    const pushCount = (itemType: string) => {
      counts.set(itemType, (counts.get(itemType) || 0) + 1)
    }

    for (const item of spaceResources) {
      if (!isUserVisibleCloudResource(item)) continue
      const effectiveScope = getEffectiveScopeForResourceType(requestedScope, item.item_type)
      if (effectiveScope === 'space' || !hasOrganizationBucket) {
        pushCount(item.item_type)
      }
    }

    if (requestedScope === 'organization' && hasOrganizationBucket) {
      for (const item of organizationResources) {
        if (!isUserVisibleCloudResource(item)) continue
        if (getEffectiveScopeForResourceType(requestedScope, item.item_type) === 'organization') {
          pushCount(item.item_type)
        }
      }
    }

    for (const item of localItems) {
      pushCount(item.item_type)
    }
    return counts
  }, [hasOrganizationBucket, localItems, requestedScope, spaceResources, organizationResources])
}

function getAppIdForItem(item: ContextItem): string {
  if (item.type === 'apphome') {
    const metaAppId = item.meta?.appId
    return typeof metaAppId === 'string' ? metaAppId : item.id
  }
  const handler = contextRegistry.getHandler(item.type)
  return handler?.appId ?? item.type
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface DesktopPanelProps {
  spaceId: string
  activeAppHomeId?: string | null
  onOpenAppHome: (appId: string) => void
  onSelectOpenTab: (item: ContextItem) => void
}

export const DesktopPanel: React.FC<DesktopPanelProps> = ({
  spaceId,
  activeAppHomeId = null,
  onOpenAppHome,
  onSelectOpenTab,
}) => {
  // PRD §4.3 红线 #5：DesktopPanel 的"已打开 tab 列表"是用户感知入口，用 visibleItems。
  // 跨 session 的 subagent_session 在 tabOrder 持久化里仍存在但不在当前列表显示。
  const { visibleItems, activeTabKey, tabScopeKey } = useSpaceContextState()
  const { createHandlers, onCloseItem } = useSpaceContextActions()
  const { t } = useTranslation('context')

  const getEnabledApps = useSpaceApps(s => s.getEnabledApps)
  const spaceApps = useSpaceApps(s => s.appsBySpace[spaceId])
  const spaces = useSpaceStore(s => s.spaces)
  const space = useMemo(() => spaces.find(sp => sp.id === spaceId) ?? null, [spaces, spaceId])
  const selectedAgent = useSpaceStore(s => s.selectedAgent)
  const agentCache = useSpaceStore(s => s.agentCache)
  const currentDevice = useDeviceStore(s => s.currentDevice ?? null)
  const devices = useDeviceStore(s => s.devices)

  const resourceCounts = useResourceCountByType(spaceId)
  // §5.5：跨 Agent 终端总览（仅用户终端 + 从对话显式打开的会话）
  const terminalOverview = useCrossAgentTerminalOverview()
  const [expandedApps, setExpandedApps] = useState<Set<string>>(loadExpandedApps)
  const executionWorkspace = useMemo(
    () => resolveProjectExecutionWorkspace(space, spaces),
    [space, spaces],
  )
  const agent = useMemo(() => {
    if (executionWorkspace?.type !== 'workspace') return null
    const agentId = executionWorkspace.execution_agent_id ?? executionWorkspace.agent_id ?? null
    return agentId ? (agentCache[agentId] ?? (selectedAgent?.id === agentId ? selectedAgent : null)) : null
  }, [
    agentCache,
    selectedAgent,
    executionWorkspace?.execution_agent_id,
    executionWorkspace?.agent_id,
    executionWorkspace?.type,
  ])
  const organizationSpaces = useMemo(() => {
    const organizationId = space?.organization_id ?? null
    if (!organizationId) return []
    return spaces
      .filter(sp => sp.organization_id === organizationId && sp.type === 'workspace' && !sp.is_archived)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  }, [space?.organization_id, spaces])
  const executionDeviceStatus = useMemo(
    () => resolveSpaceExecutionDeviceStatus(executionWorkspace, agent, currentDevice, devices, t),
    [executionWorkspace, agent, currentDevice, devices, t],
  )

  // §5.5：给跨 Agent 总览按 spaceId 解析各自 Agent 的执行设备状态。
  // 其他 Agent 记录未在 agentCache 时返回 null（不显示徽标，避免误标「未绑定」）。
  const resolveDeviceStatus = useCallback((targetSpaceId: string): ExecutionDeviceStatus | null => {
    if (targetSpaceId === spaceId) return executionDeviceStatus
    const sp = spaces.find(s => s.id === targetSpaceId)
    const agentId = sp?.execution_agent_id ?? sp?.agent_id ?? null
    const ag = agentId ? agentCache[agentId] : null
    return resolveSpaceExecutionDeviceStatus(sp, ag, currentDevice, devices, t)
  }, [spaceId, executionDeviceStatus, spaces, agentCache, currentDevice, devices, t])

  const toggleExpand = useCallback((appId: string) => {
    setExpandedApps(prev => {
      const next = new Set(prev)
      if (next.has(appId)) next.delete(appId)
      else next.add(appId)
      saveExpandedApps(next)
      return next
    })
  }, [])

  const handleOpenTabFolder = useCallback(() => {
    useSpaceContextTabsStore.getState().openResourceTab(tabScopeKey, {
      type: 'apphome',
      id: TABFOLDER_HOME_ID,
      title: t('desktop.spaceGroup', { defaultValue: '目录' }),
      meta: {
        appId: 'tabfolder',
      },
    })
  }, [tabScopeKey, t])

  // ── App entries (enabled apps with App home or create action) ──

  const appEntries = useMemo(() => {
    // Keep this memo subscribed to per-space app changes; getEnabledApps is a stable store helper.
    void spaceApps
    const enabledApps = getEnabledApps(spaceId)
    const seenAppIds = new Set<string>()

    const entries = enabledApps
      .filter(appInfo => !HIDDEN_DESKTOP_APP_IDS.has(appInfo.id))
      .map(appInfo => {
        seenAppIds.add(appInfo.id)
        const handler = contextRegistry.getHandler(appInfo.id as ContextItemType)
        const hasAppHome = homeSectionRegistry.has(appInfo.id) || Boolean(handler?.sidebarPanel)
        const canCreate = Boolean(createHandlers[appInfo.id])
        if (!hasAppHome && !canCreate) return null
        return {
          appId: appInfo.id,
          appInfo,
          handler,
          hasAppHome,
          canCreate,
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))

    for (const regHandler of contextRegistry.getAppEntries()) {
      const appId = regHandler.appId ?? (regHandler.type as string)
      if (HIDDEN_DESKTOP_APP_IDS.has(appId)) continue
      if (seenAppIds.has(appId)) continue
      if (!regHandler.sidebarPanel && !homeSectionRegistry.has(appId)) continue
      seenAppIds.add(appId)
      entries.push({
        appId,
        appInfo: {
          id: appId,
          name: regHandler.displayLabel || appId,
          icon: '',
          can_create: false,
          searchable: false,
          enabled: true,
          order: 999,
          desktop_group: FALLBACK_APP_GROUPS[appId] ?? 'capabilities',
        },
        handler: regHandler,
        hasAppHome: true,
        canCreate: Boolean(createHandlers[appId]),
      })
    }

    return entries
  }, [createHandlers, getEnabledApps, spaceId, spaceApps])

  // ── Group open tabs by app ──

  const tabsByApp = useMemo(() => {
    const map = new Map<string, ContextItem[]>()
    for (const item of visibleItems) {
      const appId = getAppIdForItem(item)
      if (!map.has(appId)) map.set(appId, [])
      map.get(appId)!.push(item)
    }
    return map
  }, [visibleItems])

  // ── Aggregate groups (cloud-resources etc.) ──

  const aggregateGroups = useMemo(() => contextRegistry.getAggregateGroups(), [])

  const aggregateTabs = useMemo(() => {
    const result = new Map<string, ContextItem[]>()
    for (const [aggId, appIds] of aggregateGroups) {
      const tabs: ContextItem[] = []
      for (const appId of appIds) {
        const appTabs = tabsByApp.get(appId)
        if (appTabs) {
          for (const tab of appTabs) {
            if (tab.type !== 'apphome') tabs.push(tab)
          }
        }
      }
      if (tabs.length > 0) result.set(aggId, tabs)
    }
    return result
  }, [aggregateGroups, tabsByApp])

  // ── Group apps by desktop_group (driven by backend ui_contract) ──

  const groupedApps = useMemo(() => {
    const groupMap = new Map<string, (typeof appEntries)[number][]>()

    for (const entry of appEntries) {
      const group = normalizeDesktopGroup(FALLBACK_APP_GROUPS[entry.appId] ?? entry.appInfo.desktop_group)
      if (!groupMap.has(group)) groupMap.set(group, [])
      groupMap.get(group)!.push(entry)
    }

    const aggregateGroupIds = new Set<string>()
    for (const aggId of aggregateGroups.keys()) {
      const group = AGGREGATE_ENTRY_GROUP[aggId] ?? 'other'
      aggregateGroupIds.add(group)
      if (!groupMap.has(group)) groupMap.set(group, [])
    }

    const groups: { id: string; label: string; entries: (typeof appEntries)[number][] }[] = []

    for (const groupId of DESKTOP_GROUP_ORDER) {
      const entries = groupMap.get(groupId)
      if ((!entries || entries.length === 0) && !aggregateGroupIds.has(groupId) && groupId !== 'capabilities') continue
      const sortedEntries = entries ?? []
      sortedEntries.sort((a, b) => (a.appInfo.order ?? 0) - (b.appInfo.order ?? 0))
      groups.push({
        id: groupId,
        label: t(DESKTOP_GROUP_LABELS[groupId] || 'desktop.group.other', { defaultValue: groupId }),
        entries: sortedEntries,
      })
    }

    for (const [groupId, entries] of groupMap) {
      if ((DESKTOP_GROUP_ORDER as readonly string[]).includes(groupId)) continue
      if (entries.length === 0 && !aggregateGroupIds.has(groupId)) continue
      entries.sort((a, b) => (a.appInfo.order ?? 0) - (b.appInfo.order ?? 0))
      groups.push({
        id: groupId,
        label: t(`desktop.group.${groupId}`, { defaultValue: groupId }),
        entries,
      })
    }

    return groups
  }, [aggregateGroups, appEntries, t])

  // ── Open App home page in main content area ──

  const openAppHome = useCallback((entry: (typeof appEntries)[number]) => {
    if (entry.appId === 'terminal') {
      const focus = pickTerminalFocusTarget(spaceId, visibleItems, terminalOverview)
      if (focus?.kind === 'openTab') {
        onSelectOpenTab(focus.item)
        return
      }
      if (focus?.kind === 'session') {
        void openTerminalSession(focus.session)
      }
      return
    }
    if (entry.hasAppHome) {
      onOpenAppHome(entry.appId)
      return
    }
    if (entry.canCreate) {
      const appId = entry.appId
      createHandlers[appId]?.()
    }
  }, [createHandlers, onOpenAppHome, onSelectOpenTab, spaceId, terminalOverview, visibleItems])

  // ── Render helpers ──

  const renderOpenTabs = (tabs: ContextItem[], parentAppId: string, showAppHome: boolean, showCreate: boolean) => (
    <div className={cn('mb-0.5 flex flex-col', SIDEBAR_ROW_LIST)}>
      {tabs.map(tab => {
        const isActive = tab.tabKey === activeTabKey
        const tabLabel = contextRegistry.getTabLabel(tab)
        const tabIcon = contextRegistry.getTabIcon(tab)
        return (
          <TooltipProvider key={tab.tabKey} delayDuration={500}>
            <Tooltip>
              <TooltipTrigger asChild>
                <SidebarMenuItem
                  as="div"
                  role="button"
                  tabIndex={0}
                  active={isActive}
                  className={cn(SIDEBAR_ROW_NESTED, 'group/tab cursor-pointer')}
                  onClick={() => onSelectOpenTab(tab)}
                  onKeyDown={e => { if (e.key === 'Enter') onSelectOpenTab(tab) }}
                >
                  <span className={cn(
                    SIDEBAR_ICON,
                    'shrink-0 flex items-center justify-center',
                    isActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
                  )}>
                    {tabIcon}
                  </span>
                  <span className={cn(SIDEBAR_ROW_LABEL_GROW, DESKTOP_MENU_ROW_LABEL, isActive && SIDEBAR_ROW_LABEL_ACTIVE)} title={tabLabel}>{tabLabel}</span>
                  <button
                    type="button"
                    className="shrink-0 h-4 w-4 flex items-center justify-center rounded-interactive opacity-0 group-hover/tab:opacity-100 hover:bg-foreground/[0.03] transition-opacity"
                    onClick={e => { e.stopPropagation(); onCloseItem(tab) }}
                  >
                    <X className="h-2.5 w-2.5" />
                  </button>
                </SidebarMenuItem>
              </TooltipTrigger>
              <TooltipContent side="right">{tabLabel}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )
      })}
      {(showAppHome || showCreate) && (
        <div className={cn('flex items-center gap-1.5', SIDEBAR_ROW_NESTED, 'px-3 py-1')}>
          {showAppHome && (
            <button
              type="button"
              className={SIDEBAR_LINK_ACTION}
              onClick={() => onOpenAppHome(parentAppId)}
            >
              {t('desktop.viewAll', { defaultValue: 'View all' })}
            </button>
          )}
          {showAppHome && showCreate && (
            <span className={SIDEBAR_META}>/</span>
          )}
          {showCreate && (
            <button
              type="button"
              className={cn(SIDEBAR_LINK_ACTION, 'flex items-center gap-1')}
              onClick={() => createHandlers[parentAppId]?.()}
            >
              <Plus className="h-3 w-3" />
              <span>{t('desktop.create', { defaultValue: 'New' })}</span>
            </button>
          )}
        </div>
      )}
    </div>
  )

  const renderAppRow = (entry: (typeof appEntries)[number]) => {
    const { appId, appInfo, handler, hasAppHome, canCreate } = entry
    const name = t(`appName.${appId}`, { defaultValue: appInfo?.name || handler?.displayLabel || appId })
    const openTabs = tabsByApp.get(appId) ?? []
    const visibleOpenTabs = openTabs.filter(tab => tab.type !== 'apphome')
    const hasOpenTabs = visibleOpenTabs.length > 0
    // §5.5：终端行展开的是「跨 Agent 总览」（含其他 Agent + 隐藏 agent transcript），
    // 不再只是当前 Space 的已打开 tab——所以展开判定 / 计数都走 overview。
    // B5：终端行**恒可展开**（即使全静默），让展开区始终能给出「还没有终端在跑 +
    // 新建终端」的空态占位，恢复新建入口、给焦虑用户一句安心话。
    const isTerminalApp = appId === 'terminal'
    const hasChildren = isTerminalApp ? true : hasOpenTabs
    // 计数徽标：终端显示「全部 Agent 运行中数」（缓解假运行焦虑）；其余沿用资源计数。
    const count = isTerminalApp
      ? terminalOverview.runningCount
      : resourceCounts.get(appId) ?? (handler ? (resourceCounts.get(handler.type) ?? 0) : 0)
    const isExpanded = hasChildren && expandedApps.has(appId)
    const isAppHomeActive = activeAppHomeId === appId
    const statusBadge = EXECUTION_DEVICE_APP_IDS.has(appId) ? executionDeviceStatus : null

    return (
      <div key={appId}>
        <SidebarMenuItem as="div" active={isAppHomeActive} className="select-none group">
          <button
            type="button"
            className={DESKTOP_MENU_ROW_BUTTON}
            onClick={() => {
              openAppHome(entry)
            }}
          >
            <span className={cn(
              'shrink-0',
              isAppHomeActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
            )}>
              <SidebarTypeEmoji appIdOrType={appId} active={isAppHomeActive} />
            </span>
            <span className={cn(
              SIDEBAR_ROW_LABEL_GROW,
              DESKTOP_MENU_ROW_LABEL,
              isAppHomeActive && SIDEBAR_ROW_LABEL_ACTIVE,
            )} title={name}>
              {name}
            </span>
            {statusBadge && (
              <ExecutionDeviceStatusTag status={statusBadge} />
            )}
            {isTerminalApp && count > 0 && (
              <span className={SIDEBAR_COUNT}>{count}</span>
            )}
          </button>
          {hasChildren && (
            <button
              type="button"
              className={SIDEBAR_CHEVRON_TRAILING}
              onClick={() => toggleExpand(appId)}
              aria-label={isExpanded ? t('desktop.collapse', { defaultValue: 'Collapse' }) : t('desktop.expand', { defaultValue: 'Expand' })}
            >
              <ChevronRight className={cn(SIDEBAR_CHEVRON, 'transition-transform duration-150', isExpanded && 'rotate-90')} />
            </button>
          )}
        </SidebarMenuItem>
        {isExpanded && (isTerminalApp
          ? (
            <TerminalOverview
              overview={terminalOverview}
              activeTabKey={activeTabKey}
              resolveDeviceStatus={resolveDeviceStatus}
              onCreateTerminal={canCreate ? () => createHandlers[appId]?.() : undefined}
            />
          )
          : renderOpenTabs(visibleOpenTabs, appId, hasAppHome, canCreate))}
      </div>
    )
  }

  // ── Aggregate entry rows ──

  const renderAggregateEntry = (aggId: string) => {
    const aggTabs = aggregateTabs.get(aggId) ?? []
    const hasOpenTabs = aggTabs.length > 0
    const isExpanded = hasOpenTabs && expandedApps.has(aggId)
    const isAggHomeActive = activeAppHomeId === aggId
    const hasAggHome = homeSectionRegistry.has(aggId)

    return (
      <div key={aggId}>
        <SidebarMenuItem as="div" active={isAggHomeActive} className="select-none group">
          <button
            type="button"
            className={DESKTOP_MENU_ROW_BUTTON}
            onClick={() => {
              if (hasAggHome) onOpenAppHome(aggId)
            }}
          >
            <span className={cn(
              'shrink-0 transition-all',
              isAggHomeActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
            )}>
              <SidebarTypeEmoji appIdOrType="cloud-resources" active={isAggHomeActive} />
            </span>
            <span className={cn(
              SIDEBAR_ROW_LABEL_GROW,
              DESKTOP_MENU_ROW_LABEL,
              isAggHomeActive && SIDEBAR_ROW_LABEL_ACTIVE,
            )}>
              {t('home.cloudDrive', { defaultValue: 'Cloud Drive' })}
            </span>
          </button>
          {hasOpenTabs && (
            <button
              type="button"
              className={SIDEBAR_CHEVRON_TRAILING}
              onClick={() => toggleExpand(aggId)}
              aria-label={isExpanded ? t('desktop.collapse', { defaultValue: 'Collapse' }) : t('desktop.expand', { defaultValue: 'Expand' })}
            >
              <ChevronRight className={cn(SIDEBAR_CHEVRON, 'transition-transform duration-150', isExpanded && 'rotate-90')} />
            </button>
          )}
        </SidebarMenuItem>
        {isExpanded && renderOpenTabs(aggTabs, aggId, hasAggHome, false)}
      </div>
    )
  }

  const renderAggregateEntriesForGroup = (groupId: string) => {
    const entries = [...aggregateGroups.keys()].filter(aggId => (AGGREGATE_ENTRY_GROUP[aggId] ?? 'other') === groupId)
    if (entries.length === 0) return null
    return (
      <div className={cn('flex flex-col', SIDEBAR_ROW_LIST)}>
        {entries.map(aggId => renderAggregateEntry(aggId))}
      </div>
    )
  }

  // Space 身份入口：Folder + Space 名，点击打开 Agent 目录（orchestration 起始页）。
  // 原先在左侧栏快捷入口（element B），现收口到「能力」分组，桌面 tab 与桌面模式侧栏一致。
  const renderSpaceEntry = () => {
    const isActive = activeAppHomeId === 'orchestration'
    // 与 Agent 起始页标签同源：用当前 Space 名命名「xxx的目录」，比统一的「Space目录」更可辨识；
    // 名字已含 Space 信息，右侧不再重复展示 Space 名 badge。
    const label = space?.name
      ? t('tab.agentWorkingDir', { name: space.name })
      : t('desktop.spaceDirectory', { defaultValue: 'Space目录' })
    return (
      <SidebarMenuItem as="div" active={isActive} className="select-none group">
        <button
          type="button"
          className={DESKTOP_MENU_ROW_BUTTON}
          onClick={() => onOpenAppHome('orchestration')}
        >
          <span className={cn(
            'shrink-0 transition-all',
            isActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
          )}>
            <Folder className={SIDEBAR_ICON} strokeWidth={SIDEBAR_ICON_STROKE} />
          </span>
          <span className={cn(
            SIDEBAR_ROW_LABEL_GROW,
            DESKTOP_MENU_ROW_LABEL,
            isActive && SIDEBAR_ROW_LABEL_ACTIVE,
          )} title={label}>
            {label}
          </span>
        </button>
      </SidebarMenuItem>
    )
  }

  const renderSpaceGroup = () => {
    const isActive = activeAppHomeId === 'tabfolder'
    const openFolderTabs = tabsByApp.get(TABFOLDER_HOME_ID) ?? []
    const visibleOpenFolderTabs = openFolderTabs.filter(tab => tab.type !== 'apphome')
    const hasOpenFolders = visibleOpenFolderTabs.length > 0
    const isExpanded = hasOpenFolders && expandedApps.has(TABFOLDER_HOME_ID)

    return (
      <div key={SPACE_GROUP_ID}>
        <SidebarMenuItem as="div" active={isActive} className="select-none group">
          <button
            type="button"
            className={DESKTOP_MENU_ROW_BUTTON}
            onClick={() => {
              handleOpenTabFolder()
            }}
          >
            <span className={cn(
              'shrink-0',
              isActive ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
            )}>
              <SidebarTypeEmoji appIdOrType="tabfolder" />
            </span>
            <span className={cn(
              SIDEBAR_ROW_LABEL_GROW,
              DESKTOP_MENU_ROW_LABEL,
              isActive && SIDEBAR_ROW_LABEL_ACTIVE,
            )}>
              {t('desktop.spaceGroup', { defaultValue: '目录' })}
            </span>
          </button>
          {hasOpenFolders && (
            <button
              type="button"
              className={SIDEBAR_CHEVRON_TRAILING}
              onClick={() => toggleExpand(TABFOLDER_HOME_ID)}
              aria-label={isExpanded ? t('desktop.collapse', { defaultValue: 'Collapse' }) : t('desktop.expand', { defaultValue: 'Expand' })}
            >
              <ChevronRight className={cn(SIDEBAR_CHEVRON, 'transition-transform duration-150', isExpanded && 'rotate-90')} />
            </button>
          )}
        </SidebarMenuItem>
        {isExpanded && renderOpenTabs(visibleOpenFolderTabs, TABFOLDER_HOME_ID, true, false)}
      </div>
    )
  }

  const hasAggregateEntries = aggregateGroups.size > 0
  const hasVisibleRows = organizationSpaces.length > 0 || groupedApps.some(group => group.entries.length > 0 || [...aggregateGroups.keys()].some(aggId => (AGGREGATE_ENTRY_GROUP[aggId] ?? 'other') === group.id))

  return (
    <div className="scrollbar-hover h-full w-full overflow-y-auto py-1">
      <div className="min-w-0 w-full">
        {groupedApps.map((group, gi) => (
          <div key={group.id}>
            {gi > 0 && <div className={cn(SIDEBAR_DIVIDER_SPACER, SIDEBAR_DIVIDER)} />}
            <div className={SIDEBAR_SECTION_HEADER}>
              <span className={SIDEBAR_SECTION_LABEL}>{group.label}</span>
            </div>
            <div className={cn('flex flex-col', SIDEBAR_ROW_LIST)}>
              {group.id === 'capabilities' && renderSpaceEntry()}
              {group.id === 'capabilities' && renderSpaceGroup()}
              {renderAggregateEntriesForGroup(group.id)}
              {group.entries.map(entry => renderAppRow(entry))}
            </div>
          </div>
        ))}
        {!hasVisibleRows && !hasAggregateEntries && (
          <div className={cn('flex flex-col items-center justify-center py-12', SIDEBAR_META)}>
            <p className="text-body">{t('apps.empty', { defaultValue: 'No apps enabled' })}</p>
          </div>
        )}
      </div>
    </div>
  )
}

DesktopPanel.displayName = 'DesktopPanel'
