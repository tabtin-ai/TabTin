/**
 * Slot 序列计算——纯数据派生，不依赖 React 渲染态。
 *
 * 与 ContextTabs/index.tsx renderSlots 算法对齐：
 *   1. 按 tabOrder 顺序扫描，遇到属于 group 的 tabKey 时，该 group 仅出现一次
 *   2. canvas-only group（pane tabKey 不在 tabOrder 里）追加到末尾
 *
 * 用于 useCloseHandlers 的 group 版 closeLeft/closeRight/closeOthers，
 * 以及 GroupTab 菜单 enabled 状态判断。
 */
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import type { ContextTabKey } from '../registry/types'

export type Slot =
  | { kind: 'item'; tabKey: string }
  | { kind: 'group'; groupId: string; tabKeys: string[] }

/**
 * 从 tab 顺序 + group 信息计算视觉 slot 序列。
 *
 * @param tabOrder       当前 space 的 currentTabKeys（已排序的完整列表）
 * @param groupedTabKeys 属于任意 group 的 tabKey 集合
 * @param canvasGroups   当前 space 的 canvas groups
 */
export function computeSlotsFromTabOrder(params: {
  tabOrder: readonly string[]
  groupedTabKeys: ReadonlySet<string>
  canvasGroups: readonly CanvasLayoutGroup[]
}): Slot[] {
  const { tabOrder, groupedTabKeys, canvasGroups } = params
  const slots: Slot[] = []
  const renderedGroups = new Set<string>()

  const groupByTabKey = new Map<string, CanvasLayoutGroup>()
  for (const group of canvasGroups) {
    for (const pane of group.panes) {
      if (pane.content?.tabKey) {
        groupByTabKey.set(pane.content.tabKey, group)
      }
    }
  }

  for (const tabKey of tabOrder) {
    if (groupedTabKeys.has(tabKey)) {
      const group = groupByTabKey.get(tabKey)
      if (group && !renderedGroups.has(group.id)) {
        renderedGroups.add(group.id)
        const tabKeys = group.panes
          .map(p => p.content?.tabKey)
          .filter((k): k is ContextTabKey => k != null)
        slots.push({ kind: 'group', groupId: group.id, tabKeys })
      }
    } else {
      slots.push({ kind: 'item', tabKey })
    }
  }

  for (const group of canvasGroups) {
    if (!renderedGroups.has(group.id)) {
      renderedGroups.add(group.id)
      const tabKeys = group.panes
        .map(p => p.content?.tabKey)
        .filter((k): k is ContextTabKey => k != null)
      slots.push({ kind: 'group', groupId: group.id, tabKeys })
    }
  }

  return slots
}

/**
 * 收集 slot 内所有 tabKeys。
 */
export function collectTabKeysFromSlots(slots: readonly Slot[]): string[] {
  return slots.flatMap(s => (s.kind === 'item' ? [s.tabKey] : s.tabKeys))
}
