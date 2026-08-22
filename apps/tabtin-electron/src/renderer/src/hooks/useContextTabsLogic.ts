import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useCanvasLayoutStore, type CanvasLayoutGroup, type CanvasLayoutNode } from '@stores/useCanvasLayoutStore'
import type { ContextItem, ContextRegistry } from '@components/context-space/registry'
import { openNativeContextMenu, menuSeparator, type NativeMenuItem } from '@/utils/nativeMenu'
import { useTranslation } from 'react-i18next'
import { useClosedTabsStore } from '@stores/useClosedTabsStore'
import { addContextItemToChat } from '@components/context-space/hooks/addContextItemToChat'

export function flattenLayout(node: CanvasLayoutNode): string[] {
  if (node.type === 'leaf') return [node.paneId]
  return node.children.flatMap(child => flattenLayout(child))
}

export interface BaseContextTabsProps {
  activeTabKey: string | null
  isHomeActive: boolean
  showHome?: boolean
  /** 仅剩工作台时显示关闭；关闭语义由 onCloseHome 决定（通常切对话聚焦） */
  homeClosable?: boolean
  allItems?: ContextItem[]
  items: ContextItem[]
  registry: ContextRegistry
  onSelectHome: () => void
  onCloseHome?: () => void
  onSelectItem: (item: ContextItem) => void
  onCloseItem: (item: ContextItem) => void
  onRefreshItem?: (item: ContextItem) => void
  onCloseOtherItems?: (item: ContextItem) => void
  onCloseLeftItems?: (item: ContextItem) => void
  onCloseRightItems?: (item: ContextItem) => void
  onCloseOthersForGroup?: (group: CanvasLayoutGroup) => void
  onCloseLeftForGroup?: (group: CanvasLayoutGroup) => void
  onCloseRightForGroup?: (group: CanvasLayoutGroup) => void
  onCreateWebTab?: () => void
  onReopenClosedTab?: () => void
  onReorderItem?: (dragged: ContextItem, target: ContextItem, position: 'before' | 'after') => void
  onRestoreGroup?: (group: CanvasLayoutGroup) => void
  groupedTabKeys?: Set<string>
  canvasGroups?: CanvasLayoutGroup[]
}

export type UseContextTabsLogicParams = Pick<
  BaseContextTabsProps,
  | 'items' | 'registry' | 'groupedTabKeys' | 'canvasGroups'
  | 'allItems'
  | 'onSelectHome' | 'onSelectItem' | 'onCloseItem' | 'onRefreshItem'
  | 'onCloseOtherItems' | 'onCloseLeftItems' | 'onCloseRightItems'
  | 'onCreateWebTab' | 'onReopenClosedTab' | 'onRestoreGroup'
>

