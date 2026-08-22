/**
 * SpaceSwitcherPopover —— 执行 Space 切换器（收口入口）
 *
 * 桌面 / 对话 / Space 边界改造 Phase 2：左侧栏不再承载「选 Space / Agent 目录」
 * （桌面是跨 Space 共享的公共工作面，不做 Space 导航，见
 * docs/prd/desktop-conversation-space-boundary.md §1.1 / §1.2 / §5）。
 *
 * 选 / 切执行 Space 收口到本组件，挂在「对话面板执行区」（ChatInput 的「执行于」
 * 指示）与冷启动占位上。trigger 由 children 提供（asChild），popover 内容是
 * 当前 organization 的 workspace Space 列表（搜索 + pin + 新建）。
 *
 * 默认行为仍兼容冷启动占位：selectSpace 切换整个 workbench 的 selectedSpace +
 * 前台场景。ChatInput 草稿态会传 `onSelectSpace`，只更新该草稿的执行目标，
 * 不改桌面 / 对话标签池。
 */
import React, { useCallback, useMemo, useState } from 'react'
import { Check, Search, X, Pin, PinOff } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { useSpaceListStore } from '@stores/useSpaceListStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useDeviceStore } from '@stores/useDeviceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useIMStore } from '@stores/useIMStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useWorkbenchSceneStore } from '@/stores/useWorkbenchSceneStore'
import { alignChatPointerToWorkspace } from '@/stores/chat/session/reconcileSpacePointer'
import type { SpaceListItem } from '@tabtin/app-shell'
import { compareWorkspaceListOrder } from '@/utils/workspace-list-sort'
import { isProjectCompanionWorkspace } from '@/utils/projectExecutionTarget'
import {
  isCurrentDeviceControl,
  isWorkspaceExecutionSelectable,
} from '@/services/deviceControlMatch'
import { useAccountDevicesQuery } from '@/hooks/queries/accountDevices'
import { useEffectiveFeature } from '@/hooks/useEffectiveFeature'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  ScrollArea,
} from '@components/ui'
import {
  SIDEBAR_ICON_SM,
  SIDEBAR_META,
  SIDEBAR_DIVIDER,
  SIDEBAR_ROW_LIST,
} from '@components/layout/sidebarUi'
import { SidebarMenuItem } from '@components/layout/SidebarMenuItem'
import { ExecutionDeviceStatusTag } from '@components/context-space/ExecutionDeviceStatusTag'
import {
  resolveSpaceControlDeviceId,
  resolveSpaceExecutionDeviceStatus,
} from '@components/context-space/executionDeviceStatus'

const DAEMON_CONTROL_EXECUTOR_ROLE = 2
const DAEMON_CONTROL_ACTIVE = 1

const LazyNewSpaceButton = React.lazy(() =>
  import('@components/sidebar/NewSpaceButton').then(m => ({ default: m.NewSpaceButton }))
)

interface SpaceSwitcherPopoverProps {
  /** 当前执行 Space id（高亮）。无选中时传 null。 */
  currentSpaceId: string | null
  /** 草稿态可覆盖默认全局切换行为，只更新当前对话/桌面的执行目标。 */
  onSelectSpace?: (space: SpaceListItem) => void
  /** 供外层浮层协调：打开选择器时关闭同一 trigger 的 hover 提示。 */
  onOpenChange?: (open: boolean) => void
  /** 自定义 trigger（asChild）。 */
  children: React.ReactNode
  align?: 'start' | 'center' | 'end'
  side?: 'top' | 'bottom'
  contentClassName?: string
}

