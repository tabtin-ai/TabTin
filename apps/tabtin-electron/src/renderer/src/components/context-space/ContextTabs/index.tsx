/**
 * ContextTabs —— Space 顶部标签条 orchestrator
 *
 * 本文件只负责"组装"，不写具体 tab 渲染逻辑：
 *   - 引入 NormalTab / GroupTab / OverflowPopover 三个子组件
 *   - 调用 useContextTabsLogic（菜单 + 数据派生）/ usePaneDragDrop / useTabReorder
 *   - 调用 useOverflowDetection（横向滚动 + 隐藏 tab 检测）
 *   - 调用 useCloseAnimation（关闭动画状态机）
 *   - 维护 ScrollArea 的容器、leadingSlot / trailingSlot 等结构性元素
 *
 * 渲染顺序契约（与拆分前一致）：
 *   leadingSlot → home → 按 items 顺序的 tab/group 混合 → 仅 canvas-only group → trailingSlot
 *   + 父级容器右侧 OverflowPopover
 *
 * Wave 3 T6 关闭动画：
 *   每个 NormalTab 接收 isClosing prop（来自 useCloseAnimation）。
 *   - 用户点 X：requestClose 立即标 closing + 触发 onCloseItem（业务流程异步走）
 *   - items 自然减少：phantom 接管渲染并播 leave 动画
 *   - beforeClose 阻止：cancelTimeoutMs 后从 closing 集合移除 → 反向回弹
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { X } from 'lucide-react'
import { cn } from '@utils/cn'
import { TabTypeEmoji } from '@components/layout/sidebarTypeEmoji'
import { useContextTabsLogic, type BaseContextTabsProps } from '@hooks/useContextTabsLogic'
import { usePaneDragDrop } from '@hooks/usePaneDragDrop'
import { useTabReorder } from '@hooks/useTabReorder'
import { ScrollArea } from '@tabtin/smartsheet-ui'
import type { ContextItem } from '@components/context-space/registry'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { scrollHorizontallyWithVerticalWheel } from '@utils/horizontalWheelScroll'
import {
  NormalTab,
  CLOSE_BTN_CLASS,
  CONTEXT_TAB_ACTIVE_CLASS,
  CONTEXT_TAB_INACTIVE_CLASS,
  NORMAL_TAB_BASE_CLASS,
} from './NormalTab'
import { GroupTab } from './GroupTab'
import { OverflowPopover } from './OverflowPopover'
import { useOverflowDetection } from './hooks/useOverflowDetection'
import { useCloseAnimation } from './hooks/useCloseAnimation'

const SCROLL_CONTENT_SELECTOR = '[data-context-tabs-scroll-content]'

interface ContextTabsProps extends BaseContextTabsProps {
  homeLabel?: string
  leadingSlot?: React.ReactNode
  leadingSlotClassName?: string
  trailingSlot?: React.ReactNode
  trailingSlotClassName?: string
  containerClassName?: string
}

/**
 * 渲染 slot —— 用一种 union 类型把 normal item / group 平铺到一个数组里，
 * 便于按"原本的位置 + phantom 插回"统一排序。
 */
type RenderSlot =
  | { kind: 'item'; item: ContextItem; isClosing: boolean; isPhantom: boolean }
  | { kind: 'group'; group: CanvasLayoutGroup }

function slotReactKey(slot: RenderSlot): string {
  if (slot.kind === 'group') return `group:${slot.group.id}`
  return slot.isPhantom ? `phantom:${slot.item.tabKey}` : `item:${slot.item.tabKey}`
}

function resolveGroupReorderItem(
  group: CanvasLayoutGroup,
  tabKeyToItem: Map<string, ContextItem>,
  activeTabKey: string | null,
): ContextItem | null {
  const activePaneTabKey = group.panes.find(pane => pane.id === group.activePaneId)?.content?.tabKey
  const candidates = [
    activeTabKey && group.panes.some(pane => pane.content?.tabKey === activeTabKey)
      ? activeTabKey
      : null,
    activePaneTabKey,
    group.anchorTabKey,
    ...group.panes.map(pane => pane.content?.tabKey ?? null),
  ]
  for (const tabKey of candidates) {
    if (!tabKey) continue
    const item = tabKeyToItem.get(tabKey)
    if (item) return item
  }
  return null
}

