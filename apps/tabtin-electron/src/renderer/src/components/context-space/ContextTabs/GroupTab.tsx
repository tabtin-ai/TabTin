/**
 * GroupTab —— Canvas 分屏组的代表标签
 *
 * 与 NormalTab 的区别：
 *   - 内部包含多个 segment（每个对应一个 pane），用 grid 布局横向并排
 *   - 整组右上角有还原按钮（Minimize2 → 把分屏拆回独立标签）
 *   - 整组作为一个视觉槽位参与顶部标签排序
 *   - 整体右键菜单：关闭此分屏（递归关闭所有 pane） / 拆回独立标签
 *   - 中键关闭代表项 = 关闭当前 active pane 对应的 tab
 *
 * 不在本组件实现关闭动画 —— group 的关闭路径和普通 tab 不同（涉及 closePane / removeGroup），
 * 视觉上 group 整体消失更接近一次状态切换而非"X 按钮收起"，因此本轮先不加 group 关闭动画。
 *
 * Wave 1 T3 真实用户视角 Review 遗留项：group 右键菜单缺失。本次顺手补齐核心两项
 *   `tab.menu.closeGroup` + `tab.menu.splitGroup`，避免与 OS 默认菜单不一致。
 */
import { forwardRef } from 'react'
import { Columns2, Minimize2 } from 'lucide-react'
import { cn } from '@utils/cn'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import { flattenLayout } from '@hooks/useContextTabsLogic'
import { openNativeContextMenu, menuSeparator, type NativeMenuItem } from '@/utils/nativeMenu'
import { NORMAL_TAB_BASE_CLASS, CONTEXT_TAB_ACTIVE_CLASS, CONTEXT_TAB_INACTIVE_CLASS, type ContextTabsT } from './NormalTab'

const CLOSE_STAGGER_MS = 80
import { useTabDocDirtyIndicator } from './hooks/useTabDocDirtyIndicator'
import { DirtyIndicator } from './DirtyIndicator'
import type { TabDragProps } from '@hooks/useTabReorder'

interface GroupTabProps {
  group: CanvasLayoutGroup
  /** 是否处于 active（任一 pane tab 当前被选中） */
  isGroupActive: boolean
  /** 当前激活的 tabKey（用于判定 segment active） */
  activeTabKey: string | null
  registry: ContextRegistry
  /** 用于还原 group 时的 fallback 标签查询 */
  tabKeyToItem: Map<string, ContextItem>
  /** 给 active group 自动滚动到视图用 */
  innerRef?: React.Ref<HTMLDivElement>
  t: ContextTabsT
  /** 给 segment 切换 active pane 用 */
  onSetActivePane: (spaceId: string, groupId: string, paneId: string) => void
  /** 切换激活的 tabKey */
  onActivateTabKey: (tabKey: string | null) => void
  /** 单个 pane 还原为独立标签 */
  onRestoreGroup: (group: CanvasLayoutGroup) => void
  /** 关闭一个 ContextItem（中键 / 右键关闭此分屏 走此路径） */
  onCloseItem: (item: ContextItem) => void
  /** W5: 关闭其他所有 tabs（含其他 group 内） */
  onCloseOthersForGroup?: (group: CanvasLayoutGroup) => void
  /** W5: 关闭 slot 序列中本 group 左侧所有 tabs */
  onCloseLeftForGroup?: (group: CanvasLayoutGroup) => void
  /** W5: 关闭 slot 序列中本 group 右侧所有 tabs */
  onCloseRightForGroup?: (group: CanvasLayoutGroup) => void
  /** W5: 预计算的 slot 位置信息（由父组件从 renderSlots 派生，不含 phantom） */
  hasOtherSlots?: boolean
  hasLeftSlots?: boolean
  hasRightSlots?: boolean
  /** 标签 label / icon 解析 */
  getLabelForTabKey: (tabKey: string | null) => string
  getIconForTabKey: (tabKey: string | null) => React.ReactNode
  /** 顶部标签栏拖拽排序反馈；组标签只按整体槽位移动。 */
  reorderKey: string
  isDragging?: boolean
  reorderOffsetX?: number
  dragProps?: TabDragProps<HTMLDivElement>
}

/**
 * Inner segment component that calls useTabDocDirtyIndicator per-segment.
 * Extracted to satisfy React hook rules (hooks must be at component top level).
 */
