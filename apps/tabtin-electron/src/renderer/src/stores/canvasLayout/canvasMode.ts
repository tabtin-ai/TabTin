/**
 * Canvas-mode 跨 store 派生逻辑（纯函数 selector）。
 *
 * 输入两个 store 的快照引用：
 *   - `useCanvasLayoutStore.spaceGroups` —— 该 Space 全部 canvas group
 *   - `useSpaceContextTabsStore.activeKeyBySpace` —— 该 Space 当前 active tab key
 *
 * 输出：当前 Space 是否处于 canvas mode（即 PersistentCanvasGroups 接管显示，
 * CrawlspaceWorkspace 子树应该 hidden 以释放 effect）。
 *
 * ---
 *
 * **为什么是跨 store 派生而不是 store 内字段**
 *
 * canvas-mode 的判定本质是"该 Space 当前 active tab 是否落在某个 group 的 pane 内"——
 * activeTabKey 写在 contextTabs store，groups 写在 canvasLayout store；任何一边持有
 * 字段都得反向订阅另一边，会引入双向耦合。所以提到上层做无状态派生：每次 SpaceWorkbenchHost
 * 渲染时按 spaceId 各算一次，开销 O(group 数 × pane 数) << 5×3。
 *
 * **与 SpaceContextArea 内 `shouldShowCanvasGroup` 的差异**
 *
 * SpaceContextArea 计算的 `shouldShowCanvasGroup` 多一个 `activeTabType !== 'home'`
 * 的兜底（当 App 被禁用时，useActiveKeyGuard 会把 activeTabType 强制改成 'home'）。
 * 这里没有 isAppEnabled 信号——但 App 禁用本身已经让 CrawlspaceWorkspace 在
 * SpaceContextArea 走 `showDesktopBlankFallback` 分支视觉让位，本 selector 哪怕误判
 * isCanvasMode=true（让 CrawlspaceWorkspace 子树 hidden）也不会影响用户感知，反而
 * 提前释放 effect。所以这个差异是安全偏向 cleanup 的。
 *
 * **home tab 的处理**
 *
 * home 类型 tab（首页）不会出现在 canvas group 里，但稳妥起见这里仍显式过滤：
 * 任何 type 为 'home' 的 activeTabKey 一律 isCanvasMode=false。
 */

import { parseTabKey } from '@/stores/contextTabs/helpers'
import { EMPTY_CANVAS_GROUPS, findGroupForTabKey } from './helpers'
import type { CanvasLayoutGroup } from './types'

// 派生：该 Space 当前是否处于 canvas mode（即 isCanvasMode）。
// 调用方 `SpaceWorkbenchHost` 用它驱动内层 Activity 的 hidden 切换，
// 让 `CrawlspaceWorkspace` 子树 effect cleanup。
export const selectIsCanvasModeForSpace = (
  spaceGroupsBySpace: Record<string, CanvasLayoutGroup[]>,
  activeKeyBySpace: Record<string, string | null>,
  spaceId: string,
): boolean => {
  const activeTabKey = activeKeyBySpace[spaceId]
  if (!activeTabKey) return false

  const parsed = parseTabKey(activeTabKey)
  if (!parsed || parsed.type === 'home') return false

  const groups = spaceGroupsBySpace[spaceId] ?? EMPTY_CANVAS_GROUPS
  if (groups.length === 0) return false

  return Boolean(findGroupForTabKey(groups, activeTabKey))
}