/**
 * 从 renderSlots 中为指定 group 预计算 enabled 状态 boolean。
 * 过滤 phantom items，确保 enabled 与实际 close handler 行为一致。
 */
function computeGroupSlotPosition(
  slots: readonly RenderSlot[],
  groupId: string,
): { hasOtherSlots: boolean; hasLeftSlots: boolean; hasRightSlots: boolean } {
  const nonPhantomSlots = slots.filter(
    s => s.kind === 'group' || !s.isPhantom,
  )
  const idx = nonPhantomSlots.findIndex(
    s => s.kind === 'group' && s.group.id === groupId,
  )
  if (idx === -1) return { hasOtherSlots: false, hasLeftSlots: false, hasRightSlots: false }
  return {
    hasOtherSlots: nonPhantomSlots.length > 1,
    hasLeftSlots: idx > 0,
    hasRightSlots: idx < nonPhantomSlots.length - 1,
  }
}

export const ContextTabs: React.FC<ContextTabsProps> = ({
  activeTabKey,
  isHomeActive,
  showHome = true,
  homeClosable = false,
  homeLabel,
  allItems,
  items,
  registry,
  leadingSlot,
  leadingSlotClassName,
  trailingSlot,
  trailingSlotClassName,
  containerClassName,
  onSelectHome,
  onCloseHome,
  onSelectItem,
  onCloseItem,
  onRefreshItem,
  onCloseOtherItems,
  onCloseLeftItems,
  onCloseRightItems,
  onCreateWebTab,
  onReopenClosedTab,
  onReorderItem,
  onRestoreGroup,
  onCloseOthersForGroup,
  onCloseLeftForGroup,
  onCloseRightForGroup,
  groupedTabKeys,
  canvasGroups,
}) => {
  const {
    t,
    tabKeyToItem,
    getLabelForTabKey,
    getIconForTabKey,
    handleTabContextMenu,
    activateTabKey,
    handleRestoreGroup,
    groupLookup,
    tabKeyToGroup,
    setActivePane,
  } = useContextTabsLogic({
    allItems,
    items,
    registry,
    groupedTabKeys,
    canvasGroups,
    onSelectHome,
    onSelectItem,
    onCloseItem,
    onRefreshItem,
    onCloseOtherItems,
    onCloseLeftItems,
    onCloseRightItems,
    onCreateWebTab,
    onReopenClosedTab,
    onRestoreGroup,
  })

  const { paneDragHandlers } = usePaneDragDrop({
    groupLookup,
    handleRestoreGroup,
    activateTabKey,
  })

  const { reorderPreview, makeTabDragProps, containerDragHandlers } = useTabReorder({
    tabKeyToItem,
    registry,
    onReorderItem,
  })
  const draggedTabKey = reorderPreview?.draggedTabKey ?? null

  const activeTabRef = useRef<HTMLDivElement>(null)
  const scrollViewportRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'nearest',
        inline: 'nearest',
      })
    }
  }, [activeTabKey])

  const { canScrollLeft, canScrollRight, overflowTabKeys } = useOverflowDetection({
    viewportRef: scrollViewportRef,
    contentSelector: SCROLL_CONTENT_SELECTOR,
    deps: [items.length, canvasGroups?.length, activeTabKey],
  })

  const { isClosing, phantomItems, requestClose } = useCloseAnimation(items)

  // 用户点 X / 中键 / 右键关闭 / 溢出 popover 关闭等所有"主动关闭"路径，
  // 都走 requestClose → 立即视觉收起 + 异步业务流程
  const handleRequestClose = useCallback(
    (item: ContextItem) => {
      requestClose(item, () => onCloseItem(item))
    },
    [requestClose, onCloseItem],
  )

  // 把 items + canvasGroups + phantomItems 合成最终渲染 slot 列表
  const renderSlots = useMemo<RenderSlot[]>(() => {
    const slots: RenderSlot[] = []
    const renderedGroups = new Set<string>()
    const renderedItems = new Set<string>()
    const renderableItemByKey = new Map(items.map(item => [item.tabKey, item]))

    // group 有效 pane 数（pane.content 当前上下文可见）≤ 1 时不再视为分屏组：
    // 防止用户解组 / 关闭多余 pane 后留下"只有 Columns2 但无 segment"的孤儿 GroupTab。
    const isEffectiveGroup = (group: CanvasLayoutGroup): boolean =>
      group.panes.filter(p => p.content && tabKeyToItem.has(p.content.tabKey)).length > 1

    const appendOrderedSlot = (item: ContextItem) => {
      const tabKey = item.tabKey
      const group = tabKeyToGroup.get(tabKey)
      if (group && isEffectiveGroup(group)) {
        if (!renderedGroups.has(group.id)) {
          renderedGroups.add(group.id)
          slots.push({ kind: 'group', group })
        }
        return
      }

      // allItems 是完整顺序锚点，但普通标签仍只能从 items 白名单渲染；
      // 避免把跨 session 隐藏的标签或固定桌面标签重新暴露到标签栏。
      const renderableItem = renderableItemByKey.get(tabKey)
      if (!renderableItem || renderedItems.has(tabKey)) return
      renderedItems.add(tabKey)
      slots.push({
        kind: 'item',
        item: renderableItem,
        isClosing: isClosing(tabKey),
        isPhantom: false,
      })
    }

    // 1. 生产态的 items 已过滤掉 grouped tabKey，不能再用它判断组的位置。
    //    allItems 保留完整 tabOrder，因此组以第一个可见成员作为视觉槽位锚点。
    const orderedSlotItems = allItems ?? items
    orderedSlotItems.forEach(appendOrderedSlot)

    // allItems 是可选的兼容接口；补入其中缺失、但 items 明确要求渲染的普通标签。
    items.forEach(appendOrderedSlot)

    // 2. phantom items 按"前邻居 tabKey"锚点插入（避免 leave 动画时位置突变）。
    //    canvas group 折叠后 slot 索引 ≠ items 索引，因此不能用数字索引；
    //    改成查"前邻居 tabKey 在 slots 里的位置 + 1"。前邻居本身是 group 时，
    //    通过 tabKeyToGroup 找到 group slot 的位置；前邻居本身也是 phantom 时，
    //    退化为 lastIndex 排序兜底。
    if (phantomItems.length > 0) {
      const sortedPhantoms = [...phantomItems].sort((a, b) => a.lastIndex - b.lastIndex)
      const findSlotIndexForTabKey = (key: string): number => {
        for (let i = 0; i < slots.length; i++) {
          const slot = slots[i]
          if (slot.kind === 'item' && slot.item.tabKey === key) return i
          if (slot.kind === 'group') {
            // group slot 已经折叠了一组 panes，任一 pane 的 tabKey 命中也算
            const hit = slot.group.panes.some(pane => pane.content?.tabKey === key)
            if (hit) return i
          }
        }
        return -1
      }
      sortedPhantoms.forEach(phantom => {
        let insertAt: number
        if (phantom.predecessorTabKey) {
          const predIndex = findSlotIndexForTabKey(phantom.predecessorTabKey)
          insertAt = predIndex >= 0 ? predIndex + 1 : Math.min(phantom.lastIndex, slots.length)
        } else {
          // predecessor=null → 它本来是 items 中的第 0 项，仍插在最前面
          insertAt = 0
        }
        slots.splice(insertAt, 0, {
          kind: 'item',
          item: phantom.item,
          isClosing: true,
          isPhantom: true,
        })
      })
    }

    // 3. canvas-only groups（不在 items 里但仍要渲染的 group）—— 同样要求 panes 有效数 > 1
    canvasGroups?.forEach(group => {
      if (!isEffectiveGroup(group)) return
      if (!renderedGroups.has(group.id)) {
        renderedGroups.add(group.id)
        slots.push({ kind: 'group', group })
      }
    })

    return slots
  }, [allItems, items, tabKeyToGroup, tabKeyToItem, canvasGroups, isClosing, phantomItems])

  // Codex 风格排序预览：源 DOM 作为空占位移动；跨过的 slot 只做单向让位。
  // 全部位移来自 dragstart 时冻结的宽度和 gap，dragover 不再读取 transform 后的 DOM。
  const reorderOffsetsByTabKey = useMemo(() => {
    const offsets = new Map<string, number>()
    if (!reorderPreview) return offsets

    const { slots, sourceIndex, placeholderIndex, gap } = reorderPreview
    const source = slots[sourceIndex]
    if (!source || placeholderIndex === sourceIndex) return offsets

    const peerShift = source.width + gap
    let sourceOffset = 0
    if (placeholderIndex > sourceIndex) {
      for (let index = sourceIndex + 1; index <= placeholderIndex; index += 1) {
        const slot = slots[index]
        if (!slot) continue
        offsets.set(slot.tabKey, -peerShift)
        sourceOffset += slot.width + gap
      }
    } else {
      for (let index = placeholderIndex; index < sourceIndex; index += 1) {
        const slot = slots[index]
        if (!slot) continue
        offsets.set(slot.tabKey, peerShift)
        sourceOffset -= slot.width + gap
      }
    }
    offsets.set(source.tabKey, sourceOffset)
    return offsets
  }, [reorderPreview])

  return (
    <div
      className={cn(
        'relative z-banner flex min-h-12 w-full items-stretch no-drag',
        containerClassName,
      )}
    >
      <div
        role="tablist"
        data-tab-reorder-zone="true"
        aria-orientation="horizontal"
        className="relative flex min-w-0 flex-1 items-center gap-1 pl-2 no-drag"
        {...paneDragHandlers}
      >
        {leadingSlot && (
          <div className={cn('flex-shrink-0', leadingSlotClassName)}>{leadingSlot}</div>
        )}
        {showHome && (
          <div
            role="tab"
            tabIndex={0}
            aria-selected={isHomeActive}
            className={cn(
              NORMAL_TAB_BASE_CLASS,
              'transition-colors',
              homeClosable ? 'pl-2 pr-6' : 'px-2',
              isHomeActive ? CONTEXT_TAB_ACTIVE_CLASS : CONTEXT_TAB_INACTIVE_CLASS,
            )}
            onClick={onSelectHome}
            onAuxClick={homeClosable && onCloseHome
              ? (event) => {
                  if (event.button !== 1) return
                  event.preventDefault()
                  event.stopPropagation()
                  onCloseHome()
                }
              : undefined}
            onMouseDown={e => {
              if (homeClosable && e.button === 1) e.preventDefault()
            }}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelectHome()
              }
            }}
          >
            <span
              className={cn(
                'shrink-0 grayscale',
                isHomeActive ? 'grayscale-0 opacity-100' : 'opacity-60',
              )}
            >
              <TabTypeEmoji appIdOrType="desktop_home" />
            </span>
            <span className="min-w-0 truncate">{homeLabel ?? t('tab.home')}</span>
            {homeClosable && onCloseHome && (
              <button
                type="button"
                aria-label={t('tab.menu.close')}
                tabIndex={-1}
                className={cn(
                  'absolute right-0.5 top-1/2 -translate-y-1/2 transition-opacity p-0.5 rounded-sm z-floating',
                  'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
                  CLOSE_BTN_CLASS,
                )}
                onClick={event => {
                  event.stopPropagation()
                  onCloseHome()
                }}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
        <div
          className="relative h-12 min-w-0 flex-1"
          onWheel={event => {
            scrollHorizontallyWithVerticalWheel(event, scrollViewportRef.current)
          }}
        >
          {canScrollLeft && (
            <div className="pointer-events-none absolute left-0 top-0 bottom-0 w-6 bg-gradient-to-r from-[hsl(var(--surface-canvas-card))] to-transparent z-sticky" />
          )}
          {canScrollRight && (
            <div className="pointer-events-none absolute right-0 top-0 bottom-0 w-6 bg-gradient-to-l from-[hsl(var(--surface-canvas-card))] to-transparent z-sticky" />
          )}
          <ScrollArea
            className="w-full scrollbar-none"
            scrollBar="horizontal"
            viewportRef={scrollViewportRef}
          >
            <div
              data-context-tabs-scroll-content=""
              className="flex h-12 w-full items-center gap-1 px-0 no-drag"
              {...containerDragHandlers}
            >
              {renderSlots.map(slot => {
                if (slot.kind === 'group') {
                  const isGroupActive = Boolean(
                    activeTabKey &&
                      slot.group.panes.some(pane => pane.content?.tabKey === activeTabKey),
                  )
                  const reorderItem = resolveGroupReorderItem(
                    slot.group,
                    tabKeyToItem,
                    activeTabKey,
                  )
                  const reorderKey = reorderItem?.tabKey ?? null
                  return (
                    <GroupTab
                      key={slotReactKey(slot)}
                      group={slot.group}
                      isGroupActive={isGroupActive}
                      activeTabKey={activeTabKey}
                      registry={registry}
                      tabKeyToItem={tabKeyToItem}
                      innerRef={isGroupActive ? activeTabRef : undefined}
                      t={t}
                      onSetActivePane={setActivePane}
                      onActivateTabKey={activateTabKey}
                      onRestoreGroup={handleRestoreGroup}
                      onCloseItem={handleRequestClose}
                      onCloseOthersForGroup={onCloseOthersForGroup}
                      onCloseLeftForGroup={onCloseLeftForGroup}
                      onCloseRightForGroup={onCloseRightForGroup}
                      {...computeGroupSlotPosition(renderSlots, slot.group.id)}
                      getLabelForTabKey={getLabelForTabKey}
                      getIconForTabKey={getIconForTabKey}
                      reorderKey={reorderKey ?? `group:${slot.group.id}`}
                      isDragging={Boolean(reorderKey && draggedTabKey === reorderKey)}
                      reorderOffsetX={reorderKey ? reorderOffsetsByTabKey.get(reorderKey) ?? 0 : 0}
                      dragProps={
                        reorderItem && reorderKey
                          ? makeTabDragProps<HTMLDivElement>(
                              reorderKey,
                              reorderItem,
                              null,
                              { reorderOnly: true },
                            )
                          : undefined
                      }
                    />
                  )
                }
                const { item, isClosing: closing, isPhantom } = slot
                const isActive = activeTabKey === item.tabKey
                const dragPayload = registry.getDragPayload(item)
                return (
                  <NormalTab
                    key={slotReactKey(slot)}
                    item={item}
                    registry={registry}
                    isActive={isActive}
                    isClosing={closing}
                    isDragging={draggedTabKey === item.tabKey}
                    reorderOffsetX={reorderOffsetsByTabKey.get(item.tabKey) ?? 0}
                    innerRef={isActive && !isPhantom ? activeTabRef : undefined}
                    t={t}
                    onSelect={() => onSelectItem(item)}
                    onRequestClose={() => handleRequestClose(item)}
                    onMiddleClickClose={e => {
                      if (e.button !== 1) return
                      e.preventDefault()
                      e.stopPropagation()
                      handleRequestClose(item)
                    }}
                    onContextMenu={e => handleTabContextMenu(e, item)}
                    dragProps={makeTabDragProps<HTMLDivElement>(
                      item.tabKey,
                      item,
                      dragPayload,
                    )}
                  />
                )
              })}
            </div>
          </ScrollArea>
        </div>
      </div>
      {trailingSlot && (
        <div className={cn('flex h-12 shrink-0 items-center px-1', trailingSlotClassName)}>
          {trailingSlot}
        </div>
      )}
      <OverflowPopover
        overflowTabKeys={overflowTabKeys}
        activeTabKey={activeTabKey}
        groupLookup={groupLookup}
        tabKeyToItem={tabKeyToItem}
        tabKeyToGroup={tabKeyToGroup}
        t={t}
        getLabelForTabKey={getLabelForTabKey}
        getIconForTabKey={getIconForTabKey}
        isItemClosable={item => registry.isClosable(item)}
        onActivateTabKey={activateTabKey}
        onCloseItem={handleRequestClose}
      />
    </div>
  )
}

ContextTabs.displayName = 'ContextTabs'