const GroupTabSegment: React.FC<{
  segment: { key: string; label: string; tabKey: string | null; paneId: string }
  isSegmentActive: boolean
  group: CanvasLayoutGroup
  t: ContextTabsT
  tabKeyToItem: Map<string, ContextItem>
  getIconForTabKey: (tabKey: string | null) => React.ReactNode
  onSetActivePane: (spaceId: string, groupId: string, paneId: string) => void
  onActivateTabKey: (tabKey: string | null) => void
}> = ({
  segment,
  isSegmentActive,
  group,
  t,
  tabKeyToItem,
  getIconForTabKey,
  onSetActivePane,
  onActivateTabKey,
}) => {
  const item = segment.tabKey ? tabKeyToItem.get(segment.tabKey) : undefined
  const dirtyInfo = useTabDocDirtyIndicator(item ?? null)
  const showDirty = item && dirtyInfo

  return (
    <div
      role="tab"
      tabIndex={0}
      aria-selected={isSegmentActive}
      className={cn(
        'relative flex items-center px-2 min-w-0 transition-colors cursor-pointer rounded-interactive',
        isSegmentActive
          ? 'bg-muted/80 text-foreground font-medium'
          : 'text-muted-foreground/80 dark:text-muted-foreground hover:text-foreground hover:bg-muted/40 dark:hover:bg-muted/25',
      )}
      onClick={event => {
        event.stopPropagation()
        onSetActivePane(group.spaceId, group.id, segment.paneId)
        if (!segment.tabKey) return
        onActivateTabKey(segment.tabKey)
      }}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          onSetActivePane(group.spaceId, group.id, segment.paneId)
          if (segment.tabKey) onActivateTabKey(segment.tabKey)
        }
      }}
    >
      {segment.tabKey && (
        <span className="mr-1 flex shrink-0">{getIconForTabKey(segment.tabKey)}</span>
      )}
      <span className="min-w-0 truncate leading-5">{segment.label}</span>
      {showDirty && (
        <DirtyIndicator
          status={dirtyInfo.status}
          forceVisible={isSegmentActive || dirtyInfo.status === 'error'}
          t={t}
          dataAttributePrefix="segment"
        />
      )}
    </div>
  )
}

