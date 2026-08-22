/**
 * 关闭 tab 时 activeKey 的统一 fallback 计算。
 * UI 侧（useCloseHandlers）和 Tool 侧（ContextSpaceToolHandler）共用，
 * 确保用户手动关闭和 Agent 通过 MCP 工具关闭的跳转体验一致。
 *
 * 策略（按优先级）：
 *   1. 如果 closingTab 属于某个 canvas group，选同 group 里 activePaneId 指向的 pane，
 *      没有则选 remaining[0]（group 即将只剩它时 → 退化到 2）
 *   2. 在 visibleTabKeys（tab 条上可点击的列表）里选右邻居，其次左邻居
 *   3. closingTab 在 group 内且 visible 里没它 → 从完整 tabOrder 中找最近的 visible tab
 *   4. 最后兜底：任意 visible tab；都没有返回 null（回到 home）
 */
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { findGroupForTabKey } from './canvasLayout'

export interface ComputeFallbackParams {
  closingTabKey: string
  /** tab 条上可见的 tab key 列表（不含 group 内的子 pane，group 整体仍算 visible） */
  visibleTabKeys: readonly string[]
  /** 完整 tabOrder，可能包含 group 内的 tab */
  tabOrder: readonly string[]
  /** 该 space 的全部 canvas 分组 */
  spaceGroups: readonly CanvasLayoutGroup[]
}

export function computeFallbackTabKey({
  closingTabKey,
  visibleTabKeys,
  tabOrder,
  spaceGroups,
}: ComputeFallbackParams): string | null {
  // 1) canvas group survivor
  const group = findGroupForTabKey(spaceGroups, closingTabKey)
  if (group) {
    const pane = group.panes.find(p => p.content?.tabKey === closingTabKey)
    const remaining = group.panes.filter(p => p.id !== pane?.id && p.content?.tabKey)
    const preferred = remaining.find(p => p.id === group.activePaneId) ?? remaining[0]
    const survivor = preferred?.content?.tabKey
    if (survivor && survivor !== closingTabKey) return survivor
  }

  // 2) visible 邻居：右侧优先（关闭后往右滑的直觉），其次左侧
  const visibleIdx = visibleTabKeys.indexOf(closingTabKey)
  if (visibleIdx !== -1) {
    const right = visibleTabKeys[visibleIdx + 1]
    if (right && right !== closingTabKey) return right
    const left = visibleTabKeys[visibleIdx - 1]
    if (left && left !== closingTabKey) return left
  }

  // 3) closing 在 group 内（visible 里没它）→ 从完整 tabOrder 中找最近的 visible
  const visibleSet = new Set(visibleTabKeys)
  const orderIdx = tabOrder.indexOf(closingTabKey)
  if (orderIdx !== -1) {
    for (let i = orderIdx + 1; i < tabOrder.length; i += 1) {
      const candidate = tabOrder[i]
      if (candidate !== closingTabKey && visibleSet.has(candidate)) return candidate
    }
    for (let i = orderIdx - 1; i >= 0; i -= 1) {
      const candidate = tabOrder[i]
      if (candidate !== closingTabKey && visibleSet.has(candidate)) return candidate
    }
  }

  // 4) 兜底：任意 visible tab，都没有返回 null
  return visibleTabKeys.find(k => k !== closingTabKey) ?? null
}

/**
 * Tool 侧便捷调用：只传 tabOrder + spaceGroups，内部计算 groupedTabKeys。
 */
export function computeFallbackTabKeyFromStore(params: {
  closingTabKey: string
  tabOrder: readonly string[]
  spaceGroups: readonly CanvasLayoutGroup[]
}): string | null {
  const { closingTabKey, tabOrder, spaceGroups } = params
  const groupedTabKeys = new Set<string>()
  spaceGroups.forEach(group => {
    group.panes.forEach(pane => {
      if (pane.content?.tabKey) groupedTabKeys.add(pane.content.tabKey)
    })
  })
  const visibleTabKeys = tabOrder.filter(key => !groupedTabKeys.has(key))
  return computeFallbackTabKey({ closingTabKey, visibleTabKeys, tabOrder, spaceGroups })
}
