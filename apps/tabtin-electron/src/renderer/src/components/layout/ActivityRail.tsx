/**
 * ActivityRail —— 常驻窄栏（56px，与宽侧栏共享实色底）。
 *
 * 自上而下：组织头像 → 五大域（任务 / 消息 / AI分身 / 云文档 / 项目）→
 * 底部客服 + 通知 + 个人头像。侧栏展开/折叠在 ShellTopBar 组织名旁。
 *
 * 组织 / 个人头像点击固定落到组织资料 / 个人资料，不经齿轮中转、不复用上次 section。
 * 域切换派发与未读徽标和第二列内容面板同源（usePrimaryNavigation）；
 * 「新任务」是动作不是页面，收口在第二列任务域顶部主按钮，不占窄栏。
 * 窄栏常驻不可折叠；折叠语义只作用于第二列（useUIStore.sidebarCollapsed）。
 *
 * 五大域按钮支持拖拽换序（dnd-kit，8px 触发阈值保住点击语义），顺序持久化在
 * useSpaceViewPrefsStore.activityRailDomainOrder；顶部组织头像与底部客服/通知/
 * 个人头像是固定锚点，不参与排序。
 */

import React, { useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { arrayMove } from '@dnd-kit/sortable'
import type { Active } from '@dnd-kit/core'
import { cn } from '@utils/cn'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import type { MainNavTab } from '@stores/useMainNavStore'
import type { AppPageId } from '@stores/useAppPageStore'
import type { SettingsCategory } from '@/settings/settingsRoutes'
import { NotificationBell } from '@components/notification/NotificationBell'
import {
  DndKitContext,
  Draggable,
  Droppable,
  verticalListSortingStrategy,
  type DragEndEvent,
} from '@/components/common/dnd-kit'
import { CustomerSupportRailButton } from './CustomerSupportRailButton'
import {
  OrganizationAvatarRailButton,
  UserAvatarRailButton,
} from './OrganizationProfileButton'
import { usePrimaryNavigation } from './primaryNavigation'
import { PROJECTS_UI_ENABLED } from '@/utils/featureFlags'
import {
  DEFAULT_ACTIVITY_RAIL_DOMAIN_ORDER,
  isActivityRailDomainId,
  mergeRailDomainOrder,
  resolveRailDomainOrder,
  type ActivityRailDomainId,
} from './activityRailOrder'
import {
  RailAgentIcon,
  RailChatIcon,
  RailCloudDocsIcon,
  RailFolderIcon,
  RailHomeIcon,
  type ActivityRailIconProps,
} from './activityRailIcons'
import { RailIconTooltip } from './activityRailTooltip'
import { ACTIVITY_RAIL_TOP_CLASS } from './shellUi'
import {
  ACTIVITY_RAIL_ICON_SIZE,
  ACTIVITY_RAIL_ITEM,
  ACTIVITY_RAIL_ITEM_ACTIVE,
  ACTIVITY_RAIL_ITEM_INACTIVE,
} from './sidebarUi'

export type ActivityRailItemId =
  | 'tasks'
  | 'messages'
  | 'agents'
  | 'cloud-docs'
  | 'projects'
  | 'organization'
  | 'profile'

type DomainRailItemId = ActivityRailDomainId

/**
 * 窄栏激活判定：把 PrimaryNav 级状态归并到域粒度。
 * - 设置态最优先：openSettings 不清 activeAppPage，主画布以 me 优先
 *   （useShellLayoutState 同序），rail 若先判 app page 高亮会停在旧页。
 * - 设置内按 category 高亮组织 / 个人头像；设备段不高亮二者。
 * - 任务域覆盖「新任务欢迎页 + 会话中 + 工作台」全部子态——工作台（desktop）
 *   是任务域的一个工作面；AI 分身独立域，列表在侧栏、详情在主画布。
 */
export function resolveActivityRailActive(input: {
  effectiveMainNavTab: MainNavTab
  activeAppPage: AppPageId | null
  settingsCategory?: SettingsCategory | null
}): ActivityRailItemId | null {
  const { effectiveMainNavTab, activeAppPage, settingsCategory } = input
  if (effectiveMainNavTab === 'me') {
    if (settingsCategory === 'organization') return 'organization'
    if (settingsCategory === 'profile') return 'profile'
    return null
  }
  if (activeAppPage === 'collaboration' || activeAppPage === 'project') return 'projects'
  // 自动化 / 技能库是任务域次级入口，窄栏仍归任务域高亮。
  if (activeAppPage === 'skill' || activeAppPage === 'automation') return 'tasks'
  if (effectiveMainNavTab === 'agents') return 'agents'
  if (effectiveMainNavTab === 'im') return 'messages'
  if (effectiveMainNavTab === 'cloud-docs') return 'cloud-docs'
  if (effectiveMainNavTab === 'agent') return 'tasks'
  return null
}

const DOMAIN_NAV_ITEMS: Array<{
  id: DomainRailItemId
  labelKey: string
  defaultLabel: string
  Icon: React.FC<ActivityRailIconProps>
}> = [
  { id: 'tasks', labelKey: 'sidebar:rail.tasks', defaultLabel: '任务', Icon: RailHomeIcon },
  { id: 'messages', labelKey: 'sidebar:rail.messages', defaultLabel: '消息', Icon: RailChatIcon },
  { id: 'agents', labelKey: 'sidebar:primaryNav.agents', defaultLabel: 'AI 分身', Icon: RailAgentIcon },
  { id: 'cloud-docs', labelKey: 'sidebar:rail.cloudDocs', defaultLabel: '云文档', Icon: RailCloudDocsIcon },
  { id: 'projects', labelKey: 'sidebar:rail.projects', defaultLabel: '项目', Icon: RailFolderIcon },
]

/** Projects 开关关闭时隐藏「项目」域；消息 / 任务 / AI分身不受开关控制。 */
export function resolveVisibleRailDomainIds(input: {
  projectsEnabled: boolean
}): DomainRailItemId[] {
  return DOMAIN_NAV_ITEMS
    .filter(item => item.id !== 'projects' || input.projectsEnabled)
    .map(item => item.id)
}

const RailBadge: React.FC<{ label: string }> = ({ label }) => (
  <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-3.5 flex items-center justify-center rounded-full bg-destructive text-caption font-medium leading-none text-white px-0.5 tabular-nums">
    {label}
  </span>
)

interface ActivityRailProps {
  executionSpaceId: string | null
}

export const ActivityRail: React.FC<ActivityRailProps> = ({
  executionSpaceId,
}) => {
  const { t } = useTranslation(['sidebar', 'settings'])
  const settingsCategory = useSettingsSpaceStore((s) => s.activeRoute?.category ?? null)
  const {
    effectiveMainNavTab,
    activeAppPage,
    messagesUnread,
    messagesUnreadLabel,
    collaborationPendingCount,
    collaborationPendingLabel,
    handlePrimaryNavigation,
  } = usePrimaryNavigation({ executionSpaceId })

  const activeRailItem = resolveActivityRailActive({
    effectiveMainNavTab,
    activeAppPage,
    settingsCategory,
  })

  const handleDomainClick = useCallback((id: DomainRailItemId) => {
    if (id === 'tasks') {
      handlePrimaryNavigation('tasks')
      return
    }
    if (id === 'messages') {
      handlePrimaryNavigation('messages')
      return
    }
    if (id === 'agents') {
      handlePrimaryNavigation('agents')
      return
    }
    if (id === 'cloud-docs') {
      handlePrimaryNavigation('cloud-docs')
      return
    }
    if (id === 'projects') {
      handlePrimaryNavigation('collaboration')
    }
  }, [handlePrimaryNavigation])

  const railDomainOrder = useSpaceViewPrefsStore(s => s.activityRailDomainOrder)
  const setRailDomainOrder = useSpaceViewPrefsStore(s => s.setActivityRailDomainOrder)

  const visibleDomainIds = useMemo(
    () => resolveVisibleRailDomainIds({ projectsEnabled: PROJECTS_UI_ENABLED }),
    [],
  )
  const orderedDomainIds = useMemo(
    () => resolveRailDomainOrder({ visibleIds: visibleDomainIds, storedOrder: railDomainOrder }),
    [visibleDomainIds, railDomainOrder],
  )
  // 全量顺序（含不可见域）：拖拽落笔时把可见子集的重排归并回去，保留隐藏域槽位。
  const fullDomainOrder = useMemo(
    () => resolveRailDomainOrder({ visibleIds: DEFAULT_ACTIVITY_RAIL_DOMAIN_ORDER, storedOrder: railDomainOrder }),
    [railDomainOrder],
  )
  const orderedDomainItems = useMemo(
    () => orderedDomainIds.flatMap(id => {
      const item = DOMAIN_NAV_ITEMS.find(navItem => navItem.id === id)
      return item ? [item] : []
    }),
    [orderedDomainIds],
  )

  const handleRailDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    if (!isActivityRailDomainId(active.id) || !isActivityRailDomainId(over.id)) return
    const fromIndex = orderedDomainIds.indexOf(active.id)
    const toIndex = orderedDomainIds.indexOf(over.id)
    if (fromIndex < 0 || toIndex < 0) return
    const nextVisibleOrder = arrayMove(orderedDomainIds, fromIndex, toIndex)
    setRailDomainOrder(mergeRailDomainOrder({
      fullOrder: fullDomainOrder,
      reorderedVisibleIds: nextVisibleOrder,
    }))
  }, [orderedDomainIds, fullDomainOrder, setRailDomainOrder])

  /**
   * 域按钮视觉（图标 + 未读/待加入角标），列表按钮与拖拽浮层共用，
   * 保证浮层与原按钮视觉一致（列表渲染挂交互，浮层只做纯展示）。
   */
  const renderRailButtonVisual = useCallback(({
    id,
    badgeLabel,
  }: {
    id: ActivityRailDomainId
    badgeLabel: string
  }) => {
    const item = DOMAIN_NAV_ITEMS.find(navItem => navItem.id === id)
    if (!item) return null
    const { Icon } = item
    return (
      <>
        <Icon size={ACTIVITY_RAIL_ICON_SIZE} />
        {badgeLabel ? <RailBadge label={badgeLabel} /> : null}
      </>
    )
  }, [])

  /** 拖拽浮层：纯展示按钮，不克隆 Draggable（避免 overlay 内重复 useSortable）。 */
  const renderRailOverlay = useCallback((active: Active | null): React.ReactElement => {
    if (!active || !isActivityRailDomainId(active.id)) return <></>
    const id = active.id
    const item = DOMAIN_NAV_ITEMS.find(navItem => navItem.id === id)
    if (!item) return <></>
    const activeState = activeRailItem === id
    return (
      <div className="flex flex-col items-center">
        <span
          className={cn(
            ACTIVITY_RAIL_ITEM,
            activeState ? ACTIVITY_RAIL_ITEM_ACTIVE : ACTIVITY_RAIL_ITEM_INACTIVE,
            'bg-background shadow-lg ring-1 ring-foreground/10',
          )}
        >
          {renderRailButtonVisual({ id, badgeLabel: '' })}
        </span>
      </div>
    )
  }, [activeRailItem, renderRailButtonVisual])

  return (
    <div
      className={cn('relative flex h-full shrink-0 flex-col items-center overflow-visible pb-2', ACTIVITY_RAIL_TOP_CLASS)}
      data-testid="activity-rail"
    >
      <OrganizationAvatarRailButton active={activeRailItem === 'organization'} />

      <nav className="flex flex-col items-center gap-2" aria-label="主导航">
        <DndKitContext onDragEnd={handleRailDragEnd}>
          <Droppable items={orderedDomainIds} strategy={verticalListSortingStrategy} overlayRender={renderRailOverlay}>
            {orderedDomainItems.map(({ id, labelKey, defaultLabel }) => {
              const active = activeRailItem === id
              const label = t(labelKey, { defaultValue: defaultLabel })
              const badgeLabel = id === 'messages'
                ? messagesUnreadLabel
                : id === 'projects'
                  ? collaborationPendingLabel
                  : ''
              const ariaLabel = id === 'messages' && badgeLabel
                ? t('sidebar:mainNav.unreadLabel', { label, count: messagesUnread, defaultValue: '{{label}}（{{count}} 条未读）' })
                : id === 'projects' && badgeLabel
                  ? t('sidebar:mainNav.pendingInviteLabel', {
                    label,
                    count: collaborationPendingCount,
                    defaultValue: '{{label}}（{{count}} 条待加入）',
                  })
                  : label
              return (
                <Draggable key={id} id={id}>
                  {({ setNodeRef, attributes, listeners, style, isDragging }) => (
                    <div
                      ref={setNodeRef}
                      style={style}
                      className={cn('flex flex-col items-center', isDragging && 'opacity-40')}
                    >
                      <RailIconTooltip label={label} disabled={isDragging}>
                        <button
                          type="button"
                          aria-label={ariaLabel}
                          aria-current={active ? 'page' : undefined}
                          onClick={() => handleDomainClick(id)}
                          {...attributes}
                          {...listeners}
                          className={cn(
                            ACTIVITY_RAIL_ITEM,
                            active ? ACTIVITY_RAIL_ITEM_ACTIVE : ACTIVITY_RAIL_ITEM_INACTIVE,
                          )}
                        >
                          {renderRailButtonVisual({
                            id,
                            badgeLabel,
                          })}
                        </button>
                      </RailIconTooltip>
                    </div>
                  )}
                </Draggable>
              )
            })}
          </Droppable>
        </DndKitContext>
      </nav>

      <div className="flex-1" />

      <div className="flex flex-col items-center gap-2">
        <CustomerSupportRailButton />
        <NotificationBell size="rail" />
        <UserAvatarRailButton active={activeRailItem === 'profile'} />
      </div>
    </div>
  )
}

ActivityRail.displayName = 'ActivityRail'