export function useContextTabsLogic({
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
}: UseContextTabsLogicParams) {
  const { t } = useTranslation('context')
  const setActivePane = useCanvasLayoutStore(state => state.setActivePane)
  const removeGroup = useCanvasLayoutStore(state => state.removeGroup)

  const lookupItems = allItems ?? items
  const tabKeyToItem = useMemo(() => {
    const map = new Map<string, ContextItem>()
    lookupItems.forEach(item => map.set(item.tabKey, item))
    return map
  }, [lookupItems])

  const visibleItems = useMemo(() => {
    if (!groupedTabKeys || groupedTabKeys.size === 0) return items
    return items.filter(item => !groupedTabKeys.has(item.tabKey))
  }, [groupedTabKeys, items])

  const getLabelForTabKey = useCallback((tabKey: string | null) => {
    if (!tabKey) return t('tab.group')
    const item = tabKeyToItem.get(tabKey)
    if (item) return registry.getTabLabel(item)
    const parsed = registry.parseTabKey(tabKey)
    if (!parsed) return t('tab.group')
    const handler = registry.getHandler(parsed.type)
    return handler?.displayLabel || t('tab.group')
  }, [registry, t, tabKeyToItem])

  const getIconForTabKey = useCallback((tabKey: string | null) => {
    if (!tabKey) return null
    const item = tabKeyToItem.get(tabKey)
    if (item) return registry.getTabIcon(item)
    const parsed = registry.parseTabKey(tabKey)
    if (!parsed) return null
    const safeTabKey = registry.buildTabKey(parsed.type, parsed.id)
    return registry.getTabIcon({ type: parsed.type, id: parsed.id, tabKey: safeTabKey })
  }, [registry, tabKeyToItem])

  const menuCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => {
    return () => { menuCleanupRef.current?.() }
  }, [])

  const handleAddToChat = useCallback((item: ContextItem) => {
    addContextItemToChat(item, registry, t)
  }, [registry, t])

  const handleTabContextMenu = useCallback((e: React.MouseEvent, item: ContextItem) => {
    e.preventDefault()
    e.stopPropagation()
    menuCleanupRef.current?.()

    const visibleIndex = visibleItems.findIndex(tab => tab.tabKey === item.tabKey)
    const hasLeft = visibleIndex > 0
    const hasRight = visibleIndex !== -1 && visibleIndex < visibleItems.length - 1
    const hasOthers = visibleIndex !== -1 && visibleItems.length > 1

    const hasClosedTabs = useClosedTabsStore.getState().stack.length > 0
    /**
     * 不可关闭的虚拟 tab（如对话画板）：
     *   - "关闭"按钮直接 disable（视觉提示用户：这是一个常驻视图）
     *   - "关闭左/右/其他"按钮仍然可用 —— 它们关掉的是其它真实 tab，
     *     而画板自己 tabKey 不在 useTabSync 的 visibleTabKeys / currentTabKeys 里，
     *     不会被 batchClose 误带走。语义上"右键画板 → 关闭其他真实 tab"是合理的清理操作。
     */
    const isItemClosable = registry.isClosable(item)
    const canAttachToChat = registry.canAttachToChat(item.type)

    const menuItems: NativeMenuItem[] = [
      {
        id: 'new-web-tab',
        label: t('tab.menu.newWebTab'),
        accelerator: 'CmdOrCtrl+T',
        enabled: Boolean(onCreateWebTab),
        onClick: () => onCreateWebTab?.()
      },
      {
        id: 'reopen-closed-tab',
        label: t('tab.menu.reopenClosedTab'),
        accelerator: 'CmdOrCtrl+Shift+T',
        enabled: hasClosedTabs && Boolean(onReopenClosedTab),
        onClick: () => onReopenClosedTab?.()
      },
      menuSeparator(),
      {
        id: 'add-to-chat',
        label: t('tab.menu.addToChat', { defaultValue: '添加到对话' }),
        enabled: canAttachToChat,
        onClick: () => handleAddToChat(item),
      },
      menuSeparator(),
      {
        id: 'refresh',
        label: t('tab.menu.refresh'),
        accelerator: 'CmdOrCtrl+R',
        enabled: Boolean(onRefreshItem),
        onClick: () => onRefreshItem?.(item)
      },
      {
        id: 'close',
        label: t('tab.menu.close'),
        accelerator: 'CmdOrCtrl+W',
        enabled: isItemClosable,
        onClick: () => onCloseItem(item)
      },
      menuSeparator(),
      {
        id: 'close-others',
        label: t('tab.menu.closeOthers'),
        enabled: Boolean(onCloseOtherItems) && hasOthers,
        onClick: () => onCloseOtherItems?.(item)
      },
      {
        id: 'close-left',
        label: t('tab.menu.closeLeft'),
        enabled: Boolean(onCloseLeftItems) && hasLeft,
        onClick: () => onCloseLeftItems?.(item)
      },
      {
        id: 'close-right',
        label: t('tab.menu.closeRight'),
        enabled: Boolean(onCloseRightItems) && hasRight,
        onClick: () => onCloseRightItems?.(item)
      }
    ]

    menuCleanupRef.current = openNativeContextMenu(menuItems, e.clientX, e.clientY)
  }, [onCloseItem, onCloseLeftItems, onCloseOtherItems, onCloseRightItems, onCreateWebTab, onReopenClosedTab, onRefreshItem, registry, t, visibleItems, handleAddToChat])

  const activateTabKey = useCallback((tabKey: string | null) => {
    if (!tabKey) {
      onSelectHome()
      return
    }
    const item = tabKeyToItem.get(tabKey)
    if (item) onSelectItem(item)
  }, [onSelectHome, onSelectItem, tabKeyToItem])

  const handleRestoreGroup = useCallback((group: CanvasLayoutGroup) => {
    if (onRestoreGroup) {
      onRestoreGroup(group)
    } else {
      removeGroup(group.spaceId, group.id)
    }
  }, [onRestoreGroup, removeGroup])

  const groupLookup = useMemo(() => {
    const map = new Map<string, CanvasLayoutGroup>()
    canvasGroups?.forEach(group => map.set(group.id, group))
    return map
  }, [canvasGroups])

  const tabKeyToGroup = useMemo(() => {
    const map = new Map<string, CanvasLayoutGroup>()
    canvasGroups?.forEach(group => {
      group.panes.forEach(pane => {
        if (pane.content?.tabKey && !map.has(pane.content.tabKey)) {
          map.set(pane.content.tabKey, group)
        }
      })
    })
    return map
  }, [canvasGroups])

  return {
    t,
    tabKeyToItem,
    visibleItems,
    getLabelForTabKey,
    getIconForTabKey,
    handleTabContextMenu,
    activateTabKey,
    handleRestoreGroup,
    groupLookup,
    tabKeyToGroup,
    setActivePane,
  }
}