export const GroupTab = forwardRef<HTMLDivElement, GroupTabProps>(function GroupTab(
  {
    group,
    isGroupActive,
    activeTabKey,
    registry: _registry,
    tabKeyToItem,
    innerRef,
    t,
    onSetActivePane,
    onActivateTabKey,
    onRestoreGroup,
    onCloseItem,
    onCloseOthersForGroup,
    onCloseLeftForGroup,
    onCloseRightForGroup,
    hasOtherSlots = false,
    hasLeftSlots = false,
    hasRightSlots = false,
    getLabelForTabKey,
    getIconForTabKey,
    reorderKey,
    isDragging = false,
    reorderOffsetX = 0,
    dragProps,
  },
  forwardedRef,
) {
  const paneMap = new Map(group.panes.map(pane => [pane.id, pane]))
  const orderedPaneIds = group.layout
    ? flattenLayout(group.layout)
    : group.panes.map(pane => pane.id)
  const activePaneId = group.activePaneId || group.panes[0]?.id
  const segments = orderedPaneIds.map(paneId => {
    const pane = paneMap.get(paneId)
    if (!pane || !pane.content) {
      return {
        key: `empty-${paneId}`,
        label: t('tab.group'),
        tabKey: null as string | null,
        paneId,
      }
    }
    const tabKey = pane.content.tabKey
    return {
      key: tabKey,
      label: getLabelForTabKey(tabKey),
      tabKey,
      paneId: pane.id,
    }
  })

  const preferredTabKey =
    group.panes.find(pane => pane.id === activePaneId)?.content?.tabKey ||
    group.anchorTabKey ||
    null

  const setRef = (node: HTMLDivElement | null) => {
    if (typeof innerRef === 'function') innerRef(node)
    else if (innerRef && 'current' in innerRef) {
      ;(innerRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    }
    if (typeof forwardedRef === 'function') forwardedRef(node)
    else if (forwardedRef && 'current' in forwardedRef) {
      ;(forwardedRef as React.MutableRefObject<HTMLDivElement | null>).current = node
    }
  }

  const handleGroupAuxClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return
    e.preventDefault()
    e.stopPropagation()
    // 中键关 group 代表项：关掉当前 activePane 对应的 tab
    const target = preferredTabKey ? tabKeyToItem.get(preferredTabKey) : null
    if (target) onCloseItem(target)
  }

  const collectClosableItems = (): ContextItem[] =>
    segments
      .map(seg => (seg.tabKey ? tabKeyToItem.get(seg.tabKey) : null))
      .filter((item): item is ContextItem => Boolean(item))

  const closeGroupStaggered = (closableItems: ContextItem[]) => {
    if (closableItems.length === 0) return
    closableItems.forEach((item, idx) => {
      if (idx === 0) {
        onCloseItem(item)
      } else {
        setTimeout(() => onCloseItem(item), idx * CLOSE_STAGGER_MS)
      }
    })
  }

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const closableItems = collectClosableItems()

    const menuItems: NativeMenuItem[] = [
      {
        id: 'split-group',
        label: t('tab.menu.splitGroup'),
        onClick: () => onRestoreGroup(group),
      },
      menuSeparator(),
      {
        id: 'close-group',
        label: t('tab.menu.closeGroup'),
        enabled: closableItems.length > 0,
        onClick: () => closeGroupStaggered(closableItems),
      },
      menuSeparator(),
      {
        id: 'close-others',
        label: t('tab.menu.closeOthers'),
        enabled: hasOtherSlots && Boolean(onCloseOthersForGroup),
        onClick: () => onCloseOthersForGroup?.(group),
      },
      {
        id: 'close-left',
        label: t('tab.menu.closeLeft'),
        enabled: hasLeftSlots && Boolean(onCloseLeftForGroup),
        onClick: () => onCloseLeftForGroup?.(group),
      },
      {
        id: 'close-right',
        label: t('tab.menu.closeRight'),
        enabled: hasRightSlots && Boolean(onCloseRightForGroup),
        onClick: () => onCloseRightForGroup?.(group),
      },
    ]
    openNativeContextMenu(menuItems, e.clientX, e.clientY)
  }

  const columnsClass =
    segments.length >= 3 ? 'grid-cols-3' : segments.length === 2 ? 'grid-cols-2' : ''
  const isSingleSegment = segments.length <= 1
  // GroupTab 复用 NORMAL_TAB_BASE_CLASS 的 max-w-[220px] 对单 segment 合适，
  // 但多 segment 时每段被 grid 平分会过窄，按 segment 数量阶梯放大上限。
  // 目标：每个 segment 的文字区 ≈ NormalTab 的 60% 以上。
  const groupMaxWidthClass =
    segments.length >= 3 ? '!max-w-[440px]' : segments.length === 2 ? '!max-w-[320px]' : ''
  const restoreButtonOpacityClass = isDragging
    ? 'opacity-0'
    : isGroupActive
      ? 'opacity-70 hover:opacity-100'
      : 'opacity-0 group-hover:opacity-100'

  return (
    <div
      key={group.id}
      ref={setRef}
      data-tab-item
      data-tab-key={preferredTabKey ?? `group:${group.id}`}
      data-tab-reorder-key={reorderKey}
      data-group-tab
      data-tab-dragging={isDragging ? 'true' : undefined}
      data-tab-placeholder={isDragging ? 'true' : undefined}
      className={cn(
        NORMAL_TAB_BASE_CLASS,
        'transition-[transform,opacity,background-color,box-shadow] duration-150 ease-out',
        // 右上角还原按钮为 absolute，内容必须永久预留按钮宽度，不能依赖 truncate 遮挡。
        'pl-2 pr-7',
        groupMaxWidthClass,
        isGroupActive
          ? CONTEXT_TAB_ACTIVE_CLASS
          : CONTEXT_TAB_INACTIVE_CLASS,
        isDragging && 'cursor-grabbing border-dashed border-border/60 bg-muted/25 text-transparent hover:bg-muted/25',
      )}
      style={reorderOffsetX ? { transform: `translateX(${reorderOffsetX}px)` } : undefined}
      onClick={() => {
        onActivateTabKey(preferredTabKey ?? null)
      }}
      onAuxClick={handleGroupAuxClick}
      onMouseDown={e => {
        if (e.button === 1) e.preventDefault()
      }}
      onContextMenu={handleContextMenu}
      {...dragProps}
    >
      <div
        data-tab-drag-content
        className={cn('contents', isDragging && 'invisible')}
        inert={isDragging ? true : undefined}
      >
        <span
          className="mr-1 flex shrink-0 text-muted-foreground/60"
          title={t('tab.splitIndicator', { defaultValue: '分屏' })}
          aria-label={t('tab.splitIndicator', { defaultValue: '分屏' })}
          data-split-indicator
        >
          <Columns2 className="h-3 w-3" />
        </span>
        <div
          className={cn(
            'grid min-w-0 flex-1',
            !isSingleSegment && 'divide-x divide-border/30 dark:divide-border/50',
            columnsClass,
          )}
        >
          {segments.map(segment => {
            const isSegmentActive = activeTabKey === segment.tabKey
            return (
              <GroupTabSegment
                key={segment.key}
                segment={segment}
                isSegmentActive={isSegmentActive}
                group={group}
                t={t}
                tabKeyToItem={tabKeyToItem}
                getIconForTabKey={getIconForTabKey}
                onSetActivePane={onSetActivePane}
                onActivateTabKey={onActivateTabKey}
              />
            )
          })}
        </div>
        {/*
          分组态下右上角按钮 = 还原（不是关闭）：把 group 拆回独立标签后，用户再决定关哪个。
          这样避免与 segment 内的还原按钮重叠，也对应"分组先还原再关闭"的语义。
          如需直接关整组，可走右键菜单的"关闭分组"。
        */}
        <button
          aria-label={t('tab.restoreGroup')}
          title={t('tab.restoreGroup')}
          tabIndex={-1}
          className={cn(
            'absolute right-1 top-1/2 -translate-y-1/2 transition-opacity p-0.5 rounded-sm z-floating',
            restoreButtonOpacityClass,
            'bg-foreground/[0.04] dark:bg-foreground/[0.06] text-muted-foreground hover:text-foreground hover:bg-foreground/[0.08] dark:hover:bg-foreground/[0.10]',
          )}
          onClick={event => {
            event.stopPropagation()
            onRestoreGroup(group)
          }}
          data-restore-group-btn
        >
          <Minimize2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
})
GroupTab.displayName = 'GroupTab'