export const SpaceSwitcherPopover: React.FC<SpaceSwitcherPopoverProps> = ({
  currentSpaceId,
  onSelectSpace,
  onOpenChange,
  children,
  align = 'start',
  side = 'top',
  contentClassName,
}) => {
  const { t } = useTranslation(['sidebar'])
  const { t: tContext } = useTranslation('context')
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const closePicker = useCallback(() => {
    setOpen(false)
    onOpenChange?.(false)
    setSearchQuery('')
  }, [onOpenChange])

  const spaces = useSpaceStore(s => s.spaces)
  const agentCache = useSpaceStore(s => s.agentCache)
  const devices = useDeviceStore(s => s.devices)
  const currentDevice = useDeviceStore(s => s.currentDevice)
  const conversations = useIMStore(s => s.conversations)
  const unreadCounts = useIMStore(s => s.unreadCounts)
  const getSpaceList = useSpaceListStore(s => s.getSpaceList)
  const selectSpace = useSpaceListStore(s => s.selectSpace)
  const activateForegroundSpace = useWorkbenchSceneStore(s => s.activateForegroundSpace)
  const closeSettings = useSettingsSpaceStore(s => s.closeSettings)
  const pinnedAgentIds = useSpaceViewPrefsStore(s => s.pinnedAgentIds)
  const togglePinnedAgent = useSpaceViewPrefsStore(s => s.togglePinnedAgent)
  const workspaceListSortMode = useSpaceViewPrefsStore(s => s.workspaceListSortMode)
  const selectedOrganizationId = useOrganizationStore(s => s.selectedOrganization?.id ?? null)
  const daemonControlAvailable = useEffectiveFeature('daemon_control', selectedOrganizationId).enabled
  const { data: accountDevices = [] } = useAccountDevicesQuery({
    enabled: daemonControlAvailable && open,
  })

  const spaceList = useMemo(
    () => getSpaceList(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [spaces, conversations, unreadCounts, getSpaceList],
  )

  // 只展示当前 organization 的 workspace Space（与原左侧栏选 Space 模块口径一致）；
  // 群聊 / 私信是另一维度的实体，不混进 Space 切换器。
  const organizationScopedSpaceList = useMemo(() => {
    if (!selectedOrganizationId) return []
    const companionWorkspaceIds = new Set(
      spaces.filter(isProjectCompanionWorkspace).map(space => space.id),
    )
    return spaceList.filter(
      sp => (
        sp.organization_id === selectedOrganizationId
        && sp.navigationKind === 'workspace'
        && !companionWorkspaceIds.has(sp.source_id)
      ),
    )
  }, [spaceList, selectedOrganizationId, spaces])

  // 与侧栏 WORKSPACE 同一套排序偏好，不再把当前项强行置顶。
  const orderedList = useMemo(() => {
    const spaceById = new Map(spaces.map(space => [space.id, space]))
    return [...organizationScopedSpaceList].sort((left, right) => {
      const leftSpace = spaceById.get(left.source_id)
      const rightSpace = spaceById.get(right.source_id)
      return compareWorkspaceListOrder(
        {
          id: left.source_id,
          name: left.name,
          lastActivityAt: leftSpace?.last_activity_at,
        },
        {
          id: right.source_id,
          name: right.name,
          lastActivityAt: rightSpace?.last_activity_at,
        },
        workspaceListSortMode,
      )
    })
  }, [organizationScopedSpaceList, spaces, workspaceListSortMode])

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return orderedList
    const q = searchQuery.toLowerCase()
    return orderedList.filter(sp => sp.name.toLowerCase().includes(q))
  }, [orderedList, searchQuery])

  // Daemon Control 仅用来补充账号设备；Workspace 的绑定和在线真源仍是现有 Device store。
  const devicesWithoutWorkspace = useMemo(() => {
    if (!daemonControlAvailable || !selectedOrganizationId || accountDevices.length === 0) return []
    const organizationDevices = devices.filter(
      device => device.organization_id === selectedOrganizationId,
    )
    const workspaceDeviceIds = new Set<string>()
    for (const item of organizationScopedSpaceList) {
      const workspace = spaces.find(space => space.id === item.source_id)
      const agentId = workspace?.execution_agent_id ?? workspace?.agent_id ?? null
      const agent = agentId ? agentCache[agentId] : null
      const deviceId = resolveSpaceControlDeviceId(workspace, agent)
      if (deviceId) workspaceDeviceIds.add(deviceId)
    }
    return accountDevices.filter((device) => {
      if (device.control_state !== DAEMON_CONTROL_ACTIVE) return false
      if (!device.roles.includes(DAEMON_CONTROL_EXECUTOR_ROLE)) return false
      const matchingLegacyDevices = organizationDevices.filter(
        legacyDevice => legacyDevice.fingerprint === device.installation_id,
      )
      return matchingLegacyDevices.length > 0
        && matchingLegacyDevices.every(legacyDevice => !workspaceDeviceIds.has(legacyDevice.id))
    })
  }, [accountDevices, agentCache, daemonControlAvailable, devices, organizationScopedSpaceList, selectedOrganizationId, spaces])

  const handleSelect = useCallback((space: SpaceListItem, selectable: boolean) => {
    if (!selectable) return
    if (onSelectSpace) {
      onSelectSpace(space)
      closePicker()
      return
    }
    closeSettings()
    selectSpace(space)
    if (space.navigationKind === 'workspace') {
      activateForegroundSpace(space.source_id)
      // ：默认路径会切整个 workbench 的 selectedSpace，同步对齐 chat 指针
      alignChatPointerToWorkspace(space.source_id)
    }
    closePicker()
  }, [onSelectSpace, closeSettings, selectSpace, activateForegroundSpace, closePicker])

  return (
    <Popover open={open} onOpenChange={(o) => {
      setOpen(o)
      onOpenChange?.(o)
      if (!o) setSearchQuery('')
    }}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side={side}
        align={align}
        className={cn('w-64 p-0 surface-glass-overlay rounded-interactive', contentClassName)}
        sideOffset={6}
      >
        <div className={cn('p-2', SIDEBAR_DIVIDER)}>
          <div className="relative">
            <Search className={cn('absolute left-2 top-1/2 -translate-y-1/2 pointer-events-none', SIDEBAR_ICON_SM, 'text-muted-foreground/60')} />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('sidebar.filterAgents', { defaultValue: '筛选工作空间...' })}
              className="w-full h-7 pl-7 pr-7 rounded-interactive border border-transparent bg-muted/30 text-body text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-inset focus:ring-ring transition-colors"
              autoFocus
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground/60 hover:text-foreground transition-colors">
                <X className={SIDEBAR_ICON_SM} />
              </button>
            )}
          </div>
        </div>
        <ScrollArea className="max-h-64" scrollBar="vertical" type="scroll">
          <div className={cn('py-1', SIDEBAR_ROW_LIST)}>
            {filtered.map((space) => {
              const isActive = space.source_id === currentSpaceId || space.id === currentSpaceId
              const isPinned = pinnedAgentIds.includes(space.source_id)
              const rawId = space.source_id
              const fullSp = space.navigationKind === 'workspace' ? spaces.find(s => s.id === rawId) : null
              const agentId = fullSp?.execution_agent_id ?? fullSp?.agent_id ?? null
              const agent = agentId ? agentCache[agentId] : null
              const ctrlDevId = resolveSpaceControlDeviceId(fullSp, agent)
              const dev = ctrlDevId ? devices.find(d => d.id === ctrlDevId) : null
              const selectable = space.navigationKind !== 'workspace' || isWorkspaceExecutionSelectable({
                controlDeviceId: ctrlDevId,
                controlDeviceStatus: dev?.status,
                currentDevice,
                devices,
              })
              const deviceStatus = space.navigationKind === 'workspace'
                ? resolveSpaceExecutionDeviceStatus(
                  fullSp,
                  agent,
                  currentDevice,
                  devices,
                  tContext,
                )
                : null
              const rowTitle = deviceStatus
                ? `${space.name} · ${deviceStatus.title}`
                : space.name
              const isLocal = isCurrentDeviceControl(ctrlDevId, currentDevice, devices)
              const displayDevice = dev ?? (isLocal ? currentDevice : null)
              const deviceName = displayDevice?.name?.trim()
              const deviceState = isLocal
                ? t('sidebar.deviceLocal', { defaultValue: '本机' })
                : displayDevice?.status === 'online'
                  ? t('sidebar.deviceOnline', { defaultValue: '在线' })
                  : displayDevice?.status === 'busy'
                    ? t('sidebar.deviceBusy', { defaultValue: '忙碌' })
                    : displayDevice?.status === 'offline'
                      ? t('sidebar.deviceOffline', { defaultValue: '离线' })
                      : displayDevice?.status === 'draining'
                        ? t('sidebar.deviceDraining', { defaultValue: '暂停接单' })
                        : t('sidebar.deviceUnknown', { defaultValue: '状态未知' })
              const deviceSummary = ctrlDevId
                ? `${deviceName || t('sidebar.unknownDevice', { defaultValue: '未知设备' })} · ${deviceState}`
                : t('sidebar.unboundDevice', { defaultValue: '未绑定执行设备' })

              return (
                <SidebarMenuItem
                  key={space.id}
                  as="div"
                  contextActive={isActive}
                  contextActiveClassName="text-foreground"
                  className={cn('mx-1', isActive && 'cursor-default', !selectable && 'cursor-not-allowed opacity-50')}
                  onClick={isActive ? undefined : () => handleSelect(space, selectable)}
                  role={isActive ? undefined : 'button'}
                  tabIndex={!isActive && selectable ? 0 : -1}
                  aria-disabled={!isActive && !selectable ? true : undefined}
                  onKeyDown={isActive ? undefined : (e) => { if (e.key === 'Enter') handleSelect(space, selectable) }}
                  title={`${rowTitle} · ${deviceSummary}`}
                >
                  <span className="min-w-0 flex-1 py-0.5">
                    <span className="block truncate">{space.name}</span>
                    <span className={cn('block', SIDEBAR_META)}>{deviceSummary}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {deviceStatus ? (
                      <ExecutionDeviceStatusTag status={deviceStatus} />
                    ) : null}
                    {space.unread_count > 0 && !isActive && (
                      <span className="shrink-0 min-w-[16px] h-3.5 rounded-full bg-destructive text-white text-caption font-medium flex items-center justify-center px-0.5">
                        {space.unread_count > 99 ? '99+' : space.unread_count}
                      </span>
                    )}
                    {isActive && (
                      <>
                        <span className="sr-only">
                          {t('sidebar.currentWorkspace', { defaultValue: '当前工作空间' })}
                        </span>
                        <Check className={cn(SIDEBAR_ICON_SM, 'text-muted-foreground')} aria-hidden />
                      </>
                    )}
                    {!isActive && (
                      <button
                        type="button"
                        className={cn(
                          'shrink-0 h-5 w-5 flex items-center justify-center rounded-interactive text-muted-foreground/60 hover:bg-foreground/[0.03] hover:text-foreground transition-all',
                          isPinned ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        )}
                        onClick={(e) => { e.stopPropagation(); togglePinnedAgent(space.source_id) }}
                        title={isPinned ? t('sidebar.unpinAgent', { defaultValue: '取消固定' }) : t('sidebar.pinAgent', { defaultValue: '固定' })}
                      >
                        {isPinned ? <PinOff className={SIDEBAR_ICON_SM} /> : <Pin className={SIDEBAR_ICON_SM} />}
                      </button>
                    )}
                  </span>
                </SidebarMenuItem>
              )
            })}
            {filtered.length === 0 && (
              <div className={cn('px-3 py-4 text-center', SIDEBAR_META)}>
                {t('sidebar.noResults', { defaultValue: '无匹配' })}
              </div>
            )}
          </div>
        </ScrollArea>
        <div className={cn(SIDEBAR_DIVIDER, 'flex flex-col gap-0.5 p-1')}>
          {devicesWithoutWorkspace.map(device => (
            <div
              key={device.device_id}
              className="min-w-0 px-2 py-1 text-muted-foreground/60"
              role="note"
            >
              <span className={cn('block', SIDEBAR_META)}>
                {device.name.trim() || t('sidebar.unknownDevice', { defaultValue: '未知设备' })}
              </span>
              <span className="block text-caption">
                {t('sidebar.deviceNeedsWorkspace', { defaultValue: '需先在该设备创建 Workspace' })}
              </span>
            </div>
          ))}
          <React.Suspense fallback={null}>
            <LazyNewSpaceButton variant="full" className={cn('w-full h-7 flex items-center justify-center gap-1.5 rounded-interactive border-0 bg-transparent transition-colors', SIDEBAR_META, 'hover:text-foreground hover:bg-foreground/[0.03] dark:hover:bg-foreground/[0.05]')} />
          </React.Suspense>
        </div>
      </PopoverContent>
    </Popover>
  )
}

SpaceSwitcherPopover.displayName = 'SpaceSwitcherPopover'
